package api

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"io"
	"net/http"
	"strconv"
	"strings"

	// Registers the decoders DecodeConfig needs. These are the only two formats
	// accepted, and the format name DecodeConfig reports — not the caller's
	// Content-Type header — is what decides the stored MIME type.
	_ "image/jpeg"
	_ "image/png"

	"athar/backend/internal/auth"
	"athar/backend/internal/store"
)

// Page images: the operator-supplied backdrop the click heatmap is drawn over.
//
// ── Why upload, rather than capture or render ────────────────────────────────
//
// A heat field means very little floating over a grey rectangle, so the page
// itself has to be under it. There are three ways to get that picture, and only
// one of them is compatible with what Athar promises:
//
//	Tracker-side DOM snapshot (the rrweb approach). The most faithful, and the
//	only one that works for authenticated or localhost-only pages — but it means
//	shipping a serialiser into every visitor's browser and uploading a copy of
//	the page as that visitor saw it. That page can contain their name, their
//	basket, their order number. Sanitisation is a permanent, adversarial
//	maintenance burden, and one missed selector is a PII leak. Athar's tracker is
//	1.6 KB gzipped and captures no page content at all; that is the product's
//	central claim, not a limitation to route around.
//
//	Server-side rasterisation. The binary fetches the tracked URL and renders it.
//	No tracker change, and honest — but it requires a headless browser next to a
//	binary whose entire distribution story is "one static Go binary, no cgo, no
//	daemons", it only works for pages publicly reachable from the server (which
//	excludes staging, intranet and anything behind a login), and it turns the
//	analytics server into a thing that makes outbound requests to operator-named
//	URLs — an SSRF surface where there was none.
//
//	Operator-supplied capture — this. The operator takes a picture of their own
//	page and uploads it. It costs a manual step, and it is the only option that
//	adds no visitor-side capture, no PII surface, no new dependency and no
//	outbound network path. The operator sees exactly what is stored because they
//	produced it.
//
// ── Why alignment is exact rather than approximately right ───────────────────
//
// The tracker records a click as a percentage of the *document*: x is pageX over
// documentElement.scrollWidth, y is pageY over the full document height (see
// onClick in tracker/athar.js). A full-page capture taken at viewport width W is
// exactly one document wide and one document tall. So a sample at (x%, y%) of
// the rendered image is, by construction, the pixel that was clicked — at any
// display scale, and at any device pixel ratio, because both sides are
// proportions of the same document.
//
// Two things can break that, and both are checked rather than hoped for:
// capturing only the visible viewport instead of the full page (the dashboard
// compares the image's aspect ratio against the recorded viewport's and warns),
// and mixing viewport widths (an image is keyed by viewport width, and the
// dashboard shows one only when a single recorded viewport bucket is selected).
// Where no image matches, the view falls back to the wireframe and says
// "schematic" — never a stale or foreign page under a real heat field.

// maxUploadBytes bounds an upload before it is read into memory. Slightly above
// the store's own 8 MiB ceiling so an oversize body is rejected by the store's
// explicit error rather than truncated into a corrupt image.
const maxUploadBytes = 9 << 20

// pageImageView is the metadata shape the dashboard lists.
type pageImageView struct {
	Path      string `json:"path"`
	ViewportW int    `json:"viewport_w"`
	ImageW    int    `json:"image_w"`
	ImageH    int    `json:"image_h"`
	MIME      string `json:"mime"`
	Bytes     int    `json:"bytes"`
	CreatedAt int64  `json:"created_at"`
}

func (a *API) handleListPageImages(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessRead)
	if site == nil {
		return
	}
	metas, err := a.store.ListPageImages(r.Context(), site.ID)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not list page images")
		return
	}
	out := make([]pageImageView, 0, len(metas))
	for _, m := range metas {
		out = append(out, pageImageView{
			Path: m.URLPath, ViewportW: m.ViewportW,
			ImageW: m.ImageW, ImageH: m.ImageH,
			MIME: m.MIME, Bytes: m.ByteLen,
			CreatedAt: m.CreatedAt.UnixMilli(),
		})
	}
	auth.WriteJSON(w, http.StatusOK, map[string]any{"images": out})
}

// pageImageKey reads and validates the ?path= and ?viewport= pair every page
// image handler is addressed by.
func pageImageKey(w http.ResponseWriter, r *http.Request) (string, int, bool) {
	path := r.URL.Query().Get("path")
	if path == "" {
		auth.WriteError(w, http.StatusBadRequest, "path is required")
		return "", 0, false
	}
	if !strings.HasPrefix(path, "/") {
		// Heat samples record location.pathname (plus search), which always
		// starts with a slash. Rejecting anything else keeps the key space the
		// same on both sides rather than silently storing an image nothing can
		// ever look up.
		auth.WriteError(w, http.StatusBadRequest, "path must start with /")
		return "", 0, false
	}
	if len(path) > 512 {
		auth.WriteError(w, http.StatusBadRequest, "path is too long")
		return "", 0, false
	}

	raw := r.URL.Query().Get("viewport")
	if raw == "" {
		auth.WriteError(w, http.StatusBadRequest, "viewport is required")
		return "", 0, false
	}
	vw, err := strconv.Atoi(raw)
	if err != nil || vw < 200 || vw > 8000 {
		auth.WriteError(w, http.StatusBadRequest, "viewport must be a width in CSS pixels between 200 and 8000")
		return "", 0, false
	}
	return path, vw, true
}

// handleGetPageImage serves the stored bytes.
//
// The Content-Type is the format the decoder recognised at upload time, never a
// caller-supplied header, and the response carries its own restrictive CSP: this
// is the one route in Athar that serves bytes a human uploaded, and it is served
// from the dashboard's own origin, so it is pinned to "this can only ever be an
// image" from both ends.
func (a *API) handleGetPageImage(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessRead)
	if site == nil {
		return
	}
	path, vw, ok := pageImageKey(w, r)
	if !ok {
		return
	}

	img, err := a.store.GetPageImage(r.Context(), site.ID, path, vw)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			auth.WriteError(w, http.StatusNotFound, "no page image for that page and viewport")
			return
		}
		auth.WriteError(w, http.StatusInternalServerError, "could not load page image")
		return
	}

	h := w.Header()
	h.Set("Content-Type", img.MIME)
	h.Set("Content-Disposition", "inline")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("X-Content-Type-Options", "nosniff")
	// Private: a page capture is site content, not public analytics, and it must
	// not be cached by a shared proxy. ETag rather than a max-age so a re-upload
	// is picked up immediately instead of after a TTL.
	h.Set("Cache-Control", "private, no-cache")
	h.Set("ETag", `"`+img.SHA256+`"`)

	if match := r.Header.Get("If-None-Match"); match != "" && strings.Contains(match, img.SHA256) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(img.Bytes)))
	_, _ = w.Write(img.Bytes)
}

// handlePutPageImage stores a capture. The body is the raw image; the path and
// viewport width ride in the query string.
//
// The declared Content-Type is not trusted. The bytes are decoded, and the
// format the decoder reports is what gets stored and later served — so an SVG or
// an HTML document renamed to .png is rejected here rather than becoming a
// same-origin script delivery route.
func (a *API) handlePutPageImage(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessWrite)
	if site == nil {
		return
	}
	path, vw, ok := pageImageKey(w, r)
	if !ok {
		return
	}

	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUploadBytes))
	if err != nil {
		auth.WriteError(w, http.StatusRequestEntityTooLarge, "image is too large")
		return
	}
	if len(raw) == 0 {
		auth.WriteError(w, http.StatusBadRequest, "image body is empty")
		return
	}

	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, "body is not a PNG or JPEG image")
		return
	}
	var mime string
	switch format {
	case "png":
		mime = "image/png"
	case "jpeg":
		mime = "image/jpeg"
	default:
		auth.WriteError(w, http.StatusBadRequest, "only PNG and JPEG page images are accepted")
		return
	}
	if cfg.Width < 50 || cfg.Height < 50 {
		auth.WriteError(w, http.StatusBadRequest, "image is too small to be a page capture")
		return
	}

	img := &store.PageImage{
		WebsiteID: site.ID,
		URLPath:   path,
		ViewportW: vw,
		ImageW:    cfg.Width,
		ImageH:    cfg.Height,
		MIME:      mime,
		Bytes:     raw,
	}
	if err := a.store.PutPageImage(r.Context(), img); err != nil {
		auth.WriteError(w, http.StatusBadRequest, fmt.Sprintf("could not store page image: %v", err))
		return
	}
	auth.WriteJSON(w, http.StatusOK, pageImageView{
		Path: img.URLPath, ViewportW: img.ViewportW,
		ImageW: img.ImageW, ImageH: img.ImageH,
		MIME: img.MIME, Bytes: len(img.Bytes),
		CreatedAt: img.CreatedAt.UnixMilli(),
	})
}

func (a *API) handleDeletePageImage(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessWrite)
	if site == nil {
		return
	}
	path, vw, ok := pageImageKey(w, r)
	if !ok {
		return
	}
	if err := a.store.DeletePageImage(r.Context(), site.ID, path, vw); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			auth.WriteError(w, http.StatusNotFound, "no page image for that page and viewport")
			return
		}
		auth.WriteError(w, http.StatusInternalServerError, "could not delete page image")
		return
	}
	auth.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
