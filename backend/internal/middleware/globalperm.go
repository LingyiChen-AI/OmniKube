package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// GlobalPermFunc 判断用户对某全局区域是否有某动作。
type GlobalPermFunc func(userID uint, area, action string) bool

// RequireGlobalPerm: admin 旁路；否则按 GlobalPermFunc 校验。
// 必须挂在 JWTAuth 之后（依赖注入的 is_admin / user_id）。
func RequireGlobalPerm(check GlobalPermFunc, area, action string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetBool("is_admin") {
			c.Next()
			return
		}
		uid, _ := c.Get("user_id")
		id, _ := uid.(uint)
		if check(id, area, action) {
			c.Next()
			return
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 403, "message": "无该操作权限"})
	}
}
