// Package web serves the built React SPA embedded into the Go binary, so the
// whole product ships as a single image / single port.
//
// At build time `frontend/dist` is copied into ./dist (see Dockerfile); a
// committed placeholder index.html keeps `go build`/`go test` working in dev
// when the frontend hasn't been built.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

//go:embed all:dist
var dist embed.FS

// Register mounts the embedded SPA on the engine: real static files are served
// directly; every other (non-API) GET falls back to index.html so client-side
// routes like /workloads/deployments work on a hard refresh.
func Register(r *gin.Engine) {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return
	}
	fileServer := http.FileServer(http.FS(sub))

	r.NoRoute(func(c *gin.Context) {
		p := c.Request.URL.Path
		// API/health/ws are handled elsewhere — never fall back to the SPA.
		if strings.HasPrefix(p, "/api/") || p == "/healthz" {
			c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "not found"})
			return
		}
		// Serve the asset if it exists, else hand back index.html (SPA fallback).
		rel := strings.TrimPrefix(p, "/")
		if rel != "" {
			if f, err := sub.Open(rel); err == nil {
				_ = f.Close()
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
		}
		c.Request.URL.Path = "/"
		fileServer.ServeHTTP(c.Writer, c.Request)
	})
}
