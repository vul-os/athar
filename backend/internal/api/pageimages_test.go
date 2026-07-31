package api

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"testing"

	"athar/backend/internal/auth"
)

// Page images are the one place Athar accepts an upload and later serves those
// exact bytes back from its own origin. Everything asserted below is either a
// correctness property the heatmap's alignment depends on (the stored
// dimensions, the one-per-page-and-viewport key) or a boundary that keeps that
// upload from becoming a way in (the format is decided by decoding, not by the
// caller's header; writes need write access and a CSRF token).

// pngBytes builds a real PNG of the given size, so DecodeConfig has something
// genuine to read rather than a fixture whose dimensions are asserted from a
// comment.
func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{uint8(x % 251), uint8(y % 241), 0x40, 0xff})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("encode jpeg: %v", err)
	}
	return buf.Bytes()
}

// putBytes uploads a raw body, mirroring what the dashboard's own uploader does.
func (c *client) putBytes(path, contentType string, body []byte, withCSRF bool) (*http.Response, map[string]any) {
	c.ts.t.Helper()
	req, err := http.NewRequest("PUT", c.ts.srv.URL+path, bytes.NewReader(body))
	if err != nil {
		c.ts.t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", contentType)
	for name, value := range c.cookies {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	if withCSRF {
		if token := c.cookies[auth.CSRFCookie]; token != "" {
			req.Header.Set(auth.CSRFHeader, token)
		}
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.ts.t.Fatalf("PUT %s: %v", path, err)
	}
	defer res.Body.Close()
	var payload map[string]any
	_ = json.NewDecoder(res.Body).Decode(&payload)
	return res, payload
}

// getRaw fetches a non-JSON body, which is what a page image is.
func (c *client) getRaw(path string, headers map[string]string) (*http.Response, []byte) {
	c.ts.t.Helper()
	req, err := http.NewRequest("GET", c.ts.srv.URL+path, nil)
	if err != nil {
		c.ts.t.Fatalf("new request: %v", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	for name, value := range c.cookies {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.ts.t.Fatalf("GET %s: %v", path, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res, raw
}

// TestPageImageRoundTrip is the property the heatmap overlay rests on: the
// dimensions the dashboard sizes its frame from must be the real dimensions of
// the stored image, and the bytes served must be the bytes uploaded. If either
// drifts, the heat field is scaled against a picture that is not the one on
// screen, which is a silent, uniform misalignment.
func TestPageImageRoundTrip(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()
	c.bootstrap("owner", "correct-horse-battery")
	site := c.createWebsite("Shop", "shop.example")

	original := pngBytes(t, 320, 900)
	res, body := c.putBytes("/api/websites/"+site+"/page-image?path=%2Fpricing&viewport=1440", "image/png", original, true)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("upload: status %d: %v", res.StatusCode, body)
	}
	if got := body["image_w"]; got != float64(320) {
		t.Errorf("image_w = %v, want 320 — the server must read the size from the image, not be told it", got)
	}
	if got := body["image_h"]; got != float64(900) {
		t.Errorf("image_h = %v, want 900", got)
	}
	if got := body["mime"]; got != "image/png" {
		t.Errorf("mime = %v, want image/png", got)
	}

	get, raw := c.getRaw("/api/websites/"+site+"/page-image?path=%2Fpricing&viewport=1440", nil)
	if get.StatusCode != http.StatusOK {
		t.Fatalf("fetch: status %d", get.StatusCode)
	}
	if !bytes.Equal(raw, original) {
		t.Errorf("served %d bytes, uploaded %d — the image must round-trip byte for byte", len(raw), len(original))
	}
	if ct := get.Header.Get("Content-Type"); ct != "image/png" {
		t.Errorf("Content-Type = %q, want image/png", ct)
	}
	// Served from the dashboard's own origin, so it is pinned to "image and
	// nothing else" from the response side too.
	if csp := get.Header.Get("Content-Security-Policy"); csp == "" || !bytes.Contains([]byte(csp), []byte("sandbox")) {
		t.Errorf("Content-Security-Policy = %q, want a sandboxed policy on operator-uploaded bytes", csp)
	}
	etag := get.Header.Get("ETag")
	if etag == "" {
		t.Fatal("no ETag — an <img> would refetch the whole capture on every render")
	}
	notMod, _ := c.getRaw("/api/websites/"+site+"/page-image?path=%2Fpricing&viewport=1440",
		map[string]string{"If-None-Match": etag})
	if notMod.StatusCode != http.StatusNotModified {
		t.Errorf("conditional GET returned %d, want 304", notMod.StatusCode)
	}

	var listed struct {
		Images []map[string]any `json:"images"`
	}
	c.getInto("/api/websites/"+site+"/page-images", &listed)
	if len(listed.Images) != 1 {
		t.Fatalf("listed %d images, want 1", len(listed.Images))
	}
	if listed.Images[0]["path"] != "/pricing" {
		t.Errorf("listed path = %v, want /pricing", listed.Images[0]["path"])
	}
}

// TestPageImageReplacesRatherThanAccumulates guards the store's unique key. An
// operator recapturing a redesigned page means "this is the page now"; keeping
// both would leave the dashboard picking one arbitrarily, and would let a site's
// database grow by one capture per redesign forever.
func TestPageImageReplacesRatherThanAccumulates(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()
	c.bootstrap("owner", "correct-horse-battery")
	site := c.createWebsite("Shop", "shop.example")

	first := pngBytes(t, 200, 400)
	second := pngBytes(t, 200, 800)
	c.putBytes("/api/websites/"+site+"/page-image?path=%2F&viewport=1440", "image/png", first, true)
	res, body := c.putBytes("/api/websites/"+site+"/page-image?path=%2F&viewport=1440", "image/png", second, true)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("replace: status %d: %v", res.StatusCode, body)
	}

	var listed struct {
		Images []map[string]any `json:"images"`
	}
	c.getInto("/api/websites/"+site+"/page-images", &listed)
	if len(listed.Images) != 1 {
		t.Fatalf("after replacing, listed %d images, want 1", len(listed.Images))
	}
	if listed.Images[0]["image_h"] != float64(800) {
		t.Errorf("image_h = %v, want 800 — the replacement should win", listed.Images[0]["image_h"])
	}

	// A different viewport width is a different picture of the same page, and
	// must coexist rather than replace.
	c.putBytes("/api/websites/"+site+"/page-image?path=%2F&viewport=390", "image/png", pngBytes(t, 390, 2000), true)
	c.getInto("/api/websites/"+site+"/page-images", &listed)
	if len(listed.Images) != 2 {
		t.Fatalf("listed %d images, want 2 (one per viewport width)", len(listed.Images))
	}
}

// TestPageImageRejectsNonImages is the one that matters for safety. These bytes
// are later served from the dashboard's own origin, so "it said it was a PNG"
// can never be the thing that decides.
func TestPageImageRejectsNonImages(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()
	c.bootstrap("owner", "correct-horse-battery")
	site := c.createWebsite("Shop", "shop.example")

	cases := []struct {
		name        string
		contentType string
		body        []byte
	}{
		{"an SVG claiming to be a PNG", "image/png", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)},
		{"an HTML document", "image/png", []byte("<!doctype html><script>alert(1)</script>")},
		{"empty", "image/png", nil},
		{"random bytes", "image/png", []byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05}},
	}
	for _, tc := range cases {
		res, _ := c.putBytes("/api/websites/"+site+"/page-image?path=%2F&viewport=1440", tc.contentType, tc.body, true)
		if res.StatusCode == http.StatusOK {
			t.Errorf("%s was accepted — the format must come from decoding, not the header", tc.name)
		}
	}

	// A real JPEG mislabelled as PNG is fine and is stored as what it is: the
	// point is not to police the header, it is to never trust it.
	res, body := c.putBytes("/api/websites/"+site+"/page-image?path=%2F&viewport=1440", "image/png", jpegBytes(t, 300, 700), true)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("real JPEG rejected: status %d: %v", res.StatusCode, body)
	}
	if body["mime"] != "image/jpeg" {
		t.Errorf("stored mime = %v, want image/jpeg — the decoder decides, not the header", body["mime"])
	}
}

func TestPageImageRejectsBadKeys(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()
	c.bootstrap("owner", "correct-horse-battery")
	site := c.createWebsite("Shop", "shop.example")
	body := pngBytes(t, 200, 400)

	for _, q := range []string{
		"?viewport=1440",                  // no path
		"?path=%2F",                       // no viewport
		"?path=pricing&viewport=1440",     // path not rooted — heat samples always are
		"?path=%2F&viewport=0",            // nonsense width
		"?path=%2F&viewport=99999",        // nonsense width
		"?path=%2F&viewport=not-a-number", // nonsense width
	} {
		res, _ := c.putBytes("/api/websites/"+site+"/page-image"+q, "image/png", body, true)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("PUT %s returned %d, want 400", q, res.StatusCode)
		}
	}
}

// TestPageImageWritesAreGuarded checks the two guards a state-changing route
// gets by construction (CSRF, session) plus the one this route needs
// specifically: uploading changes what every viewer of the website sees, so it
// is an editor action, not a viewer one.
func TestPageImageWritesAreGuarded(t *testing.T) {
	ts := newTestServer(t)
	owner := ts.client()
	owner.bootstrap("owner", "correct-horse-battery")
	site := owner.createWebsite("Shop", "shop.example")
	body := pngBytes(t, 200, 400)
	path := "/api/websites/" + site + "/page-image?path=%2F&viewport=1440"

	if res, _ := owner.putBytes(path, "image/png", body, false); res.StatusCode != http.StatusForbidden {
		t.Errorf("upload without a CSRF token returned %d, want 403", res.StatusCode)
	}

	anon := ts.client()
	if res, _ := anon.putBytes(path, "image/png", body, true); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("upload with no session returned %d, want 401", res.StatusCode)
	}
	if res, _ := anon.getRaw(path, nil); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("fetching a capture with no session returned %d, want 401 — captures are site content, not public analytics", res.StatusCode)
	}

	// A signed-in user with no grant on this website must not even learn it
	// exists, so 404 rather than 403 — the same rule requireWebsite applies
	// everywhere else.
	other := ts.client()
	res, respBody := owner.do("POST", "/api/users", map[string]string{
		"username": "viewer", "password": "another-long-password", "role": "user",
	}, true)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create user: %d %v", res.StatusCode, respBody)
	}
	res, respBody = other.do("POST", "/api/auth/login", map[string]string{
		"username": "viewer", "password": "another-long-password",
	}, true)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("login: %d %v", res.StatusCode, respBody)
	}
	if res, _ := other.putBytes(path, "image/png", body, true); res.StatusCode != http.StatusNotFound {
		t.Errorf("upload by a user with no access returned %d, want 404", res.StatusCode)
	}
	if res, _ := other.getRaw(path, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("fetch by a user with no access returned %d, want 404", res.StatusCode)
	}
}

func TestPageImageDelete(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()
	c.bootstrap("owner", "correct-horse-battery")
	site := c.createWebsite("Shop", "shop.example")
	path := "/api/websites/" + site + "/page-image?path=%2F&viewport=1440"

	c.putBytes(path, "image/png", pngBytes(t, 200, 400), true)
	if res, _ := c.do("DELETE", path, nil, true); res.StatusCode != http.StatusOK {
		t.Fatalf("delete returned %d", res.StatusCode)
	}
	if res, _ := c.getRaw(path, nil); res.StatusCode != http.StatusNotFound {
		t.Errorf("after deleting, fetch returned %d, want 404", res.StatusCode)
	}
	if res, _ := c.do("DELETE", path, nil, true); res.StatusCode != http.StatusNotFound {
		t.Errorf("deleting a missing capture returned %d, want 404", res.StatusCode)
	}
}
