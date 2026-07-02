package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"omnikube/internal/auth"
)

func setup() (*gin.Engine, *auth.JWTManager) {
	gin.SetMode(gin.TestMode)
	jm := auth.NewJWTManager("secret", time.Hour)
	r := gin.New()
	r.GET("/protected", JWTAuth(jm), func(c *gin.Context) {
		uid := c.MustGet("user_id").(uint)
		c.JSON(http.StatusOK, gin.H{"user_id": uid})
	})
	return r, jm
}

func TestJWTAuth_NoHeader(t *testing.T) {
	r, _ := setup()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/protected", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestJWTAuth_ValidToken(t *testing.T) {
	r, jm := setup()
	tok, _ := jm.Issue(7, false)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body=%s)", w.Code, w.Body.String())
	}
}

func TestJWTAuth_BadToken(t *testing.T) {
	r, _ := setup()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/protected", nil)
	req.Header.Set("Authorization", "Bearer garbage")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}
