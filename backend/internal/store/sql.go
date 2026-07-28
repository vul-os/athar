package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" driver
	_ "modernc.org/sqlite"             // registers the pure-Go "sqlite" driver (no cgo)
)

// sqlStore is the single Store implementation. Both supported engines run
// through it; the Dialect supplies placeholder style and driver name, and every
// query below is written in the portable subset both accept.
type sqlStore struct {
	db      *sql.DB
	dialect Dialect
}

var _ Store = (*sqlStore)(nil)

// Open connects to the database described by dsn and returns a ready Store.
// It does not migrate — call Migrate explicitly so boot order stays visible.
//
// Recognised forms:
//
//	""                      → SQLite at ./athar.db (the self-host default)
//	"athar.db", "/var/…/x.db" → SQLite at that path
//	"sqlite:///var/…/x.db"  → SQLite, explicit
//	"postgres://user:pw@host/db" → Postgres
//
// Defaulting a bare path to SQLite is deliberate: the zero-configuration
// self-hosted case should not require anyone to learn a URL scheme.
func Open(ctx context.Context, dsn string) (Store, error) {
	engine, target := normalizeDSN(dsn)

	var d Dialect
	var connStr string
	switch engine {
	case "sqlite":
		d = sqliteDialect{}
		connStr = sqliteDSN(target)
	case "postgres":
		d = postgresDialect{}
		connStr = target
	default:
		return nil, fmt.Errorf("store: unsupported engine %q", engine)
	}

	db, err := sql.Open(d.Driver(), connStr)
	if err != nil {
		return nil, fmt.Errorf("store: open %s: %w", engine, err)
	}
	tunePool(db, engine)

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: connect %s: %w", engine, err)
	}
	return &sqlStore{db: db, dialect: d}, nil
}

// sqliteDSN turns a file path into a modernc.org/sqlite DSN carrying the three
// pragmas Athar depends on:
//
//   - journal_mode(WAL) — readers never block the ingest writer, which matters
//     because the dashboard queries the same file that beacons are writing to.
//   - busy_timeout(10000) — concurrent writers retry for 10s instead of
//     failing the beacon with SQLITE_BUSY.
//   - foreign_keys(1) — SQLite disables FK enforcement by default; retention
//     purges rely on ON DELETE CASCADE from visits.
func sqliteDSN(path string) string {
	if strings.Contains(path, "?") {
		return path // caller supplied their own parameters; respect them
	}
	return "file:" + path +
		"?_pragma=journal_mode(WAL)" +
		"&_pragma=busy_timeout(10000)" +
		"&_pragma=foreign_keys(1)"
}

// tunePool sizes the connection pool for the engine. SQLite writes serialise
// inside the file regardless of pool size; WAL plus a busy timeout makes a
// modest pool the right shape (readers proceed in parallel, writers queue).
func tunePool(db *sql.DB, engine string) {
	n := runtime.NumCPU()
	if n < 4 {
		n = 4
	}
	if engine == "sqlite" && n > 8 {
		n = 8
	}
	db.SetMaxOpenConns(n)
	db.SetMaxIdleConns(n)
	db.SetConnMaxLifetime(time.Hour)
}

func (s *sqlStore) Dialect() string                   { return s.dialect.Name() }
func (s *sqlStore) Close() error                      { return s.db.Close() }
func (s *sqlStore) Ping(ctx context.Context) error    { return s.db.PingContext(ctx) }
func (s *sqlStore) Migrate(ctx context.Context) error { return s.migrate(ctx) }

// q rebinds a `?`-style query for the active engine.
func (s *sqlStore) q(query string) string { return s.dialect.Rebind(query) }

// exec runs a statement, rebinding placeholders and mapping constraint
// violations to ErrConflict so callers never inspect driver-specific errors.
func (s *sqlStore) exec(ctx context.Context, query string, args ...any) (sql.Result, error) {
	res, err := s.db.ExecContext(ctx, s.q(query), args...)
	if err != nil {
		return nil, mapErr(err)
	}
	return res, nil
}

// mapErr translates driver errors into the package's sentinel errors. Both
// engines report uniqueness violations with distinctive text; matching on it is
// less brittle than it looks, and far less brittle than importing both drivers'
// error types into every caller.
func mapErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	msg := err.Error()
	if strings.Contains(msg, "UNIQUE constraint failed") || // SQLite
		strings.Contains(msg, "SQLSTATE 23505") || // Postgres, via pgx
		strings.Contains(msg, "duplicate key value") {
		return fmt.Errorf("%w: %v", ErrConflict, err)
	}
	return err
}

// ── Settings ──────────────────────────────────────────────────────────────────

// GetSetting reads an instance setting, returning ErrNotFound when unset.
func (s *sqlStore) GetSetting(ctx context.Context, key string) (string, error) {
	var v string
	err := s.db.QueryRowContext(ctx,
		s.q(`SELECT setting_value FROM settings WHERE setting_key = ?`), key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return v, err
}

// SetSetting writes an instance setting, replacing any existing value.
func (s *sqlStore) SetSetting(ctx context.Context, key, value string) error {
	_, err := s.exec(ctx,
		`INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
		 ON CONFLICT (setting_key) DO UPDATE SET setting_value = ?`,
		key, value, value)
	return err
}

// ── Users ─────────────────────────────────────────────────────────────────────

const userCols = `id, username, password_hash, role, totp_secret, created_at, updated_at`

func (s *sqlStore) CreateUser(ctx context.Context, u *User) error {
	if u.ID == "" {
		u.ID = NewID()
	}
	now := time.Now().UTC()
	if u.CreatedAt.IsZero() {
		u.CreatedAt = now
	}
	u.UpdatedAt = now
	_, err := s.exec(ctx,
		`INSERT INTO users (`+userCols+`) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.PasswordHash, string(u.Role), u.TOTPSecret,
		toMillis(u.CreatedAt), toMillis(u.UpdatedAt))
	return err
}

func (s *sqlStore) scanUser(row *sql.Row) (*User, error) {
	var u User
	var role string
	var created, updated int64
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &role, &u.TOTPSecret, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.Role = Role(role)
	u.CreatedAt = fromMillis(created)
	u.UpdatedAt = fromMillis(updated)
	return &u, nil
}

func (s *sqlStore) GetUserByID(ctx context.Context, id string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx, s.q(`SELECT `+userCols+` FROM users WHERE id = ?`), id))
}

func (s *sqlStore) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	return s.scanUser(s.db.QueryRowContext(ctx, s.q(`SELECT `+userCols+` FROM users WHERE username = ?`), username))
}

func (s *sqlStore) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT `+userCols+` FROM users ORDER BY username`))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []User
	for rows.Next() {
		var u User
		var role string
		var created, updated int64
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &role, &u.TOTPSecret, &created, &updated); err != nil {
			return nil, err
		}
		u.Role = Role(role)
		u.CreatedAt = fromMillis(created)
		u.UpdatedAt = fromMillis(updated)
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *sqlStore) UpdateUserPassword(ctx context.Context, id, passwordHash string) error {
	res, err := s.exec(ctx, `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
		passwordHash, time.Now().UnixMilli(), id)
	return affectedOne(res, err)
}

func (s *sqlStore) UpdateUserTOTP(ctx context.Context, id, secret string) error {
	res, err := s.exec(ctx, `UPDATE users SET totp_secret = ?, updated_at = ? WHERE id = ?`,
		secret, time.Now().UnixMilli(), id)
	return affectedOne(res, err)
}

func (s *sqlStore) DeleteUser(ctx context.Context, id string) error {
	res, err := s.exec(ctx, `DELETE FROM users WHERE id = ?`, id)
	return affectedOne(res, err)
}

func (s *sqlStore) CountUsers(ctx context.Context) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// affectedOne turns "updated nothing" into ErrNotFound so a handler can answer
// 404 rather than reporting a silent success.
func affectedOne(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil // driver does not report it; the statement itself succeeded
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ── Auth sessions ─────────────────────────────────────────────────────────────

func (s *sqlStore) CreateAuthSession(ctx context.Context, a *AuthSession) error {
	if a.ID == "" {
		a.ID = NewID()
	}
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now().UTC()
	}
	_, err := s.exec(ctx,
		`INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		a.ID, a.UserID, a.TokenHash, toMillis(a.CreatedAt), toMillis(a.ExpiresAt))
	return err
}

func (s *sqlStore) GetAuthSessionByTokenHash(ctx context.Context, tokenHash string) (*AuthSession, error) {
	var a AuthSession
	var created, expires int64
	err := s.db.QueryRowContext(ctx,
		s.q(`SELECT id, user_id, token_hash, created_at, expires_at FROM auth_sessions WHERE token_hash = ?`),
		tokenHash).Scan(&a.ID, &a.UserID, &a.TokenHash, &created, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	a.CreatedAt = fromMillis(created)
	a.ExpiresAt = fromMillis(expires)
	return &a, nil
}

func (s *sqlStore) TouchAuthSession(ctx context.Context, id string, expiresAt time.Time) error {
	_, err := s.exec(ctx, `UPDATE auth_sessions SET expires_at = ? WHERE id = ?`, toMillis(expiresAt), id)
	return err
}

func (s *sqlStore) DeleteAuthSession(ctx context.Context, id string) error {
	_, err := s.exec(ctx, `DELETE FROM auth_sessions WHERE id = ?`, id)
	return err
}

func (s *sqlStore) DeleteAuthSessionsForUser(ctx context.Context, userID string) error {
	_, err := s.exec(ctx, `DELETE FROM auth_sessions WHERE user_id = ?`, userID)
	return err
}

func (s *sqlStore) PurgeExpiredAuthSessions(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.exec(ctx, `DELETE FROM auth_sessions WHERE expires_at < ?`, toMillis(now))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// ── Websites ──────────────────────────────────────────────────────────────────

const websiteCols = `id, name, domain, share_id, owner_id, created_at`

func (s *sqlStore) CreateWebsite(ctx context.Context, w *Website) error {
	if w.ID == "" {
		w.ID = NewID()
	}
	if w.CreatedAt.IsZero() {
		w.CreatedAt = time.Now().UTC()
	}
	_, err := s.exec(ctx,
		`INSERT INTO websites (`+websiteCols+`) VALUES (?, ?, ?, ?, ?, ?)`,
		w.ID, truncate(w.Name, maxShortField), truncate(w.Domain, maxShortField),
		w.ShareID, w.OwnerID, toMillis(w.CreatedAt))
	return err
}

func (s *sqlStore) scanWebsite(row *sql.Row) (*Website, error) {
	var w Website
	var created int64
	err := row.Scan(&w.ID, &w.Name, &w.Domain, &w.ShareID, &w.OwnerID, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	w.CreatedAt = fromMillis(created)
	return &w, nil
}

func (s *sqlStore) GetWebsite(ctx context.Context, id string) (*Website, error) {
	return s.scanWebsite(s.db.QueryRowContext(ctx, s.q(`SELECT `+websiteCols+` FROM websites WHERE id = ?`), id))
}

func (s *sqlStore) GetWebsiteByShareID(ctx context.Context, shareID string) (*Website, error) {
	if shareID == "" {
		// Guard: every website with sharing disabled has share_id = '', so an
		// empty lookup would hand out the first unshared site on the instance.
		return nil, ErrNotFound
	}
	return s.scanWebsite(s.db.QueryRowContext(ctx, s.q(`SELECT `+websiteCols+` FROM websites WHERE share_id = ?`), shareID))
}

// ListWebsitesForUser returns every website the user can see: all of them for an
// admin, otherwise the ones they own plus the ones explicitly granted to them.
func (s *sqlStore) ListWebsitesForUser(ctx context.Context, userID string, isAdmin bool) ([]Website, error) {
	query := `SELECT ` + websiteCols + ` FROM websites
	          WHERE owner_id = ?
	             OR id IN (SELECT website_id FROM website_users WHERE user_id = ?)
	          ORDER BY name`
	args := []any{userID, userID}
	if isAdmin {
		query = `SELECT ` + websiteCols + ` FROM websites ORDER BY name`
		args = nil
	}

	rows, err := s.db.QueryContext(ctx, s.q(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Website
	for rows.Next() {
		var w Website
		var created int64
		if err := rows.Scan(&w.ID, &w.Name, &w.Domain, &w.ShareID, &w.OwnerID, &created); err != nil {
			return nil, err
		}
		w.CreatedAt = fromMillis(created)
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *sqlStore) UpdateWebsite(ctx context.Context, w *Website) error {
	res, err := s.exec(ctx, `UPDATE websites SET name = ?, domain = ?, share_id = ? WHERE id = ?`,
		truncate(w.Name, maxShortField), truncate(w.Domain, maxShortField), w.ShareID, w.ID)
	return affectedOne(res, err)
}

func (s *sqlStore) DeleteWebsite(ctx context.Context, id string) error {
	res, err := s.exec(ctx, `DELETE FROM websites WHERE id = ?`, id)
	return affectedOne(res, err)
}

func (s *sqlStore) GrantWebsite(ctx context.Context, g WebsiteGrant) error {
	// Portable upsert: both engines accept ON CONFLICT … DO UPDATE on a named
	// conflict target, so re-granting is a role change rather than an error.
	_, err := s.exec(ctx,
		`INSERT INTO website_users (website_id, user_id, role) VALUES (?, ?, ?)
		 ON CONFLICT (website_id, user_id) DO UPDATE SET role = ?`,
		g.WebsiteID, g.UserID, string(g.Role), string(g.Role))
	return err
}

func (s *sqlStore) RevokeWebsite(ctx context.Context, websiteID, userID string) error {
	_, err := s.exec(ctx, `DELETE FROM website_users WHERE website_id = ? AND user_id = ?`, websiteID, userID)
	return err
}

// GetWebsiteRole reports the user's role on a website. Ownership implies owner
// without needing a website_users row, so creating a site grants access to it.
func (s *sqlStore) GetWebsiteRole(ctx context.Context, websiteID, userID string) (WebsiteRole, error) {
	var owner string
	err := s.db.QueryRowContext(ctx, s.q(`SELECT owner_id FROM websites WHERE id = ?`), websiteID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if owner == userID {
		return WebsiteRoleOwner, nil
	}

	var role string
	err = s.db.QueryRowContext(ctx,
		s.q(`SELECT role FROM website_users WHERE website_id = ? AND user_id = ?`),
		websiteID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return WebsiteRole(role), nil
}

// ── Ingest ────────────────────────────────────────────────────────────────────

const visitCols = `id, website_id, visitor_hash, hostname, browser, os, device, screen, language,
	country, region, city, referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
	first_at, last_at, views`

// GetVisitByHash finds the visitor's live session — the most recent visit whose
// last activity is at or after notBefore. Callers pass "now minus the session
// window" (30 minutes by convention), so a returning visitor after a long gap
// starts a new session rather than resuming a stale one.
func (s *sqlStore) GetVisitByHash(ctx context.Context, websiteID, visitorHash string, notBefore time.Time) (*Visit, error) {
	row := s.db.QueryRowContext(ctx, s.q(`SELECT `+visitCols+` FROM visits
		WHERE website_id = ? AND visitor_hash = ? AND last_at >= ?
		ORDER BY last_at DESC LIMIT 1`),
		websiteID, visitorHash, toMillis(notBefore))

	var v Visit
	var first, last int64
	err := row.Scan(&v.ID, &v.WebsiteID, &v.VisitorHash, &v.Hostname, &v.Browser, &v.OS, &v.Device,
		&v.Screen, &v.Language, &v.Country, &v.Region, &v.City, &v.Referrer,
		&v.UTMSource, &v.UTMMedium, &v.UTMCampaign, &v.UTMTerm, &v.UTMContent,
		&first, &last, &v.Views)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	v.FirstAt = fromMillis(first)
	v.LastAt = fromMillis(last)
	return &v, nil
}

func (s *sqlStore) CreateVisit(ctx context.Context, v *Visit) error {
	if v.ID == "" {
		v.ID = NewID()
	}
	now := time.Now().UTC()
	if v.FirstAt.IsZero() {
		v.FirstAt = now
	}
	if v.LastAt.IsZero() {
		v.LastAt = v.FirstAt
	}
	_, err := s.exec(ctx,
		`INSERT INTO visits (`+visitCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.ID, v.WebsiteID, v.VisitorHash,
		truncate(v.Hostname, maxShortField), truncate(v.Browser, maxShortField),
		truncate(v.OS, maxShortField), truncate(v.Device, maxShortField),
		truncate(v.Screen, maxShortField), truncate(v.Language, maxShortField),
		truncate(v.Country, maxShortField), truncate(v.Region, maxShortField),
		truncate(v.City, maxShortField), truncate(v.Referrer, maxShortField),
		truncate(v.UTMSource, maxShortField), truncate(v.UTMMedium, maxShortField),
		truncate(v.UTMCampaign, maxShortField), truncate(v.UTMTerm, maxShortField),
		truncate(v.UTMContent, maxShortField),
		toMillis(v.FirstAt), toMillis(v.LastAt), v.Views)
	return err
}

// TouchVisit extends a live session. addView is false for heartbeat-style
// beacons (heatmap samples, custom events) so they keep the session alive
// without inflating the pageview count or defeating bounce detection.
func (s *sqlStore) TouchVisit(ctx context.Context, id string, at time.Time, addView bool) error {
	q := `UPDATE visits SET last_at = ? WHERE id = ?`
	if addView {
		q = `UPDATE visits SET last_at = ?, views = views + 1 WHERE id = ?`
	}
	_, err := s.exec(ctx, q, toMillis(at), id)
	return err
}

func (s *sqlStore) CreateEvent(ctx context.Context, e *Event) error {
	if e.ID == "" {
		e.ID = NewID()
	}
	if e.CreatedAt.IsZero() {
		e.CreatedAt = time.Now().UTC()
	}
	_, err := s.exec(ctx,
		`INSERT INTO events (id, website_id, visit_id, type, name, url_path, url_query, referrer, page_title, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.ID, e.WebsiteID, e.VisitID, int(e.Type),
		truncate(e.Name, maxShortField), truncate(e.URLPath, maxPathField),
		truncate(e.URLQuery, maxQueryField), truncate(e.Referrer, maxPathField),
		truncate(e.PageTitle, maxTitleField), toMillis(e.CreatedAt))
	return err
}

// CreateEventData inserts a batch of event properties in one transaction, so a
// custom event's properties are either all visible or none of them are.
func (s *sqlStore) CreateEventData(ctx context.Context, data []EventDatum) error {
	if len(data) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx, s.q(
		`INSERT INTO event_data (id, event_id, website_id, data_key, string_value, number_value, is_number)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`))
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, d := range data {
		if d.ID == "" {
			d.ID = NewID()
		}
		if _, err := stmt.ExecContext(ctx, d.ID, d.EventID, d.WebsiteID,
			truncate(d.Key, maxShortField), truncate(d.StringVal, maxShortField),
			d.NumberVal, boolInt(d.IsNumber)); err != nil {
			return mapErr(err)
		}
	}
	return tx.Commit()
}

// CreateHeatSamples batches heatmap writes. The tracker buffers samples and
// flushes on a timer or page hide, so this is called with tens of rows at once —
// one transaction per flush rather than per sample.
func (s *sqlStore) CreateHeatSamples(ctx context.Context, samples []HeatSample) error {
	if len(samples) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx, s.q(
		`INSERT INTO heat_samples (id, website_id, visit_id, url_path, kind, x_pct, y_pct,
		 viewport_w, viewport_h, scroll_pct, dwell_ms, selector, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`))
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, h := range samples {
		if h.ID == "" {
			h.ID = NewID()
		}
		if h.CreatedAt.IsZero() {
			h.CreatedAt = time.Now().UTC()
		}
		if _, err := stmt.ExecContext(ctx, h.ID, h.WebsiteID, h.VisitID,
			truncate(h.URLPath, maxPathField), string(h.Kind),
			h.XPct, h.YPct, h.ViewportW, h.ViewportH, h.ScrollPct, h.DwellMS,
			truncate(h.Selector, maxPathField), toMillis(h.CreatedAt)); err != nil {
			return mapErr(err)
		}
	}
	return tx.Commit()
}

func (s *sqlStore) CreateRevenue(ctx context.Context, r *Revenue) error {
	if r.ID == "" {
		r.ID = NewID()
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = time.Now().UTC()
	}
	if r.Currency == "" {
		r.Currency = "USD"
	}
	_, err := s.exec(ctx,
		`INSERT INTO revenue (id, website_id, visit_id, event_id, order_id, currency, amount_minor, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.WebsiteID, r.VisitID, r.EventID,
		truncate(r.OrderID, maxShortField), truncate(r.Currency, 8),
		r.AmountMinor, toMillis(r.CreatedAt))
	return err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ── Reporting ─────────────────────────────────────────────────────────────────

// Summary computes the headline row. Visits are attributed to the range by when
// they *started*, so a session is counted once, in one bucket — the alternative
// (any activity in range) double-counts sessions that straddle a boundary.
func (s *sqlStore) Summary(ctx context.Context, websiteID string, rg Range) (Summary, error) {
	var out Summary

	err := s.db.QueryRowContext(ctx, s.q(
		`SELECT COUNT(*) FROM events
		 WHERE website_id = ? AND type = ? AND created_at >= ? AND created_at < ?`),
		websiteID, int(EventTypePageview), toMillis(rg.From), toMillis(rg.To)).Scan(&out.Pageviews)
	if err != nil {
		return out, err
	}

	// COALESCE keeps the empty-range case a zero row rather than a NULL scan
	// error; SUM over no rows is NULL on both engines.
	err = s.db.QueryRowContext(ctx, s.q(
		`SELECT COUNT(*),
		        COUNT(DISTINCT visitor_hash),
		        COALESCE(SUM(CASE WHEN views <= 1 THEN 1 ELSE 0 END), 0),
		        COALESCE(SUM(last_at - first_at), 0) / 1000
		 FROM visits
		 WHERE website_id = ? AND first_at >= ? AND first_at < ?`),
		websiteID, toMillis(rg.From), toMillis(rg.To)).
		Scan(&out.Visits, &out.Visitors, &out.Bounces, &out.TotalTimeSec)
	return out, err
}

func (s *sqlStore) Series(ctx context.Context, websiteID string, rg Range, iv Interval) ([]TimePoint, error) {
	bucket := s.dialect.TimeBucket("e.created_at", iv)
	query := `SELECT ` + bucket + ` AS bucket, COUNT(*), COUNT(DISTINCT v.visitor_hash)
	          FROM events e JOIN visits v ON v.id = e.visit_id
	          WHERE e.website_id = ? AND e.type = ? AND e.created_at >= ? AND e.created_at < ?
	          GROUP BY ` + bucket + `
	          ORDER BY bucket`

	rows, err := s.db.QueryContext(ctx, s.q(query),
		websiteID, int(EventTypePageview), toMillis(rg.From), toMillis(rg.To))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []TimePoint
	for rows.Next() {
		var ms int64
		var p TimePoint
		if err := rows.Scan(&ms, &p.Pageviews, &p.Visitors); err != nil {
			return nil, err
		}
		p.T = fromMillis(ms)
		out = append(out, p)
	}
	return out, rows.Err()
}

// TopMetrics returns a "top N" breakdown. metric must pass ValidMetric — the
// name selects a fixed query below, so no caller-supplied text ever reaches SQL.
func (s *sqlStore) TopMetrics(ctx context.Context, websiteID string, rg Range, metric string, limit int) ([]MetricRow, error) {
	if !isMetric(metric) {
		return nil, fmt.Errorf("store: unknown metric %q", metric)
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}

	query, args := metricQuery(websiteID, rg, metric, limit)
	rows, err := s.db.QueryContext(ctx, s.q(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []MetricRow
	for rows.Next() {
		var m MetricRow
		if err := rows.Scan(&m.Value, &m.Count); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// metricQuery maps a validated metric name to its query and arguments.
//
// Three shapes appear here, and the difference matters when reading a report:
// visit-scoped dimensions count *sessions*, path counts *pageviews*, and
// entry/exit find the first and last pageview of each session.
func metricQuery(websiteID string, rg Range, metric string, limit int) (string, []any) {
	from, to := toMillis(rg.From), toMillis(rg.To)

	// Visit-scoped dimensions: one row per session, counted over sessions that
	// started in range. Empty values are excluded — "unknown" is not a browser.
	visitCol := map[string]string{
		MetricReferrer:    "referrer",
		MetricBrowser:     "browser",
		MetricOS:          "os",
		MetricDevice:      "device",
		MetricScreen:      "screen",
		MetricLanguage:    "language",
		MetricCountry:     "country",
		MetricRegion:      "region",
		MetricCity:        "city",
		MetricUTMSource:   "utm_source",
		MetricUTMMedium:   "utm_medium",
		MetricUTMCampaign: "utm_campaign",
	}
	if col, ok := visitCol[metric]; ok {
		return `SELECT ` + col + ` AS value, COUNT(*) AS c FROM visits
		        WHERE website_id = ? AND first_at >= ? AND first_at < ? AND ` + col + ` <> ''
		        GROUP BY ` + col + ` ORDER BY c DESC, value ASC LIMIT ?`,
			[]any{websiteID, from, to, limit}
	}

	switch metric {
	case MetricPath:
		return `SELECT url_path AS value, COUNT(*) AS c FROM events
		        WHERE website_id = ? AND type = ? AND created_at >= ? AND created_at < ?
		        GROUP BY url_path ORDER BY c DESC, value ASC LIMIT ?`,
			[]any{websiteID, int(EventTypePageview), from, to, limit}

	case MetricEvent:
		return `SELECT name AS value, COUNT(*) AS c FROM events
		        WHERE website_id = ? AND type = ? AND created_at >= ? AND created_at < ? AND name <> ''
		        GROUP BY name ORDER BY c DESC, value ASC LIMIT ?`,
			[]any{websiteID, int(EventTypeCustom), from, to, limit}

	case MetricEntryPath, MetricExitPath:
		// The entry/exit page of a session is its first/last pageview. Joining
		// against a per-visit MIN/MAX subquery keeps this in the portable SQL
		// subset — window functions would work on both engines today, but the
		// subquery is just as fast here and needs no version floor.
		agg := "MIN"
		if metric == MetricExitPath {
			agg = "MAX"
		}
		return `SELECT e.url_path AS value, COUNT(*) AS c
		        FROM events e
		        JOIN (SELECT visit_id, ` + agg + `(created_at) AS edge FROM events
		              WHERE website_id = ? AND type = ? AND created_at >= ? AND created_at < ?
		              GROUP BY visit_id) b
		          ON b.visit_id = e.visit_id AND b.edge = e.created_at
		        WHERE e.website_id = ? AND e.type = ?
		        GROUP BY e.url_path ORDER BY c DESC, value ASC LIMIT ?`,
			[]any{websiteID, int(EventTypePageview), from, to, websiteID, int(EventTypePageview), limit}
	}

	// Unreachable: isMetric gates every caller.
	panic("store: metric " + metric + " passed validation but has no query")
}

// ActiveVisitors counts distinct visitors seen since a cutoff — the realtime
// number. Callers pass now-5m by convention.
func (s *sqlStore) ActiveVisitors(ctx context.Context, websiteID string, since time.Time) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx, s.q(
		`SELECT COUNT(DISTINCT visitor_hash) FROM visits WHERE website_id = ? AND last_at >= ?`),
		websiteID, toMillis(since)).Scan(&n)
	return n, err
}

func (s *sqlStore) HeatSamples(ctx context.Context, websiteID, urlPath string, kind HeatKind, rg Range, limit int) ([]HeatSample, error) {
	if limit <= 0 || limit > 50_000 {
		limit = 10_000
	}
	rows, err := s.db.QueryContext(ctx, s.q(
		`SELECT id, website_id, visit_id, url_path, kind, x_pct, y_pct, viewport_w, viewport_h,
		        scroll_pct, dwell_ms, selector, created_at
		 FROM heat_samples
		 WHERE website_id = ? AND url_path = ? AND kind = ? AND created_at >= ? AND created_at < ?
		 ORDER BY created_at DESC LIMIT ?`),
		websiteID, urlPath, string(kind), toMillis(rg.From), toMillis(rg.To), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []HeatSample
	for rows.Next() {
		var h HeatSample
		var kindStr string
		var created int64
		if err := rows.Scan(&h.ID, &h.WebsiteID, &h.VisitID, &h.URLPath, &kindStr,
			&h.XPct, &h.YPct, &h.ViewportW, &h.ViewportH, &h.ScrollPct, &h.DwellMS,
			&h.Selector, &created); err != nil {
			return nil, err
		}
		h.Kind = HeatKind(kindStr)
		h.CreatedAt = fromMillis(created)
		out = append(out, h)
	}
	return out, rows.Err()
}

// RevenueSummary totals revenue per currency. Currencies are never summed
// together — an instance tracking two currencies gets two numbers, not a
// meaningless total.
func (s *sqlStore) RevenueSummary(ctx context.Context, websiteID string, rg Range) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx, s.q(
		`SELECT currency, COALESCE(SUM(amount_minor), 0) FROM revenue
		 WHERE website_id = ? AND created_at >= ? AND created_at < ?
		 GROUP BY currency`),
		websiteID, toMillis(rg.From), toMillis(rg.To))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]int64{}
	for rows.Next() {
		var cur string
		var amt int64
		if err := rows.Scan(&cur, &amt); err != nil {
			return nil, err
		}
		out[cur] = amt
	}
	return out, rows.Err()
}

// ── Retention ─────────────────────────────────────────────────────────────────

// PurgeBefore deletes visits whose last activity predates cutoff, taking their
// events, event data, heatmap samples and revenue rows with them via
// ON DELETE CASCADE. Deleting by session rather than by row is what keeps a
// retention pass from leaving orphaned events behind.
//
// A cutoff of the zero time is rejected rather than treated as "delete
// everything" — an unset retention setting must never wipe the database.
func (s *sqlStore) PurgeBefore(ctx context.Context, websiteID string, cutoff time.Time) (int64, error) {
	if cutoff.IsZero() {
		return 0, errors.New("store: PurgeBefore requires a non-zero cutoff")
	}
	res, err := s.exec(ctx, `DELETE FROM visits WHERE website_id = ? AND last_at < ?`,
		websiteID, toMillis(cutoff))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}
