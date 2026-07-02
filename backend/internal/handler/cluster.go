package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"omnikube/internal/cluster"
	"omnikube/internal/model"
	"omnikube/internal/notify"
)

type createClusterReq struct {
	ID         string `json:"id" binding:"required"`
	Name       string `json:"name" binding:"required"`
	Kubeconfig string `json:"kubeconfig" binding:"required"`
}

// clusterView 是列表/详情的安全视图，绝不包含 kubeconfig 密文。
type clusterView struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Status    string           `json:"status"`
	LastCheck string           `json:"last_check"`
	Webhooks  []notify.Webhook `json:"webhooks"` // 发布通知机器人配置
}

func toView(c model.Cluster) clusterView {
	lc := ""
	if !c.LastCheck.IsZero() {
		lc = c.LastCheck.Format("2006-01-02T15:04:05Z07:00")
	}
	hooks := notify.ParseWebhooks(c.Webhooks)
	if hooks == nil {
		hooks = []notify.Webhook{}
	}
	return clusterView{ID: c.ID, Name: c.Name, Status: c.Status, LastCheck: lc, Webhooks: hooks}
}

// CreateCluster POST /api/v1/clusters
func (h *Handler) CreateCluster(c *gin.Context) {
	var req createClusterReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	err := h.Pool.AddCluster(req.ID, req.Name, req.Kubeconfig)
	if err != nil {
		switch {
		case errors.Is(err, cluster.ErrDuplicateID):
			c.JSON(http.StatusConflict, gin.H{"code": 409, "message": "集群标识已存在"})
		default:
			c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "添加成功"})
}

// ListClusters GET /api/v1/clusters
func (h *Handler) ListClusters(c *gin.Context) {
	var clusters []model.Cluster
	if err := h.DB.Order("created_at asc").Find(&clusters).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	views := make([]clusterView, 0, len(clusters))
	for _, cl := range clusters {
		views = append(views, toView(cl))
	}
	c.JSON(http.StatusOK, gin.H{"clusters": views})
}

// MyClusters GET /api/v1/my/clusters — 当前用户可访问的集群（驱动顶栏集群下拉）。
// 管理员返回全部；普通用户按其角色规则的 cluster_id（含 "*"=全部）过滤。
func (h *Handler) MyClusters(c *gin.Context) {
	userID := c.MustGet("user_id").(uint)
	isAdmin := c.GetBool("is_admin")

	var clusters []model.Cluster
	if err := h.DB.Order("created_at asc").Find(&clusters).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}

	if !isAdmin {
		all, ids, err := h.RBAC.AccessibleClusterIDs(userID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
			return
		}
		if !all {
			allowed := make(map[string]bool, len(ids))
			for _, id := range ids {
				allowed[id] = true
			}
			filtered := make([]model.Cluster, 0, len(clusters))
			for _, cl := range clusters {
				if allowed[cl.ID] {
					filtered = append(filtered, cl)
				}
			}
			clusters = filtered
		}
	}

	views := make([]clusterView, 0, len(clusters))
	for _, cl := range clusters {
		views = append(views, toView(cl))
	}
	c.JSON(http.StatusOK, gin.H{"clusters": views})
}

// DeleteCluster DELETE /api/v1/clusters/:id
func (h *Handler) DeleteCluster(c *gin.Context) {
	id := c.Param("id")
	if err := h.Pool.DeleteCluster(id); err != nil {
		if errors.Is(err, cluster.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "集群不存在"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	// 集群行删除事务已提交，此处再级联清理 role_rules 并重物化受影响用户（子项目 G）。
	if h.RBAC != nil {
		if err := h.RBAC.OnClusterDeleted(id); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "权限级联同步失败"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "删除成功"})
}

type updateClusterReq struct {
	Name       string            `json:"name"`
	Kubeconfig string            `json:"kubeconfig"`
	Webhooks   *[]notify.Webhook `json:"webhooks"` // nil=不改；提供则整表覆盖
}

// UpdateCluster PUT /api/v1/clusters/:id
func (h *Handler) UpdateCluster(c *gin.Context) {
	id := c.Param("id")
	var req updateClusterReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	if req.Name == "" && req.Kubeconfig == "" && req.Webhooks == nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无更新内容"})
		return
	}
	// name / kubeconfig 经 Pool 更新（会重连测试并刷新客户端）。
	if req.Name != "" || req.Kubeconfig != "" {
		if err := h.Pool.UpdateCluster(id, req.Name, req.Kubeconfig); err != nil {
			switch {
			case errors.Is(err, cluster.ErrNotFound):
				c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "集群不存在"})
			default:
				c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": err.Error()})
			}
			return
		}
	}
	// webhooks 只是元数据, 直接更新（校验 type 合法）。
	if req.Webhooks != nil {
		clean := make([]notify.Webhook, 0, len(*req.Webhooks))
		for _, w := range *req.Webhooks {
			if w.URL == "" {
				continue
			}
			switch w.Type {
			case notify.TypeDingTalk, notify.TypeFeishu, notify.TypeWeCom:
				clean = append(clean, w)
			}
		}
		blob, _ := json.Marshal(clean)
		res := h.DB.Model(&model.Cluster{}).Where("id = ?", id).Update("webhooks", string(blob))
		if res.Error != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
			return
		}
		if res.RowsAffected == 0 && req.Name == "" && req.Kubeconfig == "" {
			c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "集群不存在"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "更新成功"})
}

type testClusterReq struct {
	Kubeconfig string `json:"kubeconfig" binding:"required"`
}

// TestCluster POST /api/v1/clusters/test —— 仅 build+Ping，不落库。
func (h *Handler) TestCluster(c *gin.Context) {
	var req testClusterReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	if err := h.Pool.TestConnection(req.Kubeconfig); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "连接成功"})
}
