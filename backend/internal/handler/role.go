package handler

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"omnikube/internal/model"
	"omnikube/internal/rbac"
)

// roleRuleReq 是创建/更新角色时单条规则的入参（每条规则单集群）。
type roleRuleReq struct {
	ClusterID  string              `json:"cluster_id"`
	Scope      string              `json:"scope"`
	Namespaces []string            `json:"namespaces"`
	Operations map[string][]string `json:"operations"`
}

type roleReq struct {
	Name        string              `json:"name" binding:"required"`
	Description string              `json:"description"`
	GlobalPerms map[string][]string `json:"global_perms"` // area → actions（仅合法 area+action, 其它剔除）
	Rules       []roleRuleReq       `json:"rules"`
}

// ruleView 是规则的出参视图（每行一个集群）。
type ruleView struct {
	ClusterID  string              `json:"cluster_id"`
	Scope      string              `json:"scope"`
	Namespaces []string            `json:"namespaces"`
	Operations map[string][]string `json:"operations"`
}

type roleView struct {
	ID          uint                `json:"id"`
	Name        string              `json:"name"`
	Description string              `json:"description"`
	Key         string              `json:"key"` // 预设角色稳定标识, 前端据此 i18n
	System      bool                `json:"system"`
	GlobalPerms map[string][]string `json:"global_perms"` // area → actions
	Rules       []ruleView          `json:"rules"`
	UserCount   int64               `json:"user_count"`
}

// sanitizeGlobalPerms 去重并仅保留合法全局区域(area)与全局动作(action)，剔除未知项。
func sanitizeGlobalPerms(in map[string][]string) map[string][]string {
	out := map[string][]string{}
	for area, acts := range in {
		if !rbac.IsValidGlobalArea(area) {
			continue
		}
		seen := map[string]bool{}
		kept := []string{}
		for _, a := range acts {
			if rbac.IsValidGlobalAction(a) && !seen[a] {
				seen[a] = true
				kept = append(kept, a)
			}
		}
		out[area] = kept
	}
	return out
}

// marshalGlobalPerms 把全局权限清洗后序列化为 JSON 字符串。
func marshalGlobalPerms(in map[string][]string) string {
	b, _ := json.Marshal(sanitizeGlobalPerms(in))
	return string(b)
}

// validateRules 校验每条规则的 scope/集群/命名空间/操作合法性（子项目 H §7）。
func (h *Handler) validateRules(rules []roleRuleReq) (string, bool) {
	for _, r := range rules {
		// 操作权限枚举校验（空操作允许=占位无权限）：key 必须是合法资源，
		// 每个动作必须适用于该资源（exec 仅 pods、reveal 仅 secrets）。
		for res, acts := range r.Operations {
			if !rbac.IsValidResource(res) {
				return "未知资源: " + res, false
			}
			for _, a := range acts {
				if !rbac.ResourceActionApplies(res, a) {
					return "动作 " + a + " 不适用于资源 " + res, false
				}
			}
		}
		switch r.Scope {
		case "cluster":
			// 整集群范围: cluster_id 可为 "*"; namespaces 忽略。
			if r.ClusterID == "" {
				return "每条规则必须选择一个集群", false
			}
		case "namespace":
			if r.ClusterID == "" {
				return "每条规则必须选择一个集群", false
			}
			if r.ClusterID == "*" {
				return "命名空间范围不支持全部集群(*)", false
			}
			if len(r.Namespaces) == 0 {
				return "命名空间范围必须指定 namespaces", false
			}
		default:
			return "scope 必须是 cluster 或 namespace", false
		}
		// 具体集群必须存在（"*" 跳过）。
		if r.ClusterID != "*" {
			var n int64
			h.DB.Model(&model.Cluster{}).Where("id = ?", r.ClusterID).Count(&n)
			if n == 0 {
				return "集群不存在: " + r.ClusterID, false
			}
		}
	}
	return "", true
}

// expandRules 把入参规则转成 RoleRule 行（每条规则一行, 单集群）。
func expandRules(roleID uint, rules []roleRuleReq) []model.RoleRule {
	out := make([]model.RoleRule, 0, len(rules))
	for _, r := range rules {
		nsJSON := ""
		if r.Scope == "namespace" {
			b, _ := json.Marshal(r.Namespaces)
			nsJSON = string(b)
		}
		ops := r.Operations
		if ops == nil {
			ops = map[string][]string{}
		}
		opsJSON, _ := json.Marshal(ops)
		out = append(out, model.RoleRule{
			RoleID:     roleID,
			ClusterID:  r.ClusterID,
			Scope:      r.Scope,
			Namespaces: nsJSON,
			Operations: string(opsJSON),
		})
	}
	return out
}

// CreateRole POST /api/v1/roles —— 建角色 + 规则。新角色暂无绑定用户，无需 sync。
func (h *Handler) CreateRole(c *gin.Context) {
	var req roleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	if msg, ok := h.validateRules(req.Rules); !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": msg})
		return
	}
	var dup int64
	h.DB.Model(&model.Role{}).Where("name = ?", req.Name).Count(&dup)
	if dup > 0 {
		c.JSON(http.StatusConflict, gin.H{"code": 409, "message": "角色名已存在"})
		return
	}
	role := model.Role{Name: req.Name, Description: req.Description, GlobalPerms: marshalGlobalPerms(req.GlobalPerms)}
	if err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&role).Error; err != nil {
			return err
		}
		rules := expandRules(role.ID, req.Rules)
		if len(rules) > 0 {
			if err := tx.Create(&rules).Error; err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		c.JSON(http.StatusConflict, gin.H{"code": 409, "message": "角色名已存在"})
		return
	}
	c.JSON(http.StatusOK, h.buildRoleView(role))
}

// ListRoles GET /api/v1/roles?limit=&offset= —— 列出角色（规则按角色分组，含绑定用户数）。
// 无 limit 返回全部(兼容既有调用方,如角色下拉);有 limit 则分页并带 total。
func (h *Handler) ListRoles(c *gin.Context) {
	var total int64
	h.DB.Model(&model.Role{}).Count(&total)

	limit, offset, paged := pageParams(c)

	var roles []model.Role
	q := h.DB.Order("id asc")
	if paged {
		q = q.Limit(limit).Offset(offset)
	}
	if err := q.Find(&roles).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	views := make([]roleView, 0, len(roles))
	for _, r := range roles {
		views = append(views, h.buildRoleView(r))
	}
	c.JSON(http.StatusOK, gin.H{"roles": views, "total": total})
}

// GetRole GET /api/v1/roles/:id
func (h *Handler) GetRole(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的角色 ID"})
		return
	}
	var role model.Role
	if err := h.DB.First(&role, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "角色不存在"})
		return
	}
	c.JSON(http.StatusOK, h.buildRoleView(role))
}

// UpdateRole PUT /api/v1/roles/:id —— 全量替换 name/description/rules，并重物化所有绑定用户。
// System 预设角色不可修改（403），只能查看。
func (h *Handler) UpdateRole(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的角色 ID"})
		return
	}
	var role model.Role
	if err := h.DB.First(&role, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "角色不存在"})
		return
	}
	if role.System {
		c.JSON(http.StatusForbidden, gin.H{"code": 403, "message": "系统预设角色不可修改"})
		return
	}
	var req roleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	if msg, ok := h.validateRules(req.Rules); !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": msg})
		return
	}
	var dup int64
	h.DB.Model(&model.Role{}).Where("name = ? AND id <> ?", req.Name, role.ID).Count(&dup)
	if dup > 0 {
		c.JSON(http.StatusConflict, gin.H{"code": 409, "message": "角色名已存在"})
		return
	}
	if err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.Role{}).Where("id = ?", role.ID).
			Updates(map[string]any{"name": req.Name, "description": req.Description, "global_perms": marshalGlobalPerms(req.GlobalPerms)}).Error; err != nil {
			return err
		}
		if err := tx.Where("role_id = ?", role.ID).Delete(&model.RoleRule{}).Error; err != nil {
			return err
		}
		rules := expandRules(role.ID, req.Rules)
		if len(rules) > 0 {
			if err := tx.Create(&rules).Error; err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	if err := h.RBAC.SyncRoleUsers(role.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "权限同步失败"})
		return
	}
	role.Name, role.Description, role.GlobalPerms = req.Name, req.Description, marshalGlobalPerms(req.GlobalPerms)
	c.JSON(http.StatusOK, h.buildRoleView(role))
}

// DeleteRole DELETE /api/v1/roles/:id —— 删角色 + 解绑 user_roles + 删 role_rules，再重物化受影响用户。
// System 预设角色禁止删除（409）。
func (h *Handler) DeleteRole(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的角色 ID"})
		return
	}
	var role model.Role
	if err := h.DB.First(&role, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "角色不存在"})
		return
	}
	if role.System {
		c.JSON(http.StatusConflict, gin.H{"code": 409, "message": "系统预设角色不可删除"})
		return
	}
	affected, err := h.RBAC.UsersForRole(role.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	if err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("role_id = ?", role.ID).Delete(&model.UserRole{}).Error; err != nil {
			return err
		}
		if err := tx.Where("role_id = ?", role.ID).Delete(&model.RoleRule{}).Error; err != nil {
			return err
		}
		if err := tx.Delete(&model.Role{}, role.ID).Error; err != nil {
			return err
		}
		return nil
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	for _, uid := range affected {
		if err := h.RBAC.SyncUserGrants(uid); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "权限同步失败"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "删除成功"})
}

// buildRoleView 把一个角色及其规则行组装成出参视图。
func (h *Handler) buildRoleView(role model.Role) roleView {
	var rules []model.RoleRule
	h.DB.Where("role_id = ?", role.ID).Order("id asc").Find(&rules)
	rvs := make([]ruleView, 0, len(rules))
	for _, r := range rules {
		ns := []string{}
		if r.Scope == "namespace" && r.Namespaces != "" {
			_ = json.Unmarshal([]byte(r.Namespaces), &ns)
		}
		ops := map[string][]string{}
		if r.Operations != "" {
			_ = json.Unmarshal([]byte(r.Operations), &ops)
		}
		rvs = append(rvs, ruleView{ClusterID: r.ClusterID, Scope: r.Scope, Namespaces: ns, Operations: ops})
	}
	gp := map[string][]string{}
	if role.GlobalPerms != "" {
		_ = json.Unmarshal([]byte(role.GlobalPerms), &gp)
	}
	gp = sanitizeGlobalPerms(gp)
	var uc int64
	h.DB.Model(&model.UserRole{}).Where("role_id = ?", role.ID).Count(&uc)
	return roleView{
		ID: role.ID, Name: role.Name, Description: role.Description, Key: role.Key,
		System: role.System, GlobalPerms: gp, Rules: rvs, UserCount: uc,
	}
}
