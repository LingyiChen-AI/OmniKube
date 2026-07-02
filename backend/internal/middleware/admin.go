package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// RequireAdmin 读取 JWTAuth 注入的 is_admin，非 admin（缺失或 false）返回 403。
// 必须挂在 JWTAuth 之后。
func RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		isAdmin, ok := c.Get("is_admin")
		if !ok || isAdmin != true {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": 403, "message": "需要管理员权限"})
			return
		}
		c.Next()
	}
}
