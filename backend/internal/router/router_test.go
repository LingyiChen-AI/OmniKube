package router

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"omnikube/internal/auth"
	"omnikube/internal/cluster"
	"omnikube/internal/crypto"
	"omnikube/internal/database"
	"omnikube/internal/handler"
	"omnikube/internal/rbac"
)

// TestNew_WiresResourceRoutesWithoutConflict proves the reveal route and the generic
// :resource routes coexist in gin's tree (no wildcard-conflict panic), and that the
// resource group is guarded by JWTAuth (401 without a token).
func TestNew_WiresResourceRoutesWithoutConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	ci, err := crypto.New(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	jm := auth.NewJWTManager("secret", time.Hour)
	pool := cluster.NewPool(db, ci, func(string) (*cluster.ClusterClient, error) { return &cluster.ClusterClient{}, nil })
	svc, err := rbac.NewService(db, pool)
	if err != nil {
		t.Fatal(err)
	}
	h := &handler.Handler{DB: db, JWT: jm, Pool: pool, RBAC: svc}

	r := New(h, jm) // must not panic

	for _, path := range []string{
		"/api/v1/resources/pods",
		"/api/v1/namespaces/dev/resources/pods/p1",
		"/api/v1/namespaces/dev/resources/secrets/db/reveal",
		"/api/v1/namespaces",
	} {
		method := http.MethodGet
		if path == "/api/v1/namespaces/dev/resources/secrets/db/reveal" {
			method = http.MethodPost
		}
		req, _ := http.NewRequest(method, path, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s expected 401 (JWTAuth guard), got %d", method, path, w.Code)
		}
	}
}
