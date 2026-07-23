//go:build !embed_frontend

package main

import "net/http"

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
