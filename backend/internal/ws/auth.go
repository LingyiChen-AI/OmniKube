// Package ws 实现两条 WebSocket 流：WebSSH（exec）与实时日志流。
//
// 两个端点都不挂常规 Header 中间件（浏览器原生 WebSocket 无法自定义 Header），
// 而是在 Upgrade 之前从 query 参数完成鉴权（PRD §8）。token 仅用于校验身份，
// 绝不写入日志/审计——审计只记数值型 userID。
package ws

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"omnikube/internal/audit"
	"omnikube/internal/auth"
	"omnikube/internal/cluster"
	"omnikube/internal/rbac"
)

// Handler 持有 WebSocket 流所需依赖，复用与 handler.Handler 相同的注入。
type Handler struct {
	DB   *gorm.DB
	JWT  *auth.JWTManager
	Pool *cluster.ClusterPool
	RBAC *rbac.Service
}

// authContext 是升级前鉴权门的产物，供 exec/logs handler 复用。
type authContext struct {
	UserID    string // 数值型 userID 字符串（strconv.FormatUint），与 C/D 一致。
	ClusterID string
	Namespace string
	Pod       string
	Container string
	Client    *cluster.ClusterClient
	SourceIP  string
}

// authorizeWS 是 exec/logs 共用的升级前鉴权门（PRD §8）。
//
// 顺序：解析 query → 缺必填参数(cluster_id/pod/token) 400 → JWT.Parse 失败 401 →
// cluster_id 不在池 400 → rbac.Authorize(资源 "pods", action) 不通过（且非系统 admin）
// 403 + 写 deny 审计。全部通过返回 (*authContext, true)；任一不过写好 HTTP 状态码
// 并返回 (nil, false)，调用方据此直接 return（绝不 Upgrade）。
//
// token 绝不出现在任何日志或审计字段中。
func (h *Handler) authorizeWS(c *gin.Context, action string) (*authContext, bool) {
	clusterID := c.Query("cluster_id")
	pod := c.Query("pod")
	token := c.Query("token")
	namespace := c.Query("namespace")
	container := c.Query("container")

	// 1. 必填参数校验。
	if clusterID == "" || pod == "" || token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "缺少必填参数 cluster_id/pod/token"})
		return nil, false
	}

	// 2. 解析 token（仅校验身份，绝不外泄）。
	claims, err := h.JWT.Parse(token)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "无效或过期的令牌"})
		return nil, false
	}
	uid := claims.UserID
	sid := strconv.FormatUint(uint64(uid), 10)
	sourceIP := c.ClientIP()

	// 3. 集群必须在连接池中。
	cc, ok := h.Pool.Get(clusterID)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 cluster_id"})
		return nil, false
	}

	// 4. 鉴权（系统 admin 旁路）。
	if !claims.IsAdmin {
		allowed, _, err := h.RBAC.Authorize(sid, clusterID, namespace, "pods", action)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "鉴权失败"})
			return nil, false
		}
		if !allowed {
			audit.Log(h.DB, audit.Entry{
				UserID:    sid,
				ClusterID: clusterID,
				Namespace: namespace,
				Resource:  "pods",
				Action:    action,
				Target:    podTarget(pod, container),
				Result:    "deny",
				SourceIP:  sourceIP,
			})
			c.JSON(http.StatusForbidden, gin.H{"code": 403, "message": "无权访问"})
			return nil, false
		}
	}

	return &authContext{
		UserID:    sid,
		ClusterID: clusterID,
		Namespace: namespace,
		Pod:       pod,
		Container: container,
		Client:    cc,
		SourceIP:  sourceIP,
	}, true
}

// podTarget 构造审计 target：有 container 时为 pod/<pod>/<container>，否则 pod/<pod>。
func podTarget(pod, container string) string {
	if container != "" {
		return "pod/" + pod + "/" + container
	}
	return "pod/" + pod
}
