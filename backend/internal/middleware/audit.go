package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"omnikube/internal/audit"
)

// specialActions 把「非 CRUD」端点的末段路径映射为审计动作名。
// 命中则用该动词, 否则回退 HTTP 方法映射（create/update/delete）。
var specialActions = map[string]string{
	"scale":           "scale",
	"restart":         "restart",
	"rollback":        "rollback",
	"trigger":         "trigger",
	"reset-password":  "reset-password",
	"disable":         "disable",
	"enable":          "enable",
	"roles":           "set-roles",
	"test":            "test",
	"change-password": "change-password",
}

// Audit 在 authed 链尾对写操作(POST/PUT/DELETE)自动落审计。
// 必须挂在 JWTAuth 之后(依赖 user_id)。读操作与 reveal(已有专门审计)跳过。
func Audit(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()

		switch c.Request.Method {
		case "POST", "PUT", "DELETE":
		default:
			return
		}
		action := deriveAction(c)
		if action == "reveal" {
			return // reveal 已在 handler 内做 allow/deny 审计, 避免重复。
		}
		resource := c.Param("resource")
		if resource == "" {
			resource = firstSeg(c.FullPath())
		}
		target := c.Param("name")
		if target == "" {
			target = c.Param("id")
		}
		ns := c.Param("namespace")
		if ns == "" {
			ns = c.GetString("auth_namespace")
		}
		audit.Log(db, audit.Entry{
			UserID:    uidStr(c),
			ClusterID: c.GetHeader("X-Cluster-ID"),
			Namespace: ns,
			Resource:  resource,
			Action:    action,
			Target:    target,
			Result:    resultOf(c.Writer.Status()),
			SourceIP:  c.ClientIP(),
		})
	}
}

// deriveAction 先按末段特殊动词覆盖, 否则按方法映射。
func deriveAction(c *gin.Context) string {
	last := lastSeg(c.FullPath())
	if a, ok := specialActions[last]; ok {
		return a
	}
	// reveal 端点末段是 :name(通配), 用实际路径判定。
	if strings.HasSuffix(c.Request.URL.Path, "/reveal") {
		return "reveal"
	}
	switch c.Request.Method {
	case "POST":
		return "create"
	case "PUT":
		return "update"
	case "DELETE":
		return "delete"
	}
	return c.Request.Method
}

// resultOf 把 HTTP 状态码映射为审计结果。
func resultOf(status int) string {
	switch {
	case status >= 200 && status < 300:
		return "success"
	case status == 403:
		return "denied"
	default:
		return "failed"
	}
}

func lastSeg(fullPath string) string {
	parts := strings.Split(strings.Trim(fullPath, "/"), "/")
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

// firstSeg 取 /api/v1/ 之后的首段(users/roles/clusters/...)作为资源分组回退。
func firstSeg(fullPath string) string {
	rest := strings.TrimPrefix(fullPath, "/api/v1/")
	parts := strings.Split(rest, "/")
	if len(parts) > 0 {
		return parts[0]
	}
	return ""
}

func uidStr(c *gin.Context) string {
	if v, ok := c.Get("user_id"); ok {
		if id, ok := v.(uint); ok && id != 0 {
			return itoa(id)
		}
	}
	return ""
}

func itoa(u uint) string {
	if u == 0 {
		return "0"
	}
	buf := [20]byte{}
	i := len(buf)
	for u > 0 {
		i--
		buf[i] = byte('0' + u%10)
		u /= 10
	}
	return string(buf[i:])
}
