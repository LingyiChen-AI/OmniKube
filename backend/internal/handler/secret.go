package handler

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"omnikube/internal/audit"
)

// RevealSecret POST /api/v1/namespaces/:namespace/resources/:resource/:name/reveal
//
// Secret 揭示是独立动作（PRD 修复 #3）：
//   - 显式以 action="reveal" 调 rbac.Authorize（不走通用 write 映射）；系统 admin 旁路。
//   - 每次揭示强制落审计：放行记 allow，拒绝记 deny。
//   - 通过后取 Secret 对 .Data 解码（typed client 已自动 base64 解码）返回明文。
//
// 该路由不经通用 RBACAuthMiddleware，自行校验 X-Cluster-ID 与鉴权。
func (h *Handler) RevealSecret(c *gin.Context) {
	clusterID := c.GetHeader("X-Cluster-ID")
	cc, ok := h.Pool.Get(clusterID)
	if clusterID == "" || !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "缺少或无效的 X-Cluster-ID"})
		return
	}
	// reveal 仅适用于 secrets。
	if strings.ToLower(c.Param("resource")) != "secrets" {
		c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "不支持的揭示资源"})
		return
	}

	ns := c.Param("namespace")
	name := c.Param("name")
	uid := c.GetUint("user_id")
	sid := strconv.FormatUint(uint64(uid), 10)
	target := "secret/" + name

	// 鉴权（系统 admin 旁路）。
	if !c.GetBool("is_admin") {
		allowed, _, err := h.RBAC.Authorize(sid, clusterID, ns, "secrets", "reveal")
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "鉴权失败"})
			return
		}
		if !allowed {
			audit.Log(h.DB, audit.Entry{
				UserID:    sid,
				ClusterID: clusterID,
				Namespace: ns,
				Resource:  "secrets",
				Action:    "reveal",
				Target:    target,
				Result:    "deny",
				SourceIP:  c.ClientIP(),
			})
			c.JSON(http.StatusForbidden, gin.H{"code": 403, "message": "无权揭示该 Secret"})
			return
		}
	}

	// 揭示动作已授权：强制落 allow 审计（无论后续取值成败）。
	audit.Log(h.DB, audit.Entry{
		UserID:    sid,
		ClusterID: clusterID,
		Namespace: ns,
		Resource:  "secrets",
		Action:    "reveal",
		Target:    target,
		Result:    "allow",
		SourceIP:  c.ClientIP(),
	})

	secret, err := cc.Typed.CoreV1().Secrets(ns).Get(c.Request.Context(), name, metav1.GetOptions{})
	if err != nil {
		writeK8sError(c, err)
		return
	}
	data := make(map[string]string, len(secret.Data))
	for k, v := range secret.Data {
		data[k] = string(v) // typed client 已解码为明文字节。
	}
	c.JSON(http.StatusOK, gin.H{"name": name, "namespace": ns, "data": data})
}
