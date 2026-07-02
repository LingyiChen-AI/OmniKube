package handler

import (
	"encoding/base64"
	"net/http"
	"sort"
	"strconv"

	"github.com/gin-gonic/gin"

	"omnikube/internal/audit"
	"omnikube/internal/auth"
	"omnikube/internal/model"
	"omnikube/internal/rbac"
)

// GetCaptcha GET /api/v1/captcha —— 生成一张图形验证码, 返回 {id, image(data URL)}。
func (h *Handler) GetCaptcha(c *gin.Context) {
	if h.Captcha == nil {
		c.JSON(http.StatusOK, gin.H{"id": "", "image": ""})
		return
	}
	id, png, err := h.Captcha.Generate()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "验证码生成失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"id":    id,
		"image": "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
	})
}

type loginReq struct {
	Username    string `json:"username" binding:"required"`
	Password    string `json:"password" binding:"required"`
	CaptchaID   string `json:"captcha_id"`
	CaptchaCode string `json:"captcha_code"`
}

func (h *Handler) Login(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误"})
		return
	}
	// 验证码在密码校验之前, 防止对密码接口的暴力尝试。nil=关闭(测试)。
	if h.Captcha != nil && !h.Captcha.Verify(req.CaptchaID, req.CaptchaCode) {
		audit.Log(h.DB, audit.Entry{
			Action: "login", Target: req.Username, Result: "failed", SourceIP: c.ClientIP(),
		})
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "验证码错误或已过期"})
		return
	}
	var user model.User
	// 忽略错误：用户不存在时 user.Password 为空，VerifyPasswordConstant 仍执行等时比较，
	// 两条路径耗时一致，避免计时侧信道泄露用户名是否存在（防枚举）。
	_ = h.DB.Where("username = ?", req.Username).First(&user).Error
	// 密码校验与禁用判断合并：失败路径文案/状态码一致，避免泄露账号是否存在或被禁用。
	if !auth.VerifyPasswordConstant(user.Password, req.Password) || user.Disabled {
		audit.Log(h.DB, audit.Entry{
			UserID: uidStr(user.ID), Action: "login", Target: req.Username,
			Result: "failed", SourceIP: c.ClientIP(),
		})
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "用户名或密码错误"})
		return
	}
	token, err := h.JWT.Issue(user.ID, user.IsAdmin)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	audit.Log(h.DB, audit.Entry{
		UserID: uidStr(user.ID), Action: "login", Target: user.Username,
		Result: "success", SourceIP: c.ClientIP(),
	})
	c.JSON(http.StatusOK, gin.H{"token": token, "must_reset": user.MustReset})
}

// uidStr 把用户 ID 转为审计用字符串; 0(未知用户)返回空串。
func uidStr(id uint) string {
	if id == 0 {
		return ""
	}
	return strconv.FormatUint(uint64(id), 10)
}

type changePwdReq struct {
	OldPassword string `json:"old_password" binding:"required"`
	NewPassword string `json:"new_password" binding:"required,min=8"`
}

func (h *Handler) ChangePassword(c *gin.Context) {
	var req changePwdReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "参数错误(新密码至少8位)"})
		return
	}
	userID := c.MustGet("user_id").(uint)
	var user model.User
	if err := h.DB.First(&user, userID).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "用户不存在"})
		return
	}
	if !auth.VerifyPassword(user.Password, req.OldPassword) {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "旧密码错误"})
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	if err := h.DB.Model(&user).Updates(map[string]interface{}{
		"password": hash, "must_reset": false,
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "内部错误"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "改密成功"})
}

func (h *Handler) Me(c *gin.Context) {
	userID := c.MustGet("user_id").(uint)
	var user model.User
	if err := h.DB.First(&user, userID).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "用户不存在"})
		return
	}
	submenus, global := h.navAndGlobal(user)
	c.JSON(http.StatusOK, gin.H{
		"id": user.ID, "username": user.Username,
		"is_admin": user.IsAdmin, "must_reset": user.MustReset,
		"nav":    gin.H{"submenus": submenus},
		"global": global,
	})
}

// navAndGlobal 计算当前用户的导航子菜单与全局权限：
// admin → submenus = 全部资源子菜单(排序副本)，global = AllGlobalPerms()；
// 非 admin → submenus 由其角色规则 operations 中有 "view" 的资源派生(VisibleSubmenus)，
// global 由其角色 GlobalPerms 并集展开为 area→已排序动作切片。
func (h *Handler) navAndGlobal(user model.User) (submenus []string, global map[string][]string) {
	if user.IsAdmin {
		subs := make([]string, len(rbac.AllResources))
		copy(subs, rbac.AllResources)
		sort.Strings(subs)
		return subs, rbac.AllGlobalPerms()
	}
	var opsRaws []string
	h.DB.Table("ok_role_rules AS rr").
		Joins("JOIN ok_user_roles AS ur ON ur.role_id = rr.role_id").
		Where("ur.user_id = ?", user.ID).
		Pluck("rr.operations", &opsRaws)
	submenus = rbac.VisibleSubmenus(opsRaws)
	gp, _ := h.RBAC.UserGlobalPerms(user.ID)
	global = map[string][]string{}
	for area, set := range gp {
		for a := range set {
			global[area] = append(global[area], a)
		}
		sort.Strings(global[area])
	}
	return submenus, global
}

// MyCapabilities 返回当前用户在指定集群(X-Cluster-ID)+命名空间(query) 下，
// 每个具体资源允许的树动作集合，驱动前端按权限显示操作列按钮。admin → 全部。
func (h *Handler) MyCapabilities(c *gin.Context) {
	userID := c.MustGet("user_id").(uint)
	var user model.User
	if err := h.DB.First(&user, userID).Error; err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "用户不存在"})
		return
	}
	if user.IsAdmin {
		c.JSON(http.StatusOK, gin.H{"resources": rbac.AllCapabilities()})
		return
	}
	clusterID := c.GetHeader("X-Cluster-ID")
	if clusterID == "" {
		c.JSON(http.StatusOK, gin.H{"resources": map[string][]string{}})
		return
	}
	namespace := c.Query("namespace")
	sid := strconv.FormatUint(uint64(user.ID), 10)
	c.JSON(http.StatusOK, gin.H{"resources": h.RBAC.Capabilities(sid, clusterID, namespace)})
}
