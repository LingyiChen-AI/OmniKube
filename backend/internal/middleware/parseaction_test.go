package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestParseAction maps HTTP methods to RBAC actions. POST maps to "create"
// (resource creation) while PUT/PATCH map to "write" (update), so "can edit but
// not create" is expressible; DELETE maps to "delete" so "can edit but not delete"
// is also expressible.
func TestParseAction(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		method string
		want   string
	}{
		{http.MethodGet, "read"},
		{http.MethodPost, "create"},
		{http.MethodPut, "write"},
		{http.MethodPatch, "write"},
		{http.MethodDelete, "delete"},
	}
	for _, tc := range cases {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request, _ = http.NewRequest(tc.method, "/x", nil)
		if got := parseAction(c); got != tc.want {
			t.Fatalf("parseAction(%s)=%q want %q", tc.method, got, tc.want)
		}
	}
}
