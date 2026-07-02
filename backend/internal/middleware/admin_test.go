package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func adminApp(setCtx func(c *gin.Context)) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/admin", func(c *gin.Context) {
		if setCtx != nil {
			setCtx(c)
		}
		c.Next()
	}, RequireAdmin(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	return r
}

func req(r *gin.Engine) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	rq, _ := http.NewRequest("GET", "/admin", nil)
	r.ServeHTTP(w, rq)
	return w
}

func TestRequireAdmin_Allow(t *testing.T) {
	r := adminApp(func(c *gin.Context) { c.Set("is_admin", true) })
	if w := req(r); w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

func TestRequireAdmin_NotAdmin(t *testing.T) {
	r := adminApp(func(c *gin.Context) { c.Set("is_admin", false) })
	if w := req(r); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}

func TestRequireAdmin_Missing(t *testing.T) {
	r := adminApp(nil)
	if w := req(r); w.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", w.Code)
	}
}
