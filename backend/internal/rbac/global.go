package rbac

import "encoding/json"

// UserGlobalPerms 返回用户所有角色 GlobalPerms 的并集（area→action集合），
// 仅保留合法的全局区域与动作（IsValidGlobalArea/IsValidGlobalAction）。
func (s *Service) UserGlobalPerms(userID uint) (map[string]map[string]bool, error) {
	var raws []string
	q := s.db.Table("ok_roles AS r").
		Joins("JOIN ok_user_roles ur ON ur.role_id = r.id").
		Where("ur.user_id = ?", userID).
		Pluck("r.global_perms", &raws)
	if q.Error != nil {
		return nil, q.Error
	}
	out := map[string]map[string]bool{}
	for _, raw := range raws {
		if raw == "" {
			continue
		}
		var m map[string][]string
		if json.Unmarshal([]byte(raw), &m) != nil {
			continue
		}
		for area, acts := range m {
			if !IsValidGlobalArea(area) {
				continue
			}
			if out[area] == nil {
				out[area] = map[string]bool{}
			}
			for _, a := range acts {
				if IsValidGlobalAction(a) {
					out[area][a] = true
				}
			}
		}
	}
	return out, nil
}

// AllGlobalPerms 超管全开：clusters/users/roles 每区域全动作；releases/audit 仅 view。
func AllGlobalPerms() map[string][]string {
	full := []string{"view", "create", "edit", "delete"}
	return map[string][]string{
		"clusters": full,
		"users":    full,
		"roles":    full,
		"releases": {"view"},
		"audit":    {"view"},
		// ai:create 语义为「AI 启用/停用开关」（与 edit=编辑模型配置 分离）。
		"ai": {"view", "edit", "create"},
	}
}
