package handler

import (
	"encoding/csv"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"omnikube/internal/model"
)

// auditView 是审计记录的 JSON 视图(snake_case, 与前端约定一致)。
type auditView struct {
	ID        uint   `json:"id"`
	UserID    string `json:"user_id"`
	Username  string `json:"username"` // 操作者用户名(按 user_id 解析, 缺失为空)
	ClusterID string `json:"cluster_id"`
	Namespace string `json:"namespace"`
	Resource  string `json:"resource"`
	Action    string `json:"action"`
	Target    string `json:"target"`
	Result    string `json:"result"`
	SourceIP  string `json:"source_ip"`
	CreatedAt string `json:"created_at"`
}

func toAuditView(a model.AuditLog) auditView {
	return auditView{
		ID: a.ID, UserID: a.UserID, ClusterID: a.ClusterID, Namespace: a.Namespace,
		Resource: a.Resource, Action: a.Action, Target: a.Target, Result: a.Result,
		SourceIP: a.SourceIP, CreatedAt: a.CreatedAt.Format(time.RFC3339),
	}
}

// resolveUsernames 批量把 user_id 解析为用户名(一次查询)。
func (h *Handler) resolveUsernames(ids []string) map[string]string {
	out := map[string]string{}
	uniq := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		if id != "" && !seen[id] {
			seen[id] = true
			uniq = append(uniq, id)
		}
	}
	if len(uniq) == 0 {
		return out
	}
	var users []model.User
	h.DB.Select("id", "username").Where("id IN ?", uniq).Find(&users)
	for _, u := range users {
		out[strconv.FormatUint(uint64(u.ID), 10)] = u.Username
	}
	return out
}

// auditFilter 按 query 参数构造过滤后的 *gorm.DB(不含分页/排序)。
func auditFilter(db *gorm.DB, c *gin.Context) *gorm.DB {
	q := db.Model(&model.AuditLog{})
	if v := c.Query("user_id"); v != "" {
		q = q.Where("user_id = ?", v)
	}
	if v := c.Query("action"); v != "" {
		q = q.Where("action = ?", v)
	}
	if v := c.Query("resource"); v != "" {
		q = q.Where("resource = ?", v)
	}
	if v := c.Query("cluster_id"); v != "" {
		q = q.Where("cluster_id = ?", v)
	}
	if v := c.Query("namespace"); v != "" {
		q = q.Where("namespace = ?", v)
	}
	if v := c.Query("result"); v != "" {
		q = q.Where("result = ?", v)
	}
	if v := c.Query("from"); v != "" {
		if ts, err := time.Parse(time.RFC3339, v); err == nil {
			q = q.Where("created_at >= ?", ts)
		}
	}
	if v := c.Query("to"); v != "" {
		if ts, err := time.Parse(time.RFC3339, v); err == nil {
			q = q.Where("created_at <= ?", ts)
		}
	}
	return q
}

// ListAuditLogs GET /api/v1/audit-logs —— 审计日志分页查询(时间倒序)。
// 鉴权：路由层 RequireGlobalPerm("audit","view")；admin 旁路。
func (h *Handler) ListAuditLogs(c *gin.Context) {
	var total int64
	auditFilter(h.DB, c).Count(&total)

	limit := 50
	if l := c.Query("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 500 {
			limit = n
		}
	}
	offset := 0
	if o := c.Query("offset"); o != "" {
		if n, err := strconv.Atoi(o); err == nil && n >= 0 {
			offset = n
		}
	}

	rows := []model.AuditLog{}
	auditFilter(h.DB, c).Order("created_at desc").Limit(limit).Offset(offset).Find(&rows)
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.UserID)
	}
	names := h.resolveUsernames(ids)
	views := make([]auditView, 0, len(rows))
	for _, r := range rows {
		v := toAuditView(r)
		v.Username = names[r.UserID]
		views = append(views, v)
	}
	c.JSON(http.StatusOK, gin.H{"logs": views, "total": total})
}

// ExportAuditLogs GET /api/v1/audit-logs/export —— 同过滤条件流式导出 CSV(忽略分页)。
func (h *Handler) ExportAuditLogs(c *gin.Context) {
	rows := []model.AuditLog{}
	auditFilter(h.DB, c).Order("created_at desc").Limit(10000).Find(&rows)
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.UserID)
	}
	names := h.resolveUsernames(ids)

	c.Header("Content-Type", "text/csv; charset=utf-8")
	c.Header("Content-Disposition", "attachment; filename=audit-"+time.Now().Format("20060102")+".csv")
	// UTF-8 BOM, 便于 Excel 正确识别中文。
	c.Writer.WriteString("\xEF\xBB\xBF")

	cw := csv.NewWriter(c.Writer)
	_ = cw.Write([]string{"time", "user_id", "username", "action", "result", "cluster_id", "namespace", "resource", "target", "source_ip"})
	for _, r := range rows {
		_ = cw.Write([]string{
			r.CreatedAt.Format(time.RFC3339), r.UserID, names[r.UserID], r.Action, r.Result,
			r.ClusterID, r.Namespace, r.Resource, r.Target, r.SourceIP,
		})
	}
	cw.Flush()
}
