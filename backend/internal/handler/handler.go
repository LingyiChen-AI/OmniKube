package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/captcha"
	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/rbac"
)

type Handler struct {
	DB      *gorm.DB
	JWT     *auth.JWTManager
	Pool    *cluster.ClusterPool
	RBAC    *rbac.Service
	Cipher  *crypto.Cipher
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

// pageParams 解析 ?limit=&offset=。paged=false 表示未传 limit——按既有语义返回全部
// (保护依赖"无 limit 即拿全量"的下拉框/store 调用方)。
func pageParams(c *gin.Context) (limit, offset int, paged bool) {
	l := c.Query("limit")
	if l == "" {
		return 0, 0, false
	}
	n, err := strconv.Atoi(l)
	if err != nil || n <= 0 {
		n = 20
	}
	if n > 500 {
		n = 500
	}
	o, _ := strconv.Atoi(c.Query("offset"))
	if o < 0 {
		o = 0
	}
	return n, o, true
}

func (h *Handler) Healthz(c *gin.Context) {
	sqlDB, err := h.DB.DB()
	if err != nil || sqlDB.Ping() != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "db unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
