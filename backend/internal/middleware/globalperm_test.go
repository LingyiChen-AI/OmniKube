package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestRequireGlobalPerm(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// fake checker: 用户 7 在 users 有 view,create
	chk := func(uid uint, area, action string) bool {
		return uid == 7 && area == "users" && (action == "view" || action == "create")
	}
	run := func(uid uint, isAdmin bool, area, action string) int {
		r := gin.New()
		r.GET("/x", func(c *gin.Context) { c.Set("user_id", uid); c.Set("is_admin", isAdmin); c.Next() },
			RequireGlobalPerm(chk, area, action), func(c *gin.Context) { c.Status(200) })
		w := httptest.NewRecorder()
		req, _ := http.NewRequest("GET", "/x", nil)
		r.ServeHTTP(w, req)
		return w.Code
	}
	if run(7, false, "users", "view") != 200 {
		t.Fatal("user view ok")
	}
	if run(7, false, "users", "delete") != 403 {
		t.Fatal("user delete 403")
	}
	if run(9, false, "users", "view") != 403 {
		t.Fatal("other 403")
	}
	if run(9, true, "users", "delete") != 200 {
		t.Fatal("admin bypass")
	}
}
