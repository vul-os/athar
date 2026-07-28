package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"athar/backend/internal/auth"
	"athar/backend/internal/config"
	"athar/backend/internal/geoip"
	"athar/backend/internal/ingest"
	"athar/backend/internal/store"
)

// testServer is a fully wired Athar API over a temporary SQLite database.
type testServer struct {
	t     *testing.T
	srv   *httptest.Server
	store store.Store
}

func newTestServer(t *testing.T) *testServer {
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

	mux := http.NewServeMux()
	New(Options{
		Store:     st,
		Sessions:  sessions,
		Collector: ingest.New(ingest.Options{Store: st, GeoIP: geo, Identifier: ident}),
		Config:    cfg,
		Version:   "test",
	}).Register(mux)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return &testServer{t: t, srv: srv, store: st}
}

// client is an HTTP client with its own cookie jar, standing in for one browser.
type client struct {
	ts      *testServer
	cookies map[string]string
}

func (ts *testServer) client() *client {
	return &client{ts: ts, cookies: map[string]string{}}
}

// do issues a request, carrying this client's cookies and echoing the CSRF token
// unless withCSRF is false (which is how the CSRF defence itself is tested).
func (c *client) do(method, path string, body any, withCSRF bool) (*http.Response, map[string]any) {
	c.ts.t.Helper()

	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			c.ts.t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	} else {
		reader = bytes.NewReader(nil)
	}

	req, err := http.NewRequest(method, c.ts.srv.URL+path, reader)
	if err != nil {
		c.ts.t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
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
		c.ts.t.Fatalf("request %s %s: %v", method, path, err)
	}
	defer res.Body.Close()

	for _, cookie := range res.Cookies() {
		if cookie.MaxAge < 0 {
			delete(c.cookies, cookie.Name)
			continue
		}
		c.cookies[cookie.Name] = cookie.Value
	}

	var payload map[string]any
	_ = json.NewDecoder(res.Body).Decode(&payload)
	return res, payload
}

// getInto performs an authenticated GET and decodes the body into target. It
// exists because `do` returns an object, and some endpoints return an array.
func (c *client) getInto(path string, target any) {
	c.ts.t.Helper()

	req, err := http.NewRequest("GET", c.ts.srv.URL+path, nil)
	if err != nil {
		c.ts.t.Fatalf("new request: %v", err)
	}
	for name, value := range c.cookies {
		req.AddCookie(&http.Cookie{Name: name, Value: value})
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.ts.t.Fatalf("GET %s: %v", path, err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		c.ts.t.Fatalf("GET %s: status %d", path, res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(target); err != nil {
		c.ts.t.Fatalf("decode %s: %v", path, err)
	}
}

// bootstrap creates the first admin and leaves the client signed in.
func (c *client) bootstrap(username, password string) map[string]any {
	c.ts.t.Helper()
	res, body := c.do("POST", "/api/auth/bootstrap", map[string]string{
		"username": username, "password": password,
	}, true)
	if res.StatusCode != http.StatusCreated {
		c.ts.t.Fatalf("bootstrap: status %d: %v", res.StatusCode, body)
	}
	return body
}

func (c *client) createWebsite(name, domain string) string {
	c.ts.t.Helper()
	res, body := c.do("POST", "/api/websites", map[string]string{"name": name, "domain": domain}, true)
	if res.StatusCode != http.StatusCreated {
		c.ts.t.Fatalf("create website: status %d: %v", res.StatusCode, body)
	}
	id, _ := body["id"].(string)
	if id == "" {
		c.ts.t.Fatalf("create website returned no id: %v", body)
	}
	return id
}

// ── Tests ─────────────────────────────────────────────────────────────────────

func TestHealthAndBootstrapFlow(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()

	res, body := c.do("GET", "/api/health", nil, false)
	if res.StatusCode != http.StatusOK || body["ok"] != true {
		t.Fatalf("health: %d %v", res.StatusCode, body)
	}

	_, status := c.do("GET", "/api/auth/status", nil, false)
	if status["needs_setup"] != true {
		t.Fatalf("a fresh instance should need setup: %v", status)
	}

	c.bootstrap("ada", "correct-horse-battery")

	_, status = c.do("GET", "/api/auth/status", nil, false)
	if status["needs_setup"] != false || status["authenticated"] != true {
		t.Fatalf("after bootstrap: %v", status)
	}

	// Bootstrap must not be usable a second time — it is the one endpoint that
	// creates an account without an existing one.
	other := ts.client()
	res, _ = other.do("POST", "/api/auth/bootstrap", map[string]string{
		"username": "mallory", "password": "another-long-password",
	}, true)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("second bootstrap returned %d, want 403", res.StatusCode)
	}
}

// The public health probe must answer liveness and nothing else. The build
// version tells an anonymous scanner which advisories apply to this box, and
// the storage engine is the Store seam's private vocabulary — neither belongs
// in a response anyone on the internet can fetch.
func TestPublicHealthDoesNotFingerprintTheInstance(t *testing.T) {
	ts := newTestServer(t)
	anon := ts.client()

	res, body := anon.do("GET", "/api/health", nil, false)
	if res.StatusCode != http.StatusOK || body["ok"] != true {
		t.Fatalf("health: %d %v", res.StatusCode, body)
	}
	for _, field := range []string{"version", "store"} {
		if _, leaked := body[field]; leaked {
			t.Errorf("public /api/health leaks %q to an anonymous caller: %v", field, body)
		}
	}

	// The same fields are still available to an operator who is logged in —
	// this is a scope change, not a removal.
	c := ts.client()
	c.bootstrap("ada", "correct-horse-battery")
	_, authed := c.do("GET", "/api/health", nil, false)
	if authed["version"] != "test" {
		t.Errorf("authenticated /api/health lost the version field: %v", authed)
	}
	if authed["store"] != "sqlite" {
		t.Errorf("authenticated /api/health lost the store field: %v", authed)
	}
}

func TestWeakPasswordRejected(t *testing.T) {
	ts := newTestServer(t)
	res, body := ts.client().do("POST", "/api/auth/bootstrap", map[string]string{
		"username": "ada", "password": "short",
	}, true)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("short password accepted: %d %v", res.StatusCode, body)
	}
}

// Login must answer identically for an unknown user and a wrong password, or the
// difference enumerates valid usernames.
func TestLoginDoesNotRevealWhetherAUserExists(t *testing.T) {
	ts := newTestServer(t)
	ts.client().bootstrap("ada", "correct-horse-battery")

	c := ts.client()
	resUnknown, bodyUnknown := c.do("POST", "/api/auth/login", map[string]string{
		"username": "nobody", "password": "correct-horse-battery",
	}, false)
	resWrong, bodyWrong := c.do("POST", "/api/auth/login", map[string]string{
		"username": "ada", "password": "wrong-password-entirely",
	}, false)

	if resUnknown.StatusCode != resWrong.StatusCode {
		t.Errorf("status differs: unknown user %d, wrong password %d", resUnknown.StatusCode, resWrong.StatusCode)
	}
	if bodyUnknown["error"] != bodyWrong["error"] {
		t.Errorf("message differs: %q vs %q", bodyUnknown["error"], bodyWrong["error"])
	}
}

func TestUnauthenticatedRequestsAreRejected(t *testing.T) {
	ts := newTestServer(t)
	ts.client().bootstrap("ada", "correct-horse-battery")

	anon := ts.client()
	for _, path := range []string{"/api/me", "/api/websites", "/api/users"} {
		res, _ := anon.do("GET", path, nil, false)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s returned %d, want 401", path, res.StatusCode)
		}
	}
}

// The CSRF check lives in the middleware, so it must cover every state-changing
// route — including ones added later without a per-handler check.
func TestCSRFRequiredOnStateChangingRoutes(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()
	c.bootstrap("ada", "correct-horse-battery")

	res, _ := c.do("POST", "/api/websites", map[string]string{
		"name": "Demo", "domain": "demo.example",
	}, false) // valid session, no CSRF header
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("POST without CSRF returned %d, want 403", res.StatusCode)
	}

	// The same request with the token succeeds, proving the rejection above was
	// the CSRF check and not something else.
	res, _ = c.do("POST", "/api/websites", map[string]string{
		"name": "Demo", "domain": "demo.example",
	}, true)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("POST with CSRF returned %d, want 201", res.StatusCode)
	}

	// Safe methods must not require it.
	if res, _ := c.do("GET", "/api/websites", nil, false); res.StatusCode != http.StatusOK {
		t.Errorf("GET with no CSRF header returned %d, want 200", res.StatusCode)
	}
}

func TestSessionCookieIsHttpOnlyAndCSRFCookieIsNot(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()

	req, _ := http.NewRequest("POST", ts.srv.URL+"/api/auth/bootstrap",
		strings.NewReader(`{"username":"ada","password":"correct-horse-battery"}`))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	var session, csrf *http.Cookie
	for _, cookie := range res.Cookies() {
		switch cookie.Name {
		case auth.SessionCookie:
			session = cookie
		case auth.CSRFCookie:
			csrf = cookie
		}
	}
	if session == nil || csrf == nil {
		t.Fatalf("expected both cookies, got %v", res.Cookies())
	}
	if !session.HttpOnly {
		t.Error("the session cookie is not HttpOnly — XSS could exfiltrate it")
	}
	if csrf.HttpOnly {
		t.Error("the CSRF cookie is HttpOnly — the dashboard cannot read it to echo it back")
	}
	if session.SameSite != http.SameSiteLaxMode {
		t.Errorf("session cookie SameSite = %v, want Lax", session.SameSite)
	}
	_ = c
}

// One user must not reach another user's website, and the refusal must be a 404
// rather than a 403 — a 403 confirms the id exists.
func TestCrossTenantAccessIsDeniedAsNotFound(t *testing.T) {
	ts := newTestServer(t)

	admin := ts.client()
	admin.bootstrap("ada", "correct-horse-battery")
	siteID := admin.createWebsite("Private", "private.example")

	// A second, non-admin user created by the admin.
	res, _ := admin.do("POST", "/api/users", map[string]string{
		"username": "mallory", "password": "another-long-password", "role": "user",
	}, true)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create user: %d", res.StatusCode)
	}

	mallory := ts.client()
	if res, _ := mallory.do("POST", "/api/auth/login", map[string]string{
		"username": "mallory", "password": "another-long-password",
	}, false); res.StatusCode != http.StatusOK {
		t.Fatalf("login as mallory: %d", res.StatusCode)
	}

	for _, path := range []string{
		"/api/websites/" + siteID,
		"/api/websites/" + siteID + "/stats",
		"/api/websites/" + siteID + "/metrics?metric=path",
	} {
		res, _ := mallory.do("GET", path, nil, false)
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s as a non-owner returned %d, want 404", path, res.StatusCode)
		}
	}

	// And they see an empty list rather than someone else's sites.
	var sites []map[string]any
	mallory.getInto("/api/websites", &sites)
	if len(sites) != 0 {
		t.Errorf("a non-owner sees %d websites, want 0", len(sites))
	}

	// A non-admin must not reach admin routes at all.
	if res, _ := mallory.do("GET", "/api/users", nil, false); res.StatusCode != http.StatusForbidden {
		t.Errorf("non-admin GET /api/users returned %d, want 403", res.StatusCode)
	}
}

// A share link grants read-only access to exactly one website. It must not be
// pivotable into another site's data, and revoking it must actually revoke.
func TestShareLinkScopeAndRevocation(t *testing.T) {
	ts := newTestServer(t)
	admin := ts.client()
	admin.bootstrap("ada", "correct-horse-battery")

	sharedID := admin.createWebsite("Shared", "shared.example")
	secretID := admin.createWebsite("Secret", "secret.example")

	res, body := admin.do("POST", "/api/websites/"+sharedID+"/share", map[string]bool{"enabled": true}, true)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("enable share: %d", res.StatusCode)
	}
	shareID, _ := body["share_id"].(string)
	if shareID == "" {
		t.Fatalf("no share id returned: %v", body)
	}

	anon := ts.client()
	res, shared := anon.do("GET", "/api/share/"+shareID, nil, false)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("public share read returned %d", res.StatusCode)
	}
	if shared["name"] != "Shared" {
		t.Errorf("share returned the wrong website: %v", shared)
	}
	// The internal id and owner must not leak, or a share link becomes a handle
	// on the authenticated API.
	if _, leaked := shared["id"]; leaked {
		t.Error("the share response exposed the website's internal id")
	}
	if _, leaked := shared["owner_id"]; leaked {
		t.Error("the share response exposed the owner id")
	}

	if res, _ := anon.do("GET", "/api/share/"+shareID+"/stats", nil, false); res.StatusCode != http.StatusOK {
		t.Errorf("public share stats returned %d, want 200", res.StatusCode)
	}

	// The unshared site stays unreachable, by share id or by website id.
	if res, _ := anon.do("GET", "/api/share/"+secretID, nil, false); res.StatusCode != http.StatusNotFound {
		t.Errorf("an unshared website id resolved as a share id: %d", res.StatusCode)
	}
	if res, _ := anon.do("GET", "/api/websites/"+secretID, nil, false); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("unauthenticated website read returned %d, want 401", res.StatusCode)
	}

	// Revoking must invalidate the old link, and re-enabling must mint a new
	// one rather than resurrecting it.
	if res, _ := admin.do("POST", "/api/websites/"+sharedID+"/share", map[string]bool{"enabled": false}, true); res.StatusCode != http.StatusOK {
		t.Fatalf("disable share: %d", res.StatusCode)
	}
	if res, _ := anon.do("GET", "/api/share/"+shareID, nil, false); res.StatusCode != http.StatusNotFound {
		t.Errorf("a revoked share link still resolves: %d", res.StatusCode)
	}

	_, body = admin.do("POST", "/api/websites/"+sharedID+"/share", map[string]bool{"enabled": true}, true)
	if newShareID, _ := body["share_id"].(string); newShareID == shareID {
		t.Error("re-enabling sharing reused the revoked id — revocation is not permanent")
	}
}

// The metric name selects a fixed query, so anything unrecognised must be
// rejected before it reaches the database.
func TestUnknownMetricIsRejected(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()
	c.bootstrap("ada", "correct-horse-battery")
	siteID := c.createWebsite("Demo", "demo.example")

	for _, metric := range []string{"", "nonsense", "'; DROP TABLE users; --", "url_path"} {
		res, _ := c.do("GET", "/api/websites/"+siteID+"/metrics?metric="+metric, nil, false)
		if res.StatusCode != http.StatusBadRequest {
			t.Errorf("metric %q returned %d, want 400", metric, res.StatusCode)
		}
	}

	// The users table must still be there.
	if n, err := ts.store.CountUsers(context.Background()); err != nil || n != 1 {
		t.Fatalf("users table damaged: n=%d err=%v", n, err)
	}
}

// A range that would scan the whole table must be refused, since an
// unauthenticated share link can reach the same query.
func TestRangeIsBounded(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()
	c.bootstrap("ada", "correct-horse-battery")
	siteID := c.createWebsite("Demo", "demo.example")

	// Ten years.
	res, _ := c.do("GET", "/api/websites/"+siteID+"/stats?from=0&to=315360000000", nil, false)
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("a ten-year range returned %d, want 400", res.StatusCode)
	}

	// An inverted range is also a 400, not an empty success.
	res, _ = c.do("GET", "/api/websites/"+siteID+"/stats?from=2000&to=1000", nil, false)
	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("an inverted range returned %d, want 400", res.StatusCode)
	}
}

// Changing a password must evict every other session for that user.
func TestPasswordChangeInvalidatesOtherSessions(t *testing.T) {
	ts := newTestServer(t)

	first := ts.client()
	first.bootstrap("ada", "correct-horse-battery")

	second := ts.client()
	if res, _ := second.do("POST", "/api/auth/login", map[string]string{
		"username": "ada", "password": "correct-horse-battery",
	}, false); res.StatusCode != http.StatusOK {
		t.Fatalf("second login: %d", res.StatusCode)
	}
	if res, _ := second.do("GET", "/api/me", nil, false); res.StatusCode != http.StatusOK {
		t.Fatalf("second session not usable: %d", res.StatusCode)
	}

	if res, body := first.do("POST", "/api/me/password", map[string]string{
		"current": "correct-horse-battery", "new": "a-brand-new-long-password",
	}, true); res.StatusCode != http.StatusOK {
		t.Fatalf("password change: %d %v", res.StatusCode, body)
	}

	if res, _ := second.do("GET", "/api/me", nil, false); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("the other session survived a password change: %d", res.StatusCode)
	}
}

func TestLogoutClearsTheSession(t *testing.T) {
	ts := newTestServer(t)
	c := ts.client()
	c.bootstrap("ada", "correct-horse-battery")

	if res, _ := c.do("POST", "/api/auth/logout", nil, true); res.StatusCode != http.StatusOK {
		t.Fatalf("logout: %d", res.StatusCode)
	}
	if res, _ := c.do("GET", "/api/me", nil, false); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("the session survived logout: %d", res.StatusCode)
	}
}
