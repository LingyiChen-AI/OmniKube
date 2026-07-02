package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/captcha"
	"omnikube/internal/cluster"
	"omnikube/internal/rbac"
)

type Handler struct {
	DB      *gorm.DB
	JWT     *auth.JWTManager
	Pool    *cluster.ClusterPool
	RBAC    *rbac.Service
	Captcha *captcha.Store // nil = 关闭登录验证码(测试默认关闭)
}

// GlobalPermCheck 供路由中间件用：admin 在中间件已旁路；此处仅普通用户。
// 返回该用户是否对全局区域 area 拥有 action 动作。
func (h *Handler) GlobalPermCheck(userID uint, area, action string) bool {
	perms, err := h.RBAC.UserGlobalPerms(userID)
	if err != nil {
		return false
	}
	return perms[area][action]
}

func (h *Handler) Healthz(c *gin.Context) {
	sqlDB, err := h.DB.DB()
	if err != nil || sqlDB.Ping() != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "db unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
