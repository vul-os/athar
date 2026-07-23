//go:build embed_frontend

package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"strings"
)

// frontendFS holds the built dashboard. `npm run build:all` copies the repo-root
// dist/ into this directory before the embedded build; a plain `go build ./...`
// uses frontend_dev.go instead, so the Go toolchain alone still produces a
// working binary.
//
//go:embed dist
var frontendFS embed.FS

func newFrontendHandler() http.HandlerFunc {
	distFS, err := fs.Sub(frontendFS, "dist")
	if err != nil {
		log.Fatal("embedded dashboard not found:", err)
	}
	fileServer := http.FileServer(http.FS(distFS))

	return func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(distFS, path); err != nil {
			// Unknown path: hand it to the SPA router rather than 404ing, so a
			// deep link like /websites/abc/heatmap loads on a cold navigation.
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	}
}
