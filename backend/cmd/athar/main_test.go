package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"athar/backend/internal/auth"
	"athar/backend/internal/config"
	"athar/backend/internal/geoip"
	"athar/backend/internal/ingest"
	"athar/backend/internal/store"
)

// newTestServer wires up exactly what run() wires up — the same newServer()
// — over a temporary SQLite database, so these tests exercise the real
// routing, auth, CSRF and security-header stack a deployment gets, not a
// hand-assembled subset of it.
func newTestServer(t *testing.T) (*httptest.Server, store.Store) {
	t.Helper()
	ctx := context.Background()

	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "athar.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	ident, err := ingest.NewIdentifier(ctx, st)
	if err != nil {
		t.Fatalf("identifier: %v", err)
	}
	geo, _ := geoip.New("")
	cfg := config.Default()
	sessions := auth.NewManager(auth.ManagerOptions{Store: st})
	collector := ingest.New(ingest.Options{Store: st, GeoIP: geo, Identifier: ident})

	trackerHandler, err := newNoopTracker()
	if err != nil {
		t.Fatalf("tracker: %v", err)
	}

	handler := newServer(cfg, st, sessions, collector, trackerHandler, "test")
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv, st
}

// newNoopTracker stands in for tracker.New() — the tracker package's own
// tests cover its embedded assets; this test only needs its route mounted
// and answering, not its exact bytes.
func newNoopTracker() (http.Handler, error) {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		_, _ = w.Write([]byte("/* tracker */"))
	}), nil
}

// ── The dashboard is served ──────────────────────────────────────────────────

func TestDashboardIsServed(t *testing.T) {
	srv, _ := newTestServer(t)

	res, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Errorf("GET / Content-Type = %q, want text/html", ct)
	}

	body := readAll(t, res)
	for _, want := range []string{"<title>Athar</title>", `href="/ui.css"`, `src="/app.js"`} {
		if !strings.Contains(body, want) {
			t.Errorf("index.html does not contain %q", want)
		}
	}
}

// TestDashboardAssetsAreServed checks every asset index.html actually
// references is reachable at that exact path with a sane content type — the
// property a broken go:embed pattern or a renamed file would silently
// violate.
func TestDashboardAssetsAreServed(t *testing.T) {
	srv, _ := newTestServer(t)

	cases := []struct {
		path     string
		wantType string
	}{
		{"/ui.css", "text/css"},
		{"/app.js", "javascript"},
		{"/format.js", "javascript"},
		{"/countries.js", "javascript"},
		{"/theme.js", "javascript"},
		{"/theme-init.js", "javascript"},
		{"/api.js", "javascript"},
		{"/chart.js", "javascript"},
		{"/heatmap.js", "javascript"},
		{"/heatcanvas.js", "javascript"},
		{"/dom.js", "javascript"},
	}
	for _, c := range cases {
		res, err := http.Get(srv.URL + c.path)
		if err != nil {
			t.Fatalf("GET %s: %v", c.path, err)
		}
		body := readAll(t, res)
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", c.path, res.StatusCode)
		}
		if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, c.wantType) {
			t.Errorf("GET %s Content-Type = %q, want to contain %q", c.path, ct, c.wantType)
		}
		if len(body) == 0 {
			t.Errorf("GET %s returned an empty body", c.path)
		}
	}
}

// TestUnknownPathIs404 pins down that the dashboard is a bare file server,
// not an SPA catch-all: it has no client-side routing, so an unmatched path
// must 404 rather than silently serving index.html.
func TestUnknownPathIs404(t *testing.T) {
	srv, _ := newTestServer(t)

	res, err := http.Get(srv.URL + "/this-path-does-not-exist")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("GET /this-path-does-not-exist = %d, want 404", res.StatusCode)
	}
}

// ── Security headers apply to the dashboard, not just the API ───────────────

func TestSecurityHeadersOnDashboard(t *testing.T) {
	srv, _ := newTestServer(t)

	res, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	defer res.Body.Close()

	checks := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
	}
	for header, want := range checks {
		if got := res.Header.Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	csp := res.Header.Get("Content-Security-Policy")
	if csp == "" {
		t.Fatal("Content-Security-Policy header is missing")
	}
	// script-src must never weaken to 'unsafe-inline': ui.css is an external
	// stylesheet and app.js an external module, so no inline <script> is ever
	// needed, and allowing one would open the door to injected markup
	// executing as code. style-src legitimately keeps 'unsafe-inline' — the
	// dashboard sets the style="" *attribute* directly (element.style, never
	// innerHTML) for per-element, data-dependent values a fixed set of CSS
	// classes cannot express: a bar's width, a tooltip's position, a
	// heatmap wireframe box's coordinates.
	for _, directive := range strings.Split(csp, ";") {
		directive = strings.TrimSpace(directive)
		if strings.HasPrefix(directive, "script-src") && strings.Contains(directive, "'unsafe-inline'") {
			t.Errorf("script-src allows 'unsafe-inline': %q — this would let injected markup execute as script", directive)
		}
	}
	if !strings.Contains(csp, "script-src 'self'") {
		t.Errorf("CSP does not pin script-src to 'self': %q", csp)
	}
}

// ── Auth cannot be bypassed ───────────────────────────────────────────────────

func TestProtectedAPIRejectsNoSession(t *testing.T) {
	srv, _ := newTestServer(t)

	res, err := http.Get(srv.URL + "/api/websites")
	if err != nil {
		t.Fatalf("GET /api/websites: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET /api/websites with no session = %d, want 401", res.StatusCode)
	}
}

func TestProtectedAPIRejectsForgedSessionCookie(t *testing.T) {
	srv, _ := newTestServer(t)

	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/websites", nil)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: "not-a-real-session-token"})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /api/websites: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET /api/websites with a forged cookie = %d, want 401", res.StatusCode)
	}
}

// TestCSRFIsEnforcedOnMutation signs in for real, then checks a mutating
// request without the CSRF header is rejected even though the session
// cookie alone would authenticate it — the double-submit defence api.js
// relies on (see backend/internal/webui/static/api.js: every non-GET
// request echoes the athar_csrf cookie in X-Athar-CSRF).
func TestCSRFIsEnforcedOnMutation(t *testing.T) {
	srv, st := newTestServer(t)
	_ = st

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	bootstrap := mustJSON(t, map[string]string{"username": "admin", "password": "correct-horse-battery-staple"})
	res, err := client.Post(srv.URL+"/api/auth/bootstrap", "application/json", bootstrap)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("bootstrap status = %d, want 201", res.StatusCode)
	}

	// The session cookie is now in the jar; a mutating request WITHOUT the
	// CSRF header must still be rejected.
	body := mustJSON(t, map[string]string{"name": "Example", "domain": "example.com"})
	res, err = client.Post(srv.URL+"/api/websites", "application/json", body)
	if err != nil {
		t.Fatalf("create website: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("POST /api/websites without CSRF header = %d, want 403", res.StatusCode)
	}

	// The same request WITH the CSRF header (read from the readable
	// athar_csrf cookie, exactly as api.js does) must succeed.
	var csrfToken string
	for _, c := range jar.Cookies(mustURL(t, srv.URL)) {
		if c.Name == auth.CSRFCookie {
			csrfToken = c.Value
		}
	}
	if csrfToken == "" {
		t.Fatal("no athar_csrf cookie was set after bootstrap")
	}
	body = mustJSON(t, map[string]string{"name": "Example", "domain": "example.com"})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/websites", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(auth.CSRFHeader, csrfToken)
	res2, err := client.Do(req)
	if err != nil {
		t.Fatalf("create website with CSRF: %v", err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusCreated {
		t.Errorf("POST /api/websites with CSRF header = %d, want 201", res2.StatusCode)
	}
}

// ── The API contract the dashboard depends on ────────────────────────────────
//
// backend/internal/webui/static/api.js hardcodes these paths; if a route is
// renamed here without updating there, the dashboard breaks silently (a
// fetch() to a 404 that the UI swallows into a generic error). This pins the
// contract from the server side.

func TestAPIContractPathsExist(t *testing.T) {
	srv, _ := newTestServer(t)

	// Public, unauthenticated: must not 404 (they may still error on bad
	// input, but the route itself must be mounted).
	publicGets := []string{"/api/health", "/api/auth/status"}
	for _, p := range publicGets {
		res, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		res.Body.Close()
		if res.StatusCode == http.StatusNotFound {
			t.Errorf("GET %s = 404 — api.js depends on this route existing", p)
		}
	}

	// Authenticated routes the dashboard calls per-website: unauthenticated
	// access must be 401 (proving the route is mounted and guarded), never
	// 404 (which would mean the route itself is missing).
	protected := []string{
		"/api/me",
		"/api/websites",
		"/api/websites/x/stats",
		"/api/websites/x/series",
		"/api/websites/x/metrics",
		"/api/websites/x/active",
		"/api/websites/x/heatmap",
		"/api/websites/x/revenue",
	}
	for _, p := range protected {
		res, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s (no session) = %d, want 401 (route must exist and be guarded)", p, res.StatusCode)
		}
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func readAll(t *testing.T, res *http.Response) string {
	t.Helper()
	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := res.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return sb.String()
}

func mustJSON(t *testing.T, v any) *strings.Reader {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return strings.NewReader(string(b))
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	return u
}
