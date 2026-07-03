package ai

import "strconv"

// authorizer 抽象用户 RBAC 鉴权（对齐 rbac.Service.Authorize），便于单测隔离注入。
type authorizer interface {
	Authorize(userID, clusterID, namespace, resource, action string) (bool, []string, error)
}

// Guard 是 AI 助手的「双闸门」：一次操作必须同时满足
//  1. 该集群的 AI 授予矩阵(store.LoadGrant) 对该资源包含此动作；
//  2. 发起用户自身的 RBAC(rbac.Authorize) 也允许该动作。
//
// 任一不满足或任何错误都判定为拒绝（fail-closed）。
type Guard struct {
	store *Store
	rbac  authorizer
}

// NewGuard 装配 Guard。
func NewGuard(store *Store, rbac authorizer) *Guard {
	return &Guard{store: store, rbac: rbac}
}

// Allow 判定 (userID) 能否在 (cluster, namespace) 下对 resource 执行 action。
// action 为前端树动作(view/create/edit/delete/exec/reveal)；对 rbac 侧会映射为
// casbin 动作，对 AI 授予矩阵侧按树动作原样比对。
func (g *Guard) Allow(userID uint, cluster, namespace, resource, action string) bool {
	// 闸门 1：AI 授予矩阵。
	grant, err := g.store.LoadGrant(cluster)
	if err != nil {
		return false
	}
	if !contains(grant[resource], action) {
		return false
	}
	// 闸门 2：用户自身 RBAC。
	ok, _, err := g.rbac.Authorize(strconv.FormatUint(uint64(userID), 10), cluster, namespace, resource, actionToCasbin(action))
	if err != nil {
		return false
	}
	return ok
}

// actionToCasbin 把树动作映射为 casbin 动作（与 rbac 包保持一致）。
func actionToCasbin(a string) string {
	switch a {
	case "view":
		return "read"
	case "edit":
		return "write"
	default:
		return a // create/delete/exec/reveal 原样
	}
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
