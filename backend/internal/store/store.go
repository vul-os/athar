// Package store is Athar's persistence seam.
//
// Athar runs the same binary in two very different places: on a box in someone's
// house (SQLite, zero setup, no daemon) and in a hosted environment (Postgres,
// managed, pooled). That difference is a config flag, not a fork — everything
// above this package talks to the Store interface and never to a driver.
//
// The implementation is shared: one database/sql-backed type serves both engines
// and a tiny Dialect abstracts the three things that actually differ
// (placeholder syntax, a couple of DDL types, and the migration set). Adding a
// third engine means writing a Dialect and a migration file, not a second Store.
//
// Two portability rules keep that honest, and both are load-bearing:
//
//   - All timestamps are stored as integer Unix milliseconds, never as native
//     date/time columns. Driver-level time handling is the single biggest source
//     of SQLite/Postgres divergence; integers behave identically everywhere and
//     range-scan just as well.
//   - All primary keys are application-generated random strings, never
//     autoincrement. Portable, and it lets the ingest path build a whole event
//     graph without a round trip.
package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrNotFound is returned by every Get* method when the row does not exist.
// Callers should compare with errors.Is rather than inspecting driver errors,
// which differ between SQLite and Postgres.
var ErrNotFound = errors.New("store: not found")

// ErrConflict is returned when a uniqueness constraint rejects a write (a
// duplicate username, or a second website with the same domain for one owner).
var ErrConflict = errors.New("store: conflict")

// ── Identity & access ─────────────────────────────────────────────────────────

// Role is an instance-wide user role. Per-website roles are stored separately in
// website_users; see WebsiteRole.
type Role string

const (
	RoleAdmin Role = "admin" // may create users and manage every website
	RoleUser  Role = "user"  // may only see websites they own or are granted
)

// WebsiteRole is a user's role on one specific website.
type WebsiteRole string

const (
	WebsiteRoleOwner  WebsiteRole = "owner"  // full control, including deletion
	WebsiteRoleEditor WebsiteRole = "editor" // may edit settings and share links
	WebsiteRoleViewer WebsiteRole = "viewer" // read-only
)

// User is a dashboard account. PasswordHash is a full argon2id PHC string; the
// plaintext password never reaches this package.
type User struct {
	ID           string
	Username     string
	PasswordHash string
	Role         Role
	TOTPSecret   string // empty when 2FA is not enrolled
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// AuthSession is a server-side dashboard login session. Only the SHA-256 hash of
// the session token is persisted, so reading the database does not yield a
// usable cookie value.
type AuthSession struct {
	ID        string
	UserID    string
	TokenHash string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// Website is one tracked property. ShareID, when non-empty, is the unguessable
// slug that serves a read-only public dashboard at /share/{ShareID}.
type Website struct {
	ID        string
	Name      string
	Domain    string
	ShareID   string
	OwnerID   string
	CreatedAt time.Time
}

// WebsiteGrant links a user to a website with a role.
type WebsiteGrant struct {
	WebsiteID string
	UserID    string
	Role      WebsiteRole
}

// ── Collected data ────────────────────────────────────────────────────────────

// Visit is a visitor session: the unit that "unique visitors", "bounce rate" and
// "average visit time" are computed over.
//
// VisitorHash is a salted daily hash of (site, IP, user-agent) — see
// package ingest. It is not reversible to an IP, it is not stable across days by
// design, and no raw IP is ever written here or anywhere else.
type Visit struct {
	ID          string
	WebsiteID   string
	VisitorHash string
	Hostname    string
	Browser     string
	OS          string
	Device      string // desktop | laptop | tablet | mobile
	Screen      string // e.g. "1920x1080"
	Language    string
	Country     string // ISO 3166-1 alpha-2, resolved at ingest
	Region      string
	City        string
	Referrer    string // referring host, or "" for direct
	UTMSource   string
	UTMMedium   string
	UTMCampaign string
	UTMTerm     string
	UTMContent  string
	FirstAt     time.Time
	LastAt      time.Time
	Views       int
}

// EventType distinguishes an automatic pageview from a named custom event.
type EventType int

const (
	EventTypePageview EventType = 1
	EventTypeCustom   EventType = 2
)

// Event is a single pageview or custom event.
type Event struct {
	ID        string
	WebsiteID string
	VisitID   string
	Type      EventType
	Name      string // custom event name; empty for pageviews
	URLPath   string
	URLQuery  string
	Referrer  string // full referrer path for on-site navigation
	PageTitle string
	CreatedAt time.Time
}

// EventDatum is one key/value property attached to a custom event. Values are
// stored in typed columns so numeric properties can be summed without casting.
type EventDatum struct {
	ID        string
	EventID   string
	WebsiteID string
	Key       string
	StringVal string
	NumberVal float64
	IsNumber  bool
}

// HeatKind is the class of interaction a heatmap sample records.
type HeatKind string

const (
	HeatClick  HeatKind = "click"  // a click, positioned relative to the page
	HeatScroll HeatKind = "scroll" // maximum scroll depth reached
	HeatAttn   HeatKind = "attn"   // dwell time within a viewport band
)

// HeatSample is one heatmap observation.
//
// Positions are stored as page-relative percentages rather than raw pixels, so a
// heatmap rendered at one viewport width still means something at another. The
// CSS selector of the clicked element is captured alongside, which is what makes
// a click map survive a layout change.
type HeatSample struct {
	ID        string
	WebsiteID string
	VisitID   string
	URLPath   string
	Kind      HeatKind
	XPct      float64 // 0..100, relative to document width
	YPct      float64 // 0..100, relative to document height
	ViewportW int
	ViewportH int
	ScrollPct float64 // 0..100, for HeatScroll / HeatAttn
	DwellMS   int     // for HeatAttn
	Selector  string
	CreatedAt time.Time
}

// Revenue is one money-carrying ecommerce event, attributed to the visit that
// produced it. Amounts are integer minor units (cents) — never floats.
type Revenue struct {
	ID          string
	WebsiteID   string
	VisitID     string
	EventID     string
	OrderID     string
	Currency    string // ISO 4217
	AmountMinor int64
	CreatedAt   time.Time
}

// ── Query results ─────────────────────────────────────────────────────────────

// Range is a half-open time window [From, To).
type Range struct {
	From time.Time
	To   time.Time
}

// Summary is the headline metric row for a website over a time range.
type Summary struct {
	Pageviews    int64
	Visits       int64
	Visitors     int64
	Bounces      int64
	TotalTimeSec int64
}

// BounceRate returns bounces as a fraction of visits (0..1), or 0 with no visits.
func (s Summary) BounceRate() float64 {
	if s.Visits == 0 {
		return 0
	}
	return float64(s.Bounces) / float64(s.Visits)
}

// AvgVisitSec returns the mean visit duration in seconds, or 0 with no visits.
func (s Summary) AvgVisitSec() float64 {
	if s.Visits == 0 {
		return 0
	}
	return float64(s.TotalTimeSec) / float64(s.Visits)
}

// TimePoint is one bucket of a time series.
type TimePoint struct {
	T         time.Time
	Pageviews int64
	Visitors  int64
}

// MetricRow is one row of a "top N" breakdown (top pages, referrers, browsers…).
type MetricRow struct {
	Value string
	Count int64
}

// Interval is the bucket size of a time series.
type Interval string

const (
	IntervalHour Interval = "hour"
	IntervalDay  Interval = "day"
)

// Metric names accepted by Store.TopMetrics.
const (
	MetricPath        = "path"
	MetricEntryPath   = "entry_path"
	MetricExitPath    = "exit_path"
	MetricReferrer    = "referrer"
	MetricBrowser     = "browser"
	MetricOS          = "os"
	MetricDevice      = "device"
	MetricScreen      = "screen"
	MetricLanguage    = "language"
	MetricCountry     = "country"
	MetricRegion      = "region"
	MetricCity        = "city"
	MetricUTMSource   = "utm_source"
	MetricUTMMedium   = "utm_medium"
	MetricUTMCampaign = "utm_campaign"
	MetricEvent       = "event"
)

// ── The seam ──────────────────────────────────────────────────────────────────

// Store is everything Athar needs from a database. It is deliberately a single
// interface rather than a set of per-domain repositories: there is exactly one
// implementation shape (database/sql + a Dialect), and splitting it would add
// indirection without adding a seam anyone would use.
type Store interface {
	// Migrate brings the schema up to date. Safe to call on every boot.
	Migrate(ctx context.Context) error
	// Ping verifies the connection is live.
	Ping(ctx context.Context) error
	// Close releases the connection pool.
	Close() error
	// Dialect reports which engine is behind this Store ("sqlite" or "postgres").
	Dialect() string

	// Settings
	GetSetting(ctx context.Context, key string) (string, error)
	SetSetting(ctx context.Context, key, value string) error

	// Users
	CreateUser(ctx context.Context, u *User) error
	GetUserByID(ctx context.Context, id string) (*User, error)
	GetUserByUsername(ctx context.Context, username string) (*User, error)
	ListUsers(ctx context.Context) ([]User, error)
	UpdateUserPassword(ctx context.Context, id, passwordHash string) error
	UpdateUserTOTP(ctx context.Context, id, secret string) error
	DeleteUser(ctx context.Context, id string) error
	CountUsers(ctx context.Context) (int64, error)

	// Dashboard login sessions
	CreateAuthSession(ctx context.Context, s *AuthSession) error
	GetAuthSessionByTokenHash(ctx context.Context, tokenHash string) (*AuthSession, error)
	TouchAuthSession(ctx context.Context, id string, expiresAt time.Time) error
	DeleteAuthSession(ctx context.Context, id string) error
	DeleteAuthSessionsForUser(ctx context.Context, userID string) error
	PurgeExpiredAuthSessions(ctx context.Context, now time.Time) (int64, error)

	// Websites
	CreateWebsite(ctx context.Context, w *Website) error
	GetWebsite(ctx context.Context, id string) (*Website, error)
	GetWebsiteByShareID(ctx context.Context, shareID string) (*Website, error)
	ListWebsitesForUser(ctx context.Context, userID string, isAdmin bool) ([]Website, error)
	UpdateWebsite(ctx context.Context, w *Website) error
	DeleteWebsite(ctx context.Context, id string) error
	GrantWebsite(ctx context.Context, g WebsiteGrant) error
	RevokeWebsite(ctx context.Context, websiteID, userID string) error
	GetWebsiteRole(ctx context.Context, websiteID, userID string) (WebsiteRole, error)

	// Ingest
	GetVisitByHash(ctx context.Context, websiteID, visitorHash string, notBefore time.Time) (*Visit, error)
	CreateVisit(ctx context.Context, v *Visit) error
	TouchVisit(ctx context.Context, id string, at time.Time, addView bool) error
	CreateEvent(ctx context.Context, e *Event) error
	CreateEventData(ctx context.Context, d []EventDatum) error
	CreateHeatSamples(ctx context.Context, s []HeatSample) error
	CreateRevenue(ctx context.Context, r *Revenue) error

	// Reporting
	Summary(ctx context.Context, websiteID string, rg Range) (Summary, error)
	Series(ctx context.Context, websiteID string, rg Range, iv Interval) ([]TimePoint, error)
	TopMetrics(ctx context.Context, websiteID string, rg Range, metric string, limit int) ([]MetricRow, error)
	ActiveVisitors(ctx context.Context, websiteID string, since time.Time) (int64, error)
	HeatSamples(ctx context.Context, websiteID, urlPath string, kind HeatKind, rg Range, limit int) ([]HeatSample, error)
	RevenueSummary(ctx context.Context, websiteID string, rg Range) (map[string]int64, error)

	// Retention
	PurgeBefore(ctx context.Context, websiteID string, cutoff time.Time) (int64, error)
}

// ── Helpers shared by every implementation ────────────────────────────────────

// NewID returns a 32-character random hex identifier. Random rather than
// sequential: ingest generates IDs before insert (no round trip), and a website
// or share id must not be guessable from a neighbouring one.
func NewID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing means the process cannot make safe IDs at all;
		// continuing would silently weaken share links and session tokens.
		panic(fmt.Sprintf("store: crypto/rand unavailable: %v", err))
	}
	return hex.EncodeToString(b)
}

// toMillis converts a time to the integer Unix-milliseconds representation used
// by every timestamp column. The zero time maps to 0 so "unset" round-trips.
func toMillis(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// fromMillis is the inverse of toMillis. Times come back in UTC.
func fromMillis(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}

// truncate caps a string to n runes. Every free-text field arriving from the
// tracker is bounded before it reaches the database, so a hostile beacon cannot
// grow the tables one enormous field at a time.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// Field length caps, applied on write.
const (
	maxShortField = 128
	maxPathField  = 512
	maxTitleField = 512
	maxQueryField = 512
)

// isMetric reports whether name is a metric TopMetrics understands. Callers
// validate before querying so an unknown name is a 400 rather than a SQL error.
func isMetric(name string) bool {
	switch name {
	case MetricPath, MetricEntryPath, MetricExitPath, MetricReferrer,
		MetricBrowser, MetricOS, MetricDevice, MetricScreen, MetricLanguage,
		MetricCountry, MetricRegion, MetricCity,
		MetricUTMSource, MetricUTMMedium, MetricUTMCampaign, MetricEvent:
		return true
	}
	return false
}

// ValidMetric is the exported form of isMetric, for HTTP handlers.
func ValidMetric(name string) bool { return isMetric(name) }

// normalizeDSN trims whitespace and reports the engine a DSN targets.
func normalizeDSN(dsn string) (engine, rest string) {
	dsn = strings.TrimSpace(dsn)
	switch {
	case strings.HasPrefix(dsn, "postgres://"), strings.HasPrefix(dsn, "postgresql://"):
		return "postgres", dsn
	case strings.HasPrefix(dsn, "sqlite://"):
		return "sqlite", strings.TrimPrefix(dsn, "sqlite://")
	case dsn == "":
		return "sqlite", "athar.db"
	default:
		// A bare path is a SQLite file. This is the default self-host shape.
		return "sqlite", dsn
	}
}
