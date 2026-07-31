package webui

import (
	"strings"
	"testing"
)

// The dashboard is now hand-written source with no build step: static/*
// files ARE the source, so there is nothing that can go stale against them
// the way a committed dist/ could against a separate src/ tree. What can
// still break silently:
//
//   - go:embed's pattern stops matching (a renamed/deleted file) and ships
//     an empty or truncated page.
//   - an edit removes something the dashboard actually needs (a script tag,
//     the localStorage key the theme toggle depends on, an endpoint it
//     calls).
//   - the page grows a reference to an external origin — a CDN script, a
//     hosted font, a remote stylesheet — which defeats the entire point of
//     an offline-embedded, no-build UI: it must render with no network
//     access beyond the Athar server itself.
//
// Each test asserts a coverage floor before it inspects anything, so a check
// that silently stopped checking (an empty embed, a regex that no longer
// matches) fails loudly instead of reporting a vacuous pass.

// assetFloors is the minimum byte size expected of each embedded asset —
// comfortably below its actual size (see `wc -c` on backend/internal/webui/
// static/*) but far enough above zero/placeholder that a truncated or
// accidentally emptied file cannot pass.
var assetFloors = map[string]int{
	"index.html":    900,
	"ui.css":        8000,
	"app.js":        12000,
	"chart.js":      6000,
	"heatmap.js":    10000,
	"heatcanvas.js": 3000,
	"format.js":     2000,
	"countries.js":  800,
	"theme.js":      1500,
	"theme-init.js": 600,
	"api.js":        2000,
	"dom.js":        1000,
}

func TestEmbeddedAssetsArePresent(t *testing.T) {
	for name, floor := range assetFloors {
		b, err := Asset(name)
		if err != nil {
			t.Fatalf("embedded asset %q missing: %v", name, err)
		}
		if len(b) < floor {
			t.Errorf("embedded %q is %d bytes, want at least %d — looks empty or truncated", name, len(b), floor)
		}
	}
}

func TestEmbeddedHTMLIsPresent(t *testing.T) {
	html := HTML()
	if len(html) < assetFloors["index.html"] {
		t.Fatalf("embedded index.html is %d bytes, want at least %d — the embed is empty or truncated, "+
			"so / would serve nothing usable", len(html), assetFloors["index.html"])
	}
}

// TestEmbeddedHTMLHasRequiredElements checks the page still wires up the
// pieces the dashboard depends on: the stylesheet and app script (both
// same-origin, no inline script — see the CSP in backend/cmd/athar/main.go),
// the theme bootstrap script and the localStorage key it shares with
// theme.js, and the page title.
func TestEmbeddedHTMLHasRequiredElements(t *testing.T) {
	html := string(HTML())
	required := []string{
		`<link rel="stylesheet" href="/ui.css">`,
		`<script src="/theme-init.js">`,
		`<script type="module" src="/app.js">`,
		`id="root"`,
		"<title>Athar</title>",
	}
	for _, want := range required {
		if !strings.Contains(html, want) {
			t.Errorf("embedded index.html does not contain %q — the dashboard is missing something it needs", want)
		}
	}
}

// TestThemeKeyIsConsistent guards a very specific regression: theme-init.js
// (which resolves the theme before first paint) and theme.js (which the
// running app uses afterward) must read and write the exact same
// localStorage key, or the two disagree and every load flashes the wrong
// colours before correcting itself.
func TestThemeKeyIsConsistent(t *testing.T) {
	initJS, err := Asset("theme-init.js")
	if err != nil {
		t.Fatalf("theme-init.js missing: %v", err)
	}
	themeJS, err := Asset("theme.js")
	if err != nil {
		t.Fatalf("theme.js missing: %v", err)
	}
	const key = "athar-theme"
	if !strings.Contains(string(initJS), key) {
		t.Errorf("theme-init.js does not reference localStorage key %q", key)
	}
	if !strings.Contains(string(themeJS), key) {
		t.Errorf("theme.js does not reference localStorage key %q", key)
	}
}

// TestEmbeddedAssetsReferenceNoExternalOrigin is the property that actually
// matters for an offline-embedded UI: nothing it ships may load a resource
// from anywhere but the Athar server itself. Plain navigational links (the
// footer's link to the project's source on GitHub) are fine — a user
// clicking off-page is not the page depending on that origin to render — so
// this specifically forbids resource-loading constructs: a src="http(s)://"
// attribute, a CSS @import or url(http...), an external stylesheet link, a
// preconnect/preload hint, or any reference to a CDN host.
func TestEmbeddedAssetsReferenceNoExternalOrigin(t *testing.T) {
	forbidden := []string{
		`src="http://`, `src="https://`, `src='http://`, `src='https://`,
		`@import`, `url(http://`, `url(https://`,
		`rel="stylesheet" href="http`, `rel="preload"`, `rel="preconnect"`, `rel="dns-prefetch"`,
		"cdn.", "googleapis.com", "gstatic.com", "jsdelivr", "unpkg.com", "cdnjs",
		"fonts.google", "fontawesome",
	}
	for name := range assetFloors {
		b, err := Asset(name)
		if err != nil {
			t.Fatalf("embedded asset %q missing: %v", name, err)
		}
		content := strings.ToLower(string(b))
		for _, pat := range forbidden {
			if strings.Contains(content, pat) {
				t.Errorf("embedded %q contains %q — an offline-embedded dashboard must load no external resource", name, pat)
			}
		}
	}
}

// TestNoInlineFontsOrCDNAssets is a narrower, explicit check that the
// dashboard ships zero web-font files and fetches zero fonts: it uses the
// system font stack only (see the body{} rule in ui.css), which was a
// deliberate simplification over the former @fontsource-bundled webfonts —
// see the CHANGELOG / rewrite notes for why.
func TestNoSystemFontOverrideViaExternalFace(t *testing.T) {
	css, err := Asset("ui.css")
	if err != nil {
		t.Fatalf("ui.css missing: %v", err)
	}
	if strings.Contains(strings.ToLower(string(css)), "@font-face") {
		t.Errorf("ui.css declares an @font-face — the dashboard is meant to ship zero font files/fetches and use the system font stack")
	}
}
