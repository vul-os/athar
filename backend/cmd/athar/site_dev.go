//go:build !embed_site

package main

import (
	"net/http"
	"os"
	"path/filepath"
)

// newSiteHandler serves the marketing site from the repo-root site/ directory in
// non-embedded builds, or nil when there is none — in which case /site/ is
// simply not mounted.
func newSiteHandler() http.Handler {
	dir := findUp("site")
	if dir == "" {
		return nil
	}
	return http.FileServer(http.Dir(dir))
}

// findUp walks up from the working directory looking for a named directory,
// so the binary works whether it is run from the repo root or from backend/.
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
