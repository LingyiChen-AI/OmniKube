package middleware

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"omnikube/internal/cluster"
	"omnikube/internal/rbac"
)

// RBACAuthMiddleware 落 PRD §7 鉴权链，挂在 JWTAuth 之后。
//
// 三处越权修复的中间件侧实现：
//  1. namespace 单一可信来源：resolveAuthNamespace 是唯一裁决点，写操作只认
//     path 段 :namespace，绝不读 query/body；结果写入 c.Set("auth_namespace")，
//     handler 下发前据此强制覆盖 body namespace。
//  2. 受控集群级只读：消费 rbac.Authorize 返回的 visibleNS，注入 c.Set("visible_ns")，
//     handler 必须据此逐 NS 聚合，绝不全集群 list。
//  3. reveal 是独立动作：reveal 路由不经本中间件（见 handler.RevealSecret）。
//
// 系统管理员（model.User.IsAdmin）旁路鉴权与审计闸门，但仍解析 resource/namespace
// 并写入 ctx，使 namespace 单一可信来源对管理员同样生效（比 PRD 伪代码更严格）。
func RBACAuthMiddleware(pool *cluster.ClusterPool, rbacSvc *rbac.Service, db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.GetHeader("X-Cluster-ID")
		cc, ok := pool.Get(clusterID)
		if clusterID == "" || !ok {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"code": 400, "message": "缺少或无效的 X-Cluster-ID"})
			return
		}

		resource, namespaced, err := resolveResource(cc.RESTMapper, c.Param("resource"))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"code": 400, "message": "未知资源"})
			return
		}

		namespace := resolveAuthNamespace(c, namespaced)
		c.Set("auth_namespace", namespace)
		c.Set("auth_resource", resource)
		c.Set("auth_namespaced", namespaced)

		// 系统管理员旁路鉴权（但 namespace 单一可信来源已生效）。
		if c.GetBool("is_admin") {
			c.Next()
			return
		}

		uid := c.GetUint("user_id")
		sid := strconv.FormatUint(uint64(uid), 10)
		action := parseAction(c)

		allowed, visibleNS, err := rbacSvc.Authorize(sid, clusterID, namespace, resource, action)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "鉴权失败"})
			return
		}
		if !allowed {
			// 审计(含 deny)由外层 middleware.Audit 统一记录：它在 c.Next() 返回后
			// 按最终状态码(403→denied)落库, 覆盖 admin 与所有端点, 避免重复。
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 403, "message": "无权访问"})
			return
		}
		// 受控集群级只读：handler 必须据此逐 NS 聚合。
		if visibleNS != nil {
			c.Set("visible_ns", visibleNS)
		}
		c.Next()
	}
}

// resolveResource 取 :resource 段，小写化并经 RESTMapper 校验，返回规范资源名与是否命名空间型。
func resolveResource(mapper meta.RESTMapper, raw string) (string, bool, error) {
	res := strings.ToLower(strings.TrimSpace(raw))
	if res == "" || mapper == nil {
		return "", false, errUnknownResource
	}
	gvr, err := mapper.ResourceFor(schema.GroupVersionResource{Resource: res})
	if err != nil {
		return "", false, err
	}
	gvk, err := mapper.KindFor(gvr)
	if err != nil {
		return "", false, err
	}
	mapping, err := mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
	if err != nil {
		return "", false, err
	}
	return gvr.Resource, mapping.Scope.Name() == meta.RESTScopeNameNamespace, nil
}

// resolveAuthNamespace 是 namespace 的唯一裁决点（PRD 修复 #1）。
//   - 有 :namespace 路径段（详情/写操作路由）→ 只认 path，绝不读 query/body。
//   - 命名空间型资源的 GET 列表路由（无 path 段）→ 取 query namespace（可空=集群级聚合）。
//   - 其余（集群型资源/集群型写路由）→ ""。
func resolveAuthNamespace(c *gin.Context, namespaced bool) string {
	if ns := c.Param("namespace"); ns != "" {
		return ns
	}
	if namespaced && c.Request.Method == http.MethodGet {
		return c.Query("namespace")
	}
	return ""
}

// parseAction 方法映射动作：GET→read，POST→create（资源创建），
// PUT/PATCH→write（更新），DELETE→delete。这样「能改不能建」可独立表达。
// exec/reveal 是独立动作，由各自路由显式处理，不经本映射。
func parseAction(c *gin.Context) string {
	switch c.Request.Method {
	case http.MethodGet:
		return "read"
	case http.MethodPost:
		return "create"
	case http.MethodDelete:
		return "delete"
	default:
		return "write"
	}
}

type unknownResourceErr struct{}

func (unknownResourceErr) Error() string { return "未知资源" }

var errUnknownResource = unknownResourceErr{}
