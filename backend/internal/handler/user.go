package handler

import (
	"crypto/rand"
	"math/big"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/model"
)

type createUserReq struct {
	Username string `json:"username" binding:"required"`
	RoleIDs  []uint `json:"role_ids"`
}

// roleRef 是用户视图里的角色标签。
type roleRef struct {
	ID   uint   `json:"id"`
	Name string `json:"name"`
	Key  string `json:"key"` // 预设角色稳定标识, 前端据此 i18n
}

// userView 是用户的安全视图，绝不包含密码哈希。
type userView struct {
	ID        uint      `json:"id"`
	Username  string    `json:"username"`
	IsAdmin   bool      `json:"is_admin"`
	Disabled  bool      `json:"disabled"`
	MustReset bool      `json:"must_reset"`
	Roles     []roleRef `json:"roles"`
}

func toUserView(u model.User, roles []roleRef) userView {
	if roles == nil {
		roles = []roleRef{}
	}
	return userView{ID: u.ID, Username: u.Username, IsAdmin: u.IsAdmin, Disabled: u.Disabled, MustReset: u.MustReset, Roles: roles}
}

// validateRoleIDs 校验给定角色 ID 全部存在，返回缺失的第一个（若有）。
func (h *Handler) validateRoleIDs(ids []uint) (bool, error) {
	if len(ids) == 0 {
		return true, nil
	}
	var n int64
	if err := h.DB.Model(&model.Role{}).Where("id IN ?", ids).Count(&n).Error; err != nil {
		return false, err
	}
	// 去重后比较数量。
	seen := map[uint]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	return int(n) == len(seen), nil
}

// setUserRoles 在事务里全量替换某用户的 user_roles。
func (h *Handler) setUserRoles(userID uint, roleIDs []uint) error {
	return h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&model.UserRole{}).Error; err != nil {
			return err
		}
		seen := map[uint]bool{}
		rows := make([]model.UserRole, 0, len(roleIDs))
		for _, rid := range roleIDs {
			if seen[rid] {
				continue
			}
			seen[rid] = true
			rows = append(rows, model.UserRole{UserID: userID, RoleID: rid})
		}
		if len(rows) > 0 {
			if err := tx.Create(&rows).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// CreateUser POST /api/v1/users —— 建普通用户 + 绑角色 + 物化，生成随机临时密码（响应里返回一次）。
func (h *Handler) CreateUser(c *gin.Context) {
	var req createUserReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	if ok, err := h.validateRoleIDs(req.RoleIDs); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	} else if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "存在不存在的角色"})
		return
	}
	pwd, err := randomPassword(16)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	hash, err := auth.HashPassword(pwd)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	u := model.User{Username: req.Username, Password: hash, IsAdmin: false, MustReset: true}
	if err := h.DB.Create(&u).Error; err != nil {
		c.JSON(http.StatusConflict, gin.H{"code": 409, "message": "用户名已存在"})
		return
	}
	if len(req.RoleIDs) > 0 {
		if err := h.setUserRoles(u.ID, req.RoleIDs); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
			return
		}
		if err := h.RBAC.SyncUserGrants(u.ID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "权限同步失败"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"id": u.ID, "username": u.Username,
		// 临时密码仅返回一次，由 admin 转交用户，首次登录须改密。
		"temp_password": pwd, "must_reset": true,
	})
}

// ListUsers GET /api/v1/users —— 列表（不含密码哈希，含角色标签）。
func (h *Handler) ListUsers(c *gin.Context) {
	var users []model.User
	if err := h.DB.Order("id asc").Find(&users).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	rolesByUser, err := h.rolesByUser()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	views := make([]userView, 0, len(users))
	for _, u := range users {
		views = append(views, toUserView(u, rolesByUser[u.ID]))
	}
	c.JSON(http.StatusOK, gin.H{"users": views})
}

// rolesByUser 一次性加载全部用户的角色标签，避免 N+1。
func (h *Handler) rolesByUser() (map[uint][]roleRef, error) {
	type row struct {
		UserID uint
		RoleID uint
		Name   string
		Key    string
	}
	var rows []row
	err := h.DB.Table("ok_user_roles AS ur").
		Select("ur.user_id AS user_id, ur.role_id AS role_id, r.name AS name, r.key AS key").
		Joins("JOIN ok_roles AS r ON r.id = ur.role_id").
		Order("ur.user_id asc, ur.role_id asc").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	out := map[uint][]roleRef{}
	for _, r := range rows {
		out[r.UserID] = append(out[r.UserID], roleRef{ID: r.RoleID, Name: r.Name, Key: r.Key})
	}
	return out, nil
}

// SetUserRoles PUT /api/v1/users/:id/roles —— 全量设置用户角色 + 重物化。
func (h *Handler) SetUserRoles(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的用户 ID"})
		return
	}
	var u model.User
	if err := h.DB.First(&u, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "用户不存在"})
		return
	}
	var req struct {
		RoleIDs []uint `json:"role_ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	if ok, err := h.validateRoleIDs(req.RoleIDs); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	} else if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "存在不存在的角色"})
		return
	}
	if err := h.setUserRoles(u.ID, req.RoleIDs); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	if err := h.RBAC.SyncUserGrants(u.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "权限同步失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "操作成功"})
}

// DisableUser PUT /api/v1/users/:id/disable
func (h *Handler) DisableUser(c *gin.Context) {
	h.setDisabled(c, true)
}

// EnableUser PUT /api/v1/users/:id/enable
func (h *Handler) EnableUser(c *gin.Context) {
	h.setDisabled(c, false)
}

func (h *Handler) setDisabled(c *gin.Context, disabled bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的用户 ID"})
		return
	}
	var u model.User
	if err := h.DB.First(&u, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "用户不存在"})
		return
	}
	if u.IsAdmin {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "不能禁用管理员"})
		return
	}
	if err := h.DB.Model(&u).Update("disabled", disabled).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "操作成功"})
}

// ResetUserPassword POST /api/v1/users/:id/reset-password —— 系统管理员重置某用户
// 密码：生成一次性临时密码，置 must_reset=true（用户下次登录须改密），仅返回一次。
func (h *Handler) ResetUserPassword(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的用户 ID"})
		return
	}
	var u model.User
	if err := h.DB.First(&u, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "用户不存在"})
		return
	}
	if u.IsAdmin {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "不能重置管理员密码"})
		return
	}
	pwd, err := randomPassword(16)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	hash, err := auth.HashPassword(pwd)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	if err := h.DB.Model(&u).Updates(map[string]any{"password": hash, "must_reset": true}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id": u.ID, "username": u.Username,
		// 临时密码仅返回一次，由 admin 转交用户，首次登录须改密。
		"temp_password": pwd, "must_reset": true,
	})
}

// DeleteUser DELETE /api/v1/users/:id —— 删用户 + 清其全部 g 绑定（事务）。
func (h *Handler) DeleteUser(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "无效的用户 ID"})
		return
	}
	var u model.User
	if err := h.DB.First(&u, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "用户不存在"})
		return
	}
	if u.IsAdmin {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "不能删除管理员"})
		return
	}
	// 先级联清理 g 绑定，再删用户行。casbin adapter 用自身 session 自动落库，
	// 无法并入 gorm 事务，故顺序执行：级联失败则用户保留（可重试），不留下悬空绑定。
	if h.RBAC != nil {
		if err := h.RBAC.RemoveUserGrants(strconv.FormatUint(id, 10)); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
			return
		}
	}
	if err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", id).Delete(&model.UserRole{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.User{}, id).Error
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "删除成功"})
}

func randomPassword(n int) (string, error) {
	const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%"
	b := make([]byte, n)
	max := big.NewInt(int64(len(charset)))
	for i := range b {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b[i] = charset[idx.Int64()]
	}
	return string(b), nil
}
