package rbac

// treeActions 是前端资源树/操作列使用的动作集合（按固定顺序探测与返回）。
var treeActions = []string{"view", "create", "edit", "delete", "exec", "reveal"}

// Capabilities 返回用户在 (clusterID, namespace) 域下，每个具体资源被允许的树动作集合。
// 对每个资源、每个适用的树动作，用 Authorize 探测（树动作经 actionToCasbin 映射为
// casbin 动作），收集被允许的树动作名（而非 casbin 动作）。
// 调用方需对系统管理员单独放行（用 AllCapabilities 返回全部）。
func (s *Service) Capabilities(userID, clusterID, namespace string) map[string][]string {
	out := make(map[string][]string, len(AllResources))
	for _, res := range AllResources {
		allowed := []string{}
		for _, ta := range treeActions {
			if !ResourceActionApplies(res, ta) {
				continue
			}
			ok, _, err := s.Authorize(userID, clusterID, namespace, res, actionToCasbin(ta))
			if err == nil && ok {
				allowed = append(allowed, ta)
			}
		}
		out[res] = allowed
	}
	return out
}

// AllCapabilities 返回每个具体资源的全部适用树动作（系统管理员）。
func AllCapabilities() map[string][]string {
	out := make(map[string][]string, len(AllResources))
	for _, res := range AllResources {
		acts := []string{}
		for _, ta := range treeActions {
			if ResourceActionApplies(res, ta) {
				acts = append(acts, ta)
			}
		}
		out[res] = acts
	}
	return out
}
