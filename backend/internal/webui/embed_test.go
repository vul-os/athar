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
	"favicon.svg":   400,
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

// TestFaviconIsEmbeddedAndReferenced guards the regression this file was
// extended for: the React-to-vanilla rewrite dropped the whole PWA (manifest,
// service worker, PNG icon set) and took the favicon down with it, leaving an
// operator with a blank browser-tab icon. The favicon was brought back as its
// own embedded, same-origin static/favicon.svg (derived from brand/logo.svg,
// not a data: URI — see the comment above the <link> in index.html) so it is
// a real, servable, verifiable asset like every other file here.
//
// Either half of this going missing independently would leave the tab blank
// while looking "fine" some other way, so both are asserted:
//   - the asset itself must actually be embedded (checked here byte-for-byte
//     rather than relying only on assetFloors, so this test fails even if the
//     entry above it were ever deleted from that map);
//   - index.html must reference it by exactly the href the file server
//     expects, or the embed can be perfectly intact while nothing links to
//     it and the tab stays blank regardless.
//
// It also asserts the reference is a same-origin link, not a reintroduced
// data: URI — the earlier, inline-only favicon this replaced could never be
// verified with a real HTTP request (no request is ever made for a data:
// URI), which is part of why it was replaced.
func TestFaviconIsEmbeddedAndReferenced(t *testing.T) {
	svg, err := Asset("favicon.svg")
	if err != nil {
		t.Fatalf("embedded favicon.svg missing: %v — the browser tab icon would be blank again", err)
	}
	if !strings.Contains(string(svg), "<svg") {
		t.Fatalf("embedded favicon.svg (%d bytes) does not look like an SVG document", len(svg))
	}

	html := string(HTML())
	const wantLink = `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`
	if !strings.Contains(html, wantLink) {
		t.Errorf("embedded index.html does not contain %q — favicon.svg is embedded but nothing links to it, "+
			"so the tab icon is still blank", wantLink)
	}
	if strings.Contains(html, `href="data:image/svg+xml`) {
		t.Errorf("embedded index.html links the favicon via a data: URI — that can't be served or verified " +
			"like a real asset; use the embedded static/favicon.svg via a same-origin href instead")
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

// TestPageCaptureUploaderShipsWithItsPrivacyStatement guards the specific
// drift this feature introduces.
//
// Athar's whole claim is that nothing about a page's content is ever
// collected, and that claim survives the heatmap's page-capture backdrop for
// exactly one reason: the picture is something an operator deliberately
// uploaded, and the dashboard tells them, at the moment they upload it, that
// every viewer of the website will see whatever is in it. The upload control
// and that sentence are one thing. Shipping the control without the sentence
// would leave a privacy-first product quietly collecting screenshots of
// customer-facing pages into a shared database with nobody warned.
//
// So this asserts they travel together, in the same file, rather than trusting
// that nobody will ever tidy the "wordy" paragraph out of the panel.
func TestPageCaptureUploaderShipsWithItsPrivacyStatement(t *testing.T) {
	heatmap, err := Asset("heatmap.js")
	if err != nil {
		t.Fatalf("heatmap.js missing: %v", err)
	}
	js := string(heatmap)

	hasUploader := strings.Contains(js, "putPageImage") && strings.Contains(js, "type: 'file'")
	if !hasUploader {
		t.Fatal("heatmap.js no longer contains the page-capture uploader — if the feature was removed, " +
			"remove this test and the privacy copy with it; if it moved, move this assertion with it")
	}

	// Each of these is a distinct promise the panel makes, and each is one an
	// edit could drop on its own.
	for _, want := range []string{
		"capture-privacy",                    // the note is rendered, not just written
		"no DOM, no text and no form values", // what is still never collected
		"this server never fetches your site",
		"stored in your own database",
		"logged-out visitor", // the actionable instruction
	} {
		if !strings.Contains(js, want) {
			t.Errorf("heatmap.js ships a page-capture uploader but no longer says %q — "+
				"the upload control and its privacy consequence must not be separable", want)
		}
	}
}

// TestHeatmapHeaderDoesNotClaimNoScreenshotExists is the counterpart: the file
// used to state, in its own header comment, that no page screenshot is ever
// captured. That was true, and then it stopped being true. A comment that
// confidently describes behaviour the code no longer has is worse than no
// comment, because it is what the next reader will believe.
func TestHeatmapHeaderDoesNotClaimNoScreenshotExists(t *testing.T) {
	heatmap, err := Asset("heatmap.js")
	if err != nil {
		t.Fatalf("heatmap.js missing: %v", err)
	}
	js := strings.ToLower(string(heatmap))
	for _, stale := range []string{
		"no page screenshot is ever captured",
		"deliberately no page screenshot",
	} {
		if strings.Contains(js, stale) {
			t.Errorf("heatmap.js still says %q, but the click map now draws over an operator-uploaded "+
				"capture — update the comment rather than leaving it to mislead", stale)
		}
	}
}
