package handler

import (
	"net/http"
	"sort"
	"strconv"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ListNamespaces GET /api/v1/namespaces —— NS 下拉数据权限（PRD §5.3）。
// 系统 admin 或集群级角色 → 该集群全部 NS；否则 → 用户可见 NS（ListVisibleNamespaces）。
// 不经通用 RBAC 资源中间件，但需有效 X-Cluster-ID。
func (h *Handler) ListNamespaces(c *gin.Context) {
	clusterID := c.GetHeader("X-Cluster-ID")
	cc, ok := h.Pool.Get(clusterID)
	if clusterID == "" || !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "缺少或无效的 X-Cluster-ID"})
		return
	}

	// 系统 admin：直接列该集群全部 NS。
	if c.GetBool("is_admin") {
		list, err := cc.Typed.CoreV1().Namespaces().List(c.Request.Context(), metav1.ListOptions{})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "命名空间列举失败"})
			return
		}
		names := make([]string, 0, len(list.Items))
		for _, ns := range list.Items {
			names = append(names, ns.Name)
		}
		sort.Strings(names)
		c.JSON(http.StatusOK, gin.H{"namespaces": names})
		return
	}

	// 非 admin：复用 C 的 ListVisibleNamespaces（集群级角色→全部，否则→绑定 NS）。
	uid := c.GetUint("user_id")
	sid := strconv.FormatUint(uint64(uid), 10)
	names, err := h.RBAC.ListVisibleNamespaces(sid, clusterID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "命名空间列举失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"namespaces": names})
}
