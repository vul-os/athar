package main

import (
	"net/http"

	"athar/backend/internal/webui"
)

// newFrontendHandler serves the dashboard: hand-written HTML/CSS/JS embedded
// straight into the binary via backend/internal/webui (go:embed), so a plain
// `go build ./...` — no Node, no npm, no separate frontend build step —
// produces a binary with a working dashboard. This replaced a two-file,
// build-tag-gated pair (frontend_dev.go serving a repo-root dist/ from disk,
// frontend_embed.go embedding one built by `npm run build`) that existed
// only because the dashboard used to be a Vite build artifact. It is not one
// any more, so the embed is unconditional and every build mode is now the
// same code path.
//
// The dashboard has no client-side routing (no deep-linkable sub-paths), so
// this is a bare file server: index.html at "/", the CSS/JS assets beside
// it, and a real 404 for anything else — no SPA catch-all needed.
func newFrontendHandler() http.Handler {
	return http.FileServer(http.FS(webui.FS()))
}
