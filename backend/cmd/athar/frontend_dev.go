//go:build !embed_frontend

package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
)

// newFrontendHandler serves the dashboard from the repo-root dist/ when one
// exists, and otherwise explains where the dev server is. This is the build that
// `go run ./backend/cmd/athar` produces.
func newFrontendHandler() http.HandlerFunc {
	distDir := findUp("dist")

	if distDir == "" {
		log.Printf("[dev] no dist/ found — run `npm run dev` (Vite on :5173) or `npm run build`")
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8">
<title>Athar — dev mode</title>
<body style="background:#09090B;color:#FAFAFA;font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:34rem">
  <h2 style="letter-spacing:-.03em">Athar is running</h2>
  <p style="color:#A1A1AA">The API and collector are live, but the dashboard has not been built.</p>
  <p style="color:#A1A1AA">Run <code style="color:#5EEAD4">npm run dev</code> and open
     <a href="http://localhost:5173" style="color:#5EEAD4">localhost:5173</a>,
     or <code style="color:#5EEAD4">npm run build</code> to serve it from here.</p>
</div>`))
		}
	}

	log.Printf("[dev] serving dashboard from %s", distDir)
	fileServer := http.FileServer(http.Dir(distDir))

	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" {
			path = "/index.html"
		}
		if _, err := os.Stat(filepath.Join(distDir, filepath.Clean(path))); err != nil {
			r.URL.Path = "/" // let the SPA router handle deep links
		}
		fileServer.ServeHTTP(w, r)
	}
}

// findUp walks up from the working directory looking for a named directory, so
// the binary works whether it is run from the repo root or from backend/.
func findUp(name string) string {
	cwd, err := os.Getwd()
	if err != nil {
		return ""
	}
	for dir := cwd; ; {
		candidate := filepath.Join(dir, name)
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}
