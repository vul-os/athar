package ingest

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"athar/backend/internal/store"
)

func TestParseUserAgent(t *testing.T) {
	cases := []struct {
		name              string
		ua                string
		browser, os, dev  string
		bot               bool
	}{
		{
			name: "chrome on macos",
			ua:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
			browser: "Chrome", os: "macOS", dev: DeviceDesktop,
		},
		{
			// Safari's UA contains neither "Chrome" nor anything distinctive
			// except the absence of everything else — the ordering of the rules
			// is what makes this come out right.
			name: "safari on macos",
			ua:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
			browser: "Safari", os: "macOS", dev: DeviceDesktop,
		},
		{
			// Edge claims to be Chrome and Safari; the Edg/ token must win.
			name: "edge is not chrome",
			ua:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0",
			browser: "Edge", os: "Windows", dev: DeviceDesktop,
		},
		{
			name: "opera is not chrome",
			ua:   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 OPR/117.0",
			browser: "Opera", os: "Windows", dev: DeviceDesktop,
		},
		{
			name: "firefox on linux",
			ua:   "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
			browser: "Firefox", os: "Linux", dev: DeviceDesktop,
		},
		{
			name: "chrome on android phone",
			ua:   "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
			browser: "Chrome", os: "Android", dev: DeviceMobile,
		},
		{
			// An Android tablet omits "Mobile" from the token.
			name: "android tablet",
			ua:   "Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
			browser: "Chrome", os: "Android", dev: DeviceTablet,
		},
		{
			name: "safari on iphone",
			ua:   "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
			browser: "Safari", os: "iOS", dev: DeviceMobile,
		},
		{name: "googlebot", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", bot: true},
		{name: "curl", ua: "curl/8.7.1", bot: true},
		{name: "go client", ua: "Go-http-client/2.0", bot: true},
		{name: "headless chrome", ua: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0", bot: true},
		{name: "empty", ua: ""},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseUserAgent(c.ua)
			if got.IsBot != c.bot {
				t.Fatalf("IsBot = %v, want %v", got.IsBot, c.bot)
			}
			if c.bot {
				return
			}
			if got.Browser != c.browser {
				t.Errorf("Browser = %q, want %q", got.Browser, c.browser)
			}
			if got.OS != c.os {
				t.Errorf("OS = %q, want %q", got.OS, c.os)
			}
			if got.Device != c.dev {
				t.Errorf("Device = %q, want %q", got.Device, c.dev)
			}
		})
	}
}

// Screen width may narrow an unknown or desktop classification, but must never
// override what the user agent stated outright.
func TestDeviceFromScreen(t *testing.T) {
	cases := []struct {
		device string
		width  int
		want   string
	}{
		{DeviceUnknown, 390, DeviceMobile},
		{DeviceUnknown, 800, DeviceTablet},
		{DeviceUnknown, 1920, DeviceDesktop},
		{DeviceDesktop, 390, DeviceMobile},
		{DeviceMobile, 1920, DeviceMobile}, // the UA said mobile; believe it
		{DeviceTablet, 390, DeviceTablet},
		{DeviceDesktop, 0, DeviceDesktop}, // no screen reported: leave alone
	}
	for _, c := range cases {
		if got := DeviceFromScreen(c.device, c.width); got != c.want {
			t.Errorf("DeviceFromScreen(%q, %d) = %q, want %q", c.device, c.width, got, c.want)
		}
	}
}

func TestParseReferrer(t *testing.T) {
	cases := []struct {
		name              string
		raw, hostname     string
		external, internal string
	}{
		{"external", "https://news.ycombinator.com/item?id=1", "example.com", "news.ycombinator.com", ""},
		{"strips www", "https://www.google.com/search?q=x", "example.com", "google.com", ""},
		// Same-site navigation is not acquisition: it must not appear as a
		// referrer, or every site becomes its own top traffic source.
		{"internal", "https://example.com/blog", "example.com", "", "/blog"},
		{"internal via www", "https://www.example.com/blog", "example.com", "", "/blog"},
		{"empty", "", "example.com", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := parseReferrer(c.raw, c.hostname)
			if got.ExternalHost != c.external {
				t.Errorf("ExternalHost = %q, want %q", got.ExternalHost, c.external)
			}
			if got.InternalPath != c.internal {
				t.Errorf("InternalPath = %q, want %q", got.InternalPath, c.internal)
			}
		})
	}
}

func TestParseUTMAndSplitURL(t *testing.T) {
	utm := parseUTM("/pricing?utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_term=x&utm_content=b")
	if utm.Source != "newsletter" || utm.Medium != "email" || utm.Campaign != "launch" ||
		utm.Term != "x" || utm.Content != "b" {
		t.Fatalf("parseUTM = %+v", utm)
	}

	cases := []struct{ in, path, query string }{
		{"/pricing?a=1", "/pricing", "a=1"},
		{"/pricing", "/pricing", ""},
		{"", "/", ""},
		{"https://example.com/deep/path?x=1", "/deep/path", "x=1"},
	}
	for _, c := range cases {
		path, query := splitURL(c.in)
		if path != c.path || query != c.query {
			t.Errorf("splitURL(%q) = %q,%q want %q,%q", c.in, path, query, c.path, c.query)
		}
	}
}

func TestNormalizeLanguage(t *testing.T) {
	cases := map[string]string{
		"en-GB":                "en-GB",
		"en-gb":                "en-GB",
		"EN":                   "en",
		"en-US,en;q=0.9,fr;q=0.8": "en-US", // a weighted list collapses to its first tag
		"":                     "",
	}
	for in, want := range cases {
		if got := normalizeLanguage(in); got != want {
			t.Errorf("normalizeLanguage(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestToMinorUnits(t *testing.T) {
	cases := map[float64]int64{
		49.99: 4999,
		0:     0,
		0.005: 1, // rounds half away from zero
		10:    1000,
		-5.5:  -550,
		// Floating point cannot represent 1.15 exactly; the result must still
		// round to the nearest cent rather than truncating to 114.
		1.15: 115,
	}
	for amount, want := range cases {
		if got := toMinorUnits(amount); got != want {
			t.Errorf("toMinorUnits(%v) = %d, want %d", amount, got, want)
		}
	}
}

// ── Privacy guarantees ────────────────────────────────────────────────────────
//
// These are the tests that matter most in this package. Each one asserts a
// property Athar's privacy claims depend on; if one of these fails, a
// documentation claim has become false.

func newTestIdentifier(t *testing.T) *Identifier {
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
	id, err := NewIdentifier(ctx, st)
	if err != nil {
		t.Fatalf("NewIdentifier: %v", err)
	}
	return id
}

func TestVisitorHashIsStableWithinADay(t *testing.T) {
	id := newTestIdentifier(t)

	morning := time.Date(2026, 7, 24, 8, 0, 0, 0, time.UTC)
	evening := time.Date(2026, 7, 24, 23, 59, 0, 0, time.UTC)

	a := id.VisitorHash("site1", "203.0.113.5", "Firefox", morning)
	b := id.VisitorHash("site1", "203.0.113.5", "Firefox", evening)
	if a != b {
		t.Fatal("the same visitor got different hashes within one UTC day")
	}
}

// The salt rotates at UTC midnight, so yesterday's hash cannot be recomputed
// today. This is what makes cross-day tracking not merely unimplemented but
// underivable from what is stored.
func TestVisitorHashRotatesDaily(t *testing.T) {
	id := newTestIdentifier(t)

	today := time.Date(2026, 7, 24, 23, 59, 59, 0, time.UTC)
	tomorrow := time.Date(2026, 7, 25, 0, 0, 1, 0, time.UTC)

	if id.VisitorHash("site1", "203.0.113.5", "Firefox", today) ==
		id.VisitorHash("site1", "203.0.113.5", "Firefox", tomorrow) {
		t.Fatal("the visitor hash did not change across the UTC day boundary")
	}
}

// The website id is inside the hash, so one operator running two sites on one
// instance cannot join them into a cross-site profile.
func TestVisitorHashIsScopedPerWebsite(t *testing.T) {
	id := newTestIdentifier(t)
	now := time.Now().UTC()

	if id.VisitorHash("site1", "203.0.113.5", "Firefox", now) ==
		id.VisitorHash("site2", "203.0.113.5", "Firefox", now) {
		t.Fatal("the same visitor produced identical hashes on two websites")
	}
}

// Distinct inputs must not collide through field concatenation: without a
// separator, ("ab","c") and ("a","bc") would hash identically.
func TestVisitorHashFieldsAreSeparated(t *testing.T) {
	id := newTestIdentifier(t)
	now := time.Now().UTC()

	if id.VisitorHash("site", "1.2.3.4", "UA", now) == id.VisitorHash("site", "1.2.3.", "4UA", now) {
		t.Fatal("adjacent fields ran together in the hash input")
	}
}

// The secret is persisted, so a restart must not re-count every returning
// visitor as new.
func TestVisitorHashSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "athar.db")
	now := time.Now().UTC()

	hashes := make([]string, 2)
	for i := range hashes {
		st, err := store.Open(ctx, path)
		if err != nil {
			t.Fatalf("open #%d: %v", i, err)
		}
		if err := st.Migrate(ctx); err != nil {
			t.Fatalf("migrate #%d: %v", i, err)
		}
		id, err := NewIdentifier(ctx, st)
		if err != nil {
			t.Fatalf("NewIdentifier #%d: %v", i, err)
		}
		hashes[i] = id.VisitorHash("site1", "203.0.113.5", "Firefox", now)
		_ = st.Close()
	}

	if hashes[0] != hashes[1] {
		t.Fatal("the visitor hash changed across a restart — the instance secret is not being persisted")
	}
}

// The hash must not be reversible to, or contain, the IP it was derived from.
func TestVisitorHashDoesNotLeakTheIP(t *testing.T) {
	id := newTestIdentifier(t)
	const ip = "203.0.113.5"

	hash := id.VisitorHash("site1", ip, "Firefox", time.Now().UTC())
	if len(hash) != 64 {
		t.Fatalf("hash is %d chars, want 64 hex chars of SHA-256", len(hash))
	}
	for _, fragment := range []string{ip, "203", "113"} {
		if contains(hash, fragment) {
			t.Fatalf("the hash %q contains the IP fragment %q", hash, fragment)
		}
	}
}

func contains(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		}()
}

func TestRateLimiter(t *testing.T) {
	rl := newRateLimiter()
	now := time.Now()

	// The burst is available immediately.
	for i := range int(rateBurst) {
		if !rl.allow("1.2.3.4", now) {
			t.Fatalf("request %d rejected while still inside the burst", i)
		}
	}
	if rl.allow("1.2.3.4", now) {
		t.Fatal("the bucket did not run out after its burst")
	}

	// A different source has its own bucket.
	if !rl.allow("5.6.7.8", now) {
		t.Fatal("a second source was throttled by the first source's bucket")
	}

	// Tokens refill over time.
	if !rl.allow("1.2.3.4", now.Add(time.Second)) {
		t.Fatal("the bucket did not refill after a second")
	}
}
