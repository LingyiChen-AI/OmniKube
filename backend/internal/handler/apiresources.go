package handler

import (
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"

	"omnikube/internal/rbac"
)

// apiResourceInfo 是发现端点回传的单条资源类型元数据(非资源数据本身)。
type apiResourceInfo struct {
	Group      string   `json:"group"`
	Version    string   `json:"version"`
	Resource   string   `json:"resource"` // 复数名,用于通用 CRUD 路由的 :resource
	Kind       string   `json:"kind"`
	Namespaced bool     `json:"namespaced"`
	Builtin    bool     `json:"builtin"` // 是否为现有 13 种内置资源(前端可默认隐藏)
	Verbs      []string `json:"verbs"`
}

// ListAPIResources 用 discovery 列出当前集群所有资源类型(含 CRD)。门槛仅 JWT + 有效集群:
// 只返回类型元数据,真正的资源数据仍由 RBAC 中间件逐资源门控。
func (h *Handler) ListAPIResources(c *gin.Context) {
	cc, ok := h.clusterClientFromHeader(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的 X-Cluster-ID"})
		return
	}
	lists, err := cc.Discovery.ServerPreferredResources()
	// 个别 API 组发现失败(如聚合 API 后端不可用)仍会返回其余部分结果;忽略该错误。
	if err != nil && !discovery.IsGroupDiscoveryFailedError(err) {
		writeK8sError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"resources": flattenAPIResources(lists)})
}

// flattenAPIResources 把 discovery 的分组结果展平为条目数组:剔除子资源(名字含 "/")
// 与不可 list 的类型;标注 builtin;按 group 再 resource 排序。
func flattenAPIResources(lists []*metav1.APIResourceList) []apiResourceInfo {
	out := make([]apiResourceInfo, 0, 128)
	for _, list := range lists {
		if list == nil {
			continue
		}
		gv, err := schema.ParseGroupVersion(list.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range list.APIResources {
			if strings.Contains(r.Name, "/") { // 子资源(如 pods/log)
				continue
			}
			if !hasVerb(r.Verbs, "list") { // 不可列举的类型对浏览无意义
				continue
			}
			out = append(out, apiResourceInfo{
				Group:      gv.Group,
				Version:    gv.Version,
				Resource:   r.Name,
				Kind:       r.Kind,
				Namespaced: r.Namespaced,
				Builtin:    rbac.IsValidResource(r.Name),
				Verbs:      r.Verbs,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Group != out[j].Group {
			return out[i].Group < out[j].Group
		}
		return out[i].Resource < out[j].Resource
	})
	return out
}

// hasVerb 判断 verb 列表是否含目标动词。
func hasVerb(verbs metav1.Verbs, want string) bool {
	for _, v := range verbs {
		if v == want {
			return true
		}
	}
	return false
}
