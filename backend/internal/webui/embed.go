// Package webui embeds the Athar dashboard — hand-written HTML, CSS and
// vanilla JS ES modules, no build step and no npm dependency — so the
// server can serve it with nothing beyond `go build`.
//
// static/index.html is the entire dashboard shell; static/app.js is the
// entire client-side app (boot sequence, sign-in, the per-website
// dashboard). format.js and countries.js are the pure formatting/country
// helpers, ported verbatim from the former React dashboard's src/lib and
// still covered by tests — see scripts/jstest/, run with `node --test`
// (node:test, no npm install required).
//
// This replaces what used to be a Vite build: React, Tailwind and the
// committed dist/ bundle are gone. The dashboard is now source, not a build
// artifact — there is nothing here that can go stale against a separate
// source tree the way dist/ could.
package webui

import (
	"embed"
	"io/fs"
)

//go:embed static
var files embed.FS

// FS returns the embedded dashboard filesystem, rooted at its serving root
// (index.html, ui.css, app.js, ...) — ready to hand to http.FileServer.
func FS() fs.FS {
	sub, err := fs.Sub(files, "static")
	if err != nil {
		// Only reachable if the go:embed directive above stops matching
		// (e.g. the static/ directory is renamed or deleted) — a build-time
		// mistake, not a runtime one.
		panic("webui: embedded static assets missing: " + err.Error())
	}
	return sub
}

// HTML returns the embedded index.html verbatim, for tests and for any
// caller that wants the shell without going through an http.Handler.
func HTML() []byte {
	b, err := files.ReadFile("static/index.html")
	if err != nil {
		panic("webui: index.html missing: " + err.Error())
	}
	return b
}

// Asset returns one embedded file's contents by its serving-root-relative
// name (e.g. "app.js", "ui.css"), for tests that check specific assets.
func Asset(name string) ([]byte, error) {
	return files.ReadFile("static/" + name)
}
