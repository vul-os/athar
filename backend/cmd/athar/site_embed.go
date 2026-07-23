//go:build embed_frontend

package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
)

// siteFS holds the standalone marketing site served for athar.vulos.org.
// `npm run build:all` copies the repo-root site/ here before the embedded build.
//
//go:embed site
var siteFS embed.FS

// newSiteHandler serves the embedded marketing site, or nil if unavailable.
func newSiteHandler() http.Handler {
	sub, err := fs.Sub(siteFS, "site")
	if err != nil {
		log.Printf("embedded marketing site not found: %v", err)
		return nil
	}
	return http.FileServer(http.FS(sub))
}
