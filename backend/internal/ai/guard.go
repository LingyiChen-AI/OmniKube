package ai

import "strconv"

// authorizer 抽象用户 RBAC 鉴权（对齐 rbac.Service.Authorize），便于单测隔离注入。
type authorizer interface {
	Authorize(userID, clusterID, namespace, resource, action string) (bool, []string, error)
}

// Guard 是 AI 助手的权限闸门：AI 一律「跟随发起用户自身的 RBAC」——只执行该用户本人
// 有权限的操作。系统管理员经 rbac.Authorize 的 is_admin 旁路自动放行（与平台其它入口
// 一致）。任一错误都判定为拒绝（fail-closed）。
//
// 注：早期设计另有一层「每集群 AI 授予矩阵」与用户 RBAC 取交集；现已移除,只保留这一层,
// 使权限模型与平台 RBAC 完全一致、不再重复维护。
type Guard struct {
	rbac authorizer
}

// NewGuard 装配 Guard。
func NewGuard(rbac authorizer) *Guard {
	return &Guard{rbac: rbac}
}

// Allow 判定 (userID) 能否在 (cluster, namespace) 下对 resource 执行 action。
// action 为前端树动作(view/create/edit/delete/exec/reveal)，会映射为 casbin 动作。
//
// 注意：Allow 丢弃 rbac 返回的 visibleNS。对「集群级只读聚合」场景（namespace==""）
// 请改用 AllowRead，以拿到受限的可见 NS 子集并逐 NS 聚合，否则会越权全集群读取。
func (g *Guard) Allow(userID uint, cluster, namespace, resource, action string) bool {
	ok, _, err := g.rbac.Authorize(strconv.FormatUint(uint64(userID), 10), cluster, namespace, resource, actionToCasbin(action))
	if err != nil {
		return false
	}
	return ok
}

// AllowRead 是只读工具的专用闸门，在 Allow 的基础上「暴露 rbac 的可见 NS 子集」。
// 返回 (allowed, visibleNS)：
//   - allowed==false：未过闸门或出错（fail-closed），visibleNS 恒为 nil。
//   - visibleNS==nil：无约束（系统 admin / 集群级角色）→ 调用方可全集群列举。
//   - visibleNS!=nil：受控集群级只读 → 调用方必须只遍历这些 NS 聚合，绝不全集群列举。
//
// resource 必须是规范复数名（调用方应先解析 GVR 再传入）。
func (g *Guard) AllowRead(userID uint, cluster, namespace, resource string) (allowed bool, visibleNS []string) {
	ok, visible, err := g.rbac.Authorize(strconv.FormatUint(uint64(userID), 10), cluster, namespace, resource, "read")
	if err != nil || !ok {
		return false, nil
	}
	return true, visible
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
