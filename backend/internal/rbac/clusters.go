package rbac

import "omnikube/internal/model"

// AccessibleClusterIDs 返回用户通过其角色规则可访问的集群。
// all=true 表示存在 cluster_id="*" 的规则（可访问全部集群）。
func (s *Service) AccessibleClusterIDs(userID uint) (all bool, ids []string, err error) {
	var clusterIDs []string
	q := s.db.Model(&model.RoleRule{}).
		Joins("JOIN ok_user_roles AS ur ON ur.role_id = ok_role_rules.role_id").
		Where("ur.user_id = ?", userID).
		Distinct().
		Pluck("ok_role_rules.cluster_id", &clusterIDs)
	if q.Error != nil {
		return false, nil, q.Error
	}
	for _, id := range clusterIDs {
		if id == "*" {
			return true, nil, nil
		}
	}
	return false, clusterIDs, nil
}
