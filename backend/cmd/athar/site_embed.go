//go:build embed_site

package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
)

// siteFS holds the standalone marketing site served for athar.vulos.org.
// `node scripts/build-binary.mjs` copies the repo-root site/ here before the
// embedded build.
//
// This is a separate build tag from the dashboard now (which is always
// embedded — see frontend.go): the marketing site is a static tree with its
// own lifecycle (built and owned outside this package's scope), while the
// dashboard is source that lives in this repository and has no reason to be
// optional.
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
