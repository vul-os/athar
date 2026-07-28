package store

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTestStore opens a migrated SQLite store in a temp directory. A file rather
// than :memory: because Athar's SQLite DSN turns on WAL and foreign keys, and
// those are exactly the behaviours worth exercising.
func newTestStore(t *testing.T) Store {
	t.Helper()
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "athar.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return s
}

// seedSite creates a user and a website, returning both IDs.
func seedSite(t *testing.T, s Store) (userID, siteID string) {
	t.Helper()
	ctx := context.Background()
	u := &User{Username: "owner", PasswordHash: "x", Role: RoleAdmin}
	if err := s.CreateUser(ctx, u); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	w := &Website{Name: "Example", Domain: "example.com", OwnerID: u.ID}
	if err := s.CreateWebsite(ctx, w); err != nil {
		t.Fatalf("CreateWebsite: %v", err)
	}
	return u.ID, w.ID
}

func TestMigrateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "athar.db")

	for i := range 3 {
		s, err := Open(ctx, path)
		if err != nil {
			t.Fatalf("Open #%d: %v", i, err)
		}
		if err := s.Migrate(ctx); err != nil {
			t.Fatalf("Migrate #%d: %v", i, err)
		}
		_ = s.Close()
	}
}

func TestUserRoundTripAndConflict(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)

	u := &User{Username: "ada", PasswordHash: "$argon2id$…", Role: RoleAdmin}
	if err := s.CreateUser(ctx, u); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if u.ID == "" {
		t.Fatal("CreateUser did not assign an ID")
	}

	got, err := s.GetUserByUsername(ctx, "ada")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if got.ID != u.ID || got.Role != RoleAdmin || got.PasswordHash != u.PasswordHash {
		t.Fatalf("round trip mismatch: %+v", got)
	}
	if got.CreatedAt.IsZero() {
		t.Error("CreatedAt did not survive the millisecond round trip")
	}

	// A duplicate username must surface as ErrConflict, not a driver error.
	err = s.CreateUser(ctx, &User{Username: "ada", PasswordHash: "y", Role: RoleUser})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate username: got %v, want ErrConflict", err)
	}

	if _, err := s.GetUserByUsername(ctx, "nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing user: got %v, want ErrNotFound", err)
	}
}

func TestWebsiteAccess(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	ownerID, siteID := seedSite(t, s)

	// Ownership implies the owner role without a website_users row.
	role, err := s.GetWebsiteRole(ctx, siteID, ownerID)
	if err != nil || role != WebsiteRoleOwner {
		t.Fatalf("owner role: got %q, %v", role, err)
	}

	other := &User{Username: "grace", PasswordHash: "x", Role: RoleUser}
	if err := s.CreateUser(ctx, other); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetWebsiteRole(ctx, siteID, other.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ungranted user: got %v, want ErrNotFound", err)
	}

	if err := s.GrantWebsite(ctx, WebsiteGrant{WebsiteID: siteID, UserID: other.ID, Role: WebsiteRoleViewer}); err != nil {
		t.Fatalf("GrantWebsite: %v", err)
	}
	// Re-granting must change the role rather than fail on the composite key.
	if err := s.GrantWebsite(ctx, WebsiteGrant{WebsiteID: siteID, UserID: other.ID, Role: WebsiteRoleEditor}); err != nil {
		t.Fatalf("re-GrantWebsite: %v", err)
	}
	role, err = s.GetWebsiteRole(ctx, siteID, other.ID)
	if err != nil || role != WebsiteRoleEditor {
		t.Fatalf("regranted role: got %q, %v", role, err)
	}

	sites, err := s.ListWebsitesForUser(ctx, other.ID, false)
	if err != nil || len(sites) != 1 || sites[0].ID != siteID {
		t.Fatalf("granted site not listed: %v, %v", sites, err)
	}
}

// Sharing is off by default (share_id = ”), and the empty-string lookup must
// never resolve — otherwise every unshared site would be publicly readable.
func TestEmptyShareIDNeverResolves(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	seedSite(t, s)

	if _, err := s.GetWebsiteByShareID(ctx, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty share id: got %v, want ErrNotFound", err)
	}
}

func TestIngestAndReporting(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	_, siteID := seedSite(t, s)

	base := time.Date(2026, 7, 24, 10, 0, 0, 0, time.UTC)

	// Visitor A: two pageviews over 90 seconds → not a bounce.
	a := &Visit{
		WebsiteID: siteID, VisitorHash: "hash-a",
		Browser: "firefox", OS: "linux", Device: "desktop", Country: "KE",
		Referrer: "news.example", UTMSource: "newsletter",
		FirstAt: base, LastAt: base.Add(90 * time.Second), Views: 2,
	}
	if err := s.CreateVisit(ctx, a); err != nil {
		t.Fatalf("CreateVisit a: %v", err)
	}
	for i, path := range []string{"/", "/pricing"} {
		e := &Event{
			WebsiteID: siteID, VisitID: a.ID, Type: EventTypePageview,
			URLPath: path, CreatedAt: base.Add(time.Duration(i) * 90 * time.Second),
		}
		if err := s.CreateEvent(ctx, e); err != nil {
			t.Fatalf("CreateEvent: %v", err)
		}
	}

	// Visitor B: one pageview → a bounce.
	b := &Visit{
		WebsiteID: siteID, VisitorHash: "hash-b",
		Browser: "chrome", OS: "android", Device: "mobile", Country: "DE",
		FirstAt: base.Add(time.Minute), LastAt: base.Add(time.Minute), Views: 1,
	}
	if err := s.CreateVisit(ctx, b); err != nil {
		t.Fatalf("CreateVisit b: %v", err)
	}
	if err := s.CreateEvent(ctx, &Event{
		WebsiteID: siteID, VisitID: b.ID, Type: EventTypePageview,
		URLPath: "/", CreatedAt: base.Add(time.Minute),
	}); err != nil {
		t.Fatal(err)
	}

	rg := Range{From: base.Add(-time.Hour), To: base.Add(time.Hour)}

	sum, err := s.Summary(ctx, siteID, rg)
	if err != nil {
		t.Fatalf("Summary: %v", err)
	}
	if sum.Pageviews != 3 {
		t.Errorf("Pageviews = %d, want 3", sum.Pageviews)
	}
	if sum.Visits != 2 || sum.Visitors != 2 {
		t.Errorf("Visits/Visitors = %d/%d, want 2/2", sum.Visits, sum.Visitors)
	}
	if sum.Bounces != 1 {
		t.Errorf("Bounces = %d, want 1", sum.Bounces)
	}
	if got := sum.BounceRate(); got != 0.5 {
		t.Errorf("BounceRate = %v, want 0.5", got)
	}
	if got := sum.AvgVisitSec(); got != 45 {
		t.Errorf("AvgVisitSec = %v, want 45 (90s + 0s over 2 visits)", got)
	}

	// Top pages counts pageviews: "/" twice, "/pricing" once.
	top, err := s.TopMetrics(ctx, siteID, rg, MetricPath, 10)
	if err != nil {
		t.Fatalf("TopMetrics(path): %v", err)
	}
	if len(top) != 2 || top[0].Value != "/" || top[0].Count != 2 {
		t.Fatalf("top pages = %+v, want / at 2 first", top)
	}

	// Visit-scoped dimensions count sessions, and skip empty values — visitor B
	// has no referrer, so exactly one row should come back.
	refs, err := s.TopMetrics(ctx, siteID, rg, MetricReferrer, 10)
	if err != nil {
		t.Fatalf("TopMetrics(referrer): %v", err)
	}
	if len(refs) != 1 || refs[0].Value != "news.example" {
		t.Fatalf("referrers = %+v, want only news.example", refs)
	}

	// Entry page is each session's first pageview: "/" for both visitors.
	entry, err := s.TopMetrics(ctx, siteID, rg, MetricEntryPath, 10)
	if err != nil {
		t.Fatalf("TopMetrics(entry): %v", err)
	}
	if len(entry) != 1 || entry[0].Value != "/" || entry[0].Count != 2 {
		t.Fatalf("entry pages = %+v, want / at 2", entry)
	}

	// Exit page: "/pricing" for A, "/" for B.
	exit, err := s.TopMetrics(ctx, siteID, rg, MetricExitPath, 10)
	if err != nil {
		t.Fatalf("TopMetrics(exit): %v", err)
	}
	if len(exit) != 2 {
		t.Fatalf("exit pages = %+v, want 2 rows", exit)
	}

	// Hour buckets: everything above lands in the same hour.
	series, err := s.Series(ctx, siteID, rg, IntervalHour)
	if err != nil {
		t.Fatalf("Series: %v", err)
	}
	if len(series) != 1 || series[0].Pageviews != 3 || series[0].Visitors != 2 {
		t.Fatalf("series = %+v, want one bucket with 3 views / 2 visitors", series)
	}

	if _, err := s.TopMetrics(ctx, siteID, rg, "'; DROP TABLE users; --", 10); err == nil {
		t.Fatal("unknown metric name was accepted; it must be rejected before reaching SQL")
	}
}

func TestHeatSamplesAndRevenue(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	_, siteID := seedSite(t, s)

	base := time.Date(2026, 7, 24, 10, 0, 0, 0, time.UTC)
	v := &Visit{WebsiteID: siteID, VisitorHash: "h", FirstAt: base, LastAt: base, Views: 1}
	if err := s.CreateVisit(ctx, v); err != nil {
		t.Fatal(err)
	}

	samples := []HeatSample{
		{WebsiteID: siteID, VisitID: v.ID, URLPath: "/", Kind: HeatClick,
			XPct: 50.5, YPct: 12.25, ViewportW: 1440, ViewportH: 900,
			Selector: "main > button.cta", CreatedAt: base},
		{WebsiteID: siteID, VisitID: v.ID, URLPath: "/", Kind: HeatScroll,
			ScrollPct: 82.5, CreatedAt: base.Add(time.Second)},
	}
	if err := s.CreateHeatSamples(ctx, samples); err != nil {
		t.Fatalf("CreateHeatSamples: %v", err)
	}

	rg := Range{From: base.Add(-time.Hour), To: base.Add(time.Hour)}
	clicks, err := s.HeatSamples(ctx, siteID, "/", HeatClick, rg, 100)
	if err != nil {
		t.Fatalf("HeatSamples: %v", err)
	}
	if len(clicks) != 1 {
		t.Fatalf("clicks = %d, want 1 (scroll samples must not be returned)", len(clicks))
	}
	if clicks[0].XPct != 50.5 || clicks[0].YPct != 12.25 {
		t.Errorf("fractional percentages lost: %+v", clicks[0])
	}
	if clicks[0].Selector != "main > button.cta" {
		t.Errorf("selector = %q", clicks[0].Selector)
	}

	for _, r := range []Revenue{
		{WebsiteID: siteID, VisitID: v.ID, OrderID: "A1", Currency: "USD", AmountMinor: 4999, CreatedAt: base},
		{WebsiteID: siteID, VisitID: v.ID, OrderID: "A2", Currency: "USD", AmountMinor: 1500, CreatedAt: base},
		{WebsiteID: siteID, VisitID: v.ID, OrderID: "A3", Currency: "EUR", AmountMinor: 2000, CreatedAt: base},
	} {
		if err := s.CreateRevenue(ctx, &r); err != nil {
			t.Fatalf("CreateRevenue: %v", err)
		}
	}

	rev, err := s.RevenueSummary(ctx, siteID, rg)
	if err != nil {
		t.Fatalf("RevenueSummary: %v", err)
	}
	// Currencies must stay separate — a combined total would be meaningless.
	if rev["USD"] != 6499 || rev["EUR"] != 2000 || len(rev) != 2 {
		t.Fatalf("revenue = %v, want USD 6499 and EUR 2000", rev)
	}
}

// Retention deletes by session and relies on ON DELETE CASCADE to take the
// events, heatmap samples and revenue with it. SQLite only enforces that with
// the foreign_keys pragma on, so this also guards the DSN.
func TestPurgeCascades(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	_, siteID := seedSite(t, s)

	old := time.Now().UTC().Add(-90 * 24 * time.Hour)
	v := &Visit{WebsiteID: siteID, VisitorHash: "old", FirstAt: old, LastAt: old, Views: 1}
	if err := s.CreateVisit(ctx, v); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateEvent(ctx, &Event{
		WebsiteID: siteID, VisitID: v.ID, Type: EventTypePageview, URLPath: "/", CreatedAt: old,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateHeatSamples(ctx, []HeatSample{
		{WebsiteID: siteID, VisitID: v.ID, URLPath: "/", Kind: HeatClick, CreatedAt: old},
	}); err != nil {
		t.Fatal(err)
	}

	n, err := s.PurgeBefore(ctx, siteID, time.Now().UTC().Add(-30*24*time.Hour))
	if err != nil {
		t.Fatalf("PurgeBefore: %v", err)
	}
	if n != 1 {
		t.Fatalf("purged %d visits, want 1", n)
	}

	rg := Range{From: old.Add(-time.Hour), To: time.Now().UTC().Add(time.Hour)}
	sum, err := s.Summary(ctx, siteID, rg)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Pageviews != 0 {
		t.Errorf("events survived the cascade: %d pageviews remain", sum.Pageviews)
	}
	heat, err := s.HeatSamples(ctx, siteID, "/", HeatClick, rg, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(heat) != 0 {
		t.Errorf("heat samples survived the cascade: %d remain", len(heat))
	}

	// An unset retention setting must never be read as "delete everything".
	if _, err := s.PurgeBefore(ctx, siteID, time.Time{}); err == nil {
		t.Error("PurgeBefore accepted a zero cutoff; it must refuse")
	}
}

func TestRebindDollar(t *testing.T) {
	cases := []struct{ in, want string }{
		{"SELECT ? , ?", "SELECT $1 , $2"},
		{"WHERE a = ? AND b <> ''", "WHERE a = $1 AND b <> ''"},
		// A literal question mark inside a string must not be renumbered.
		{"WHERE a = '?' AND b = ?", "WHERE a = '?' AND b = $1"},
		{"WHERE a = 'it''s ?' AND b = ?", "WHERE a = 'it''s ?' AND b = $1"},
	}
	for _, c := range cases {
		if got := rebindDollar(c.in); got != c.want {
			t.Errorf("rebindDollar(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The schema's comments contain semicolons and nearly every column carries a
// DEFAULT ” literal, so the migration splitter has to know about both.
func TestSplitStatements(t *testing.T) {
	body := `
-- a comment; with a semicolon in it
CREATE TABLE a (x TEXT NOT NULL DEFAULT '');
CREATE TABLE b (y TEXT NOT NULL DEFAULT 'it''s; fine'); -- trailing comment;
`
	got := splitStatements(body)
	if len(got) != 2 {
		t.Fatalf("got %d statements, want 2: %#v", len(got), got)
	}
	if !strings.HasPrefix(got[0], "CREATE TABLE a") {
		t.Errorf("first statement = %q", got[0])
	}
	if !strings.Contains(got[1], "'it''s; fine'") {
		t.Errorf("escaped literal was mangled: %q", got[1])
	}
}

func TestNormalizeDSN(t *testing.T) {
	cases := []struct{ in, engine, rest string }{
		{"", "sqlite", "athar.db"},
		{"athar.db", "sqlite", "athar.db"},
		{"/var/lib/athar/x.db", "sqlite", "/var/lib/athar/x.db"},
		{"sqlite:///var/lib/athar/x.db", "sqlite", "/var/lib/athar/x.db"},
		{"postgres://u:p@localhost/athar", "postgres", "postgres://u:p@localhost/athar"},
		{"postgresql://u:p@localhost/athar", "postgres", "postgresql://u:p@localhost/athar"},
	}
	for _, c := range cases {
		engine, rest := normalizeDSN(c.in)
		if engine != c.engine || rest != c.rest {
			t.Errorf("normalizeDSN(%q) = %q,%q want %q,%q", c.in, engine, rest, c.engine, c.rest)
		}
	}
}
