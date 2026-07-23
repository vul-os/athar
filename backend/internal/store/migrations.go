package store

// migrations is Athar's schema, as an ordered list of DDL steps.
//
// There is one set, not one per engine. Every statement here is written in the
// subset of SQL that SQLite and Postgres both accept literally — TEXT, INTEGER,
// BIGINT, DOUBLE PRECISION, `CREATE TABLE IF NOT EXISTS`, partial indexes, and
// `REFERENCES … ON DELETE CASCADE`. That is a real constraint on future
// migrations, and it is worth it: a single schema cannot drift between the
// self-hosted and hosted deployments.
//
// Conventions, applied throughout:
//   - Timestamps are BIGINT epoch milliseconds (see the package doc).
//   - Primary keys are 32-char application-generated hex strings.
//   - Booleans are INTEGER 0/1 — Postgres has a real BOOLEAN, SQLite does not,
//     and integers scan identically through database/sql on both.
//   - Money is BIGINT minor units. Never floats.
//
// Never edit a released migration; append a new one.
var migrations = []migration{
	{
		Version: 1,
		Name:    "core",
		SQL: `
-- ── Instance settings ───────────────────────────────────────────────────────

-- A small key/value table for instance-level state that must outlive the
-- process. Its one v1 occupant is the ingest secret the daily visitor-hash salt
-- is derived from: keeping it here (rather than in memory) means a restart does
-- not re-count every returning visitor as new, and keeping it in the database
-- (rather than on disk) means a multi-replica Postgres deployment shares one.
CREATE TABLE IF NOT EXISTS settings (
	setting_key   TEXT NOT NULL PRIMARY KEY,
	setting_value TEXT NOT NULL
);

-- ── Identity ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
	id            TEXT   NOT NULL PRIMARY KEY,
	username      TEXT   NOT NULL UNIQUE,
	password_hash TEXT   NOT NULL,
	role          TEXT   NOT NULL,
	totp_secret   TEXT   NOT NULL DEFAULT '',
	created_at    BIGINT NOT NULL,
	updated_at    BIGINT NOT NULL
);

-- Dashboard login sessions. token_hash is SHA-256 of the cookie value, so a
-- database read never yields a usable session token.
CREATE TABLE IF NOT EXISTS auth_sessions (
	id         TEXT   NOT NULL PRIMARY KEY,
	user_id    TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	token_hash TEXT   NOT NULL UNIQUE,
	created_at BIGINT NOT NULL,
	expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id);

-- ── Websites ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS websites (
	id         TEXT   NOT NULL PRIMARY KEY,
	name       TEXT   NOT NULL,
	domain     TEXT   NOT NULL,
	share_id   TEXT   NOT NULL DEFAULT '',
	owner_id   TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_websites_owner ON websites (owner_id);

-- Partial index: share_id is unique only when a public link has been minted.
-- Both engines honour the WHERE clause, so the empty default does not collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_websites_share ON websites (share_id) WHERE share_id <> '';

-- Per-website roles, layered on top of the instance-wide users.role.
CREATE TABLE IF NOT EXISTS website_users (
	website_id TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
	user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role       TEXT NOT NULL,
	PRIMARY KEY (website_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_website_users_user ON website_users (user_id);

-- ── Collected data ──────────────────────────────────────────────────────────

-- A visitor session. visitor_hash is a salted daily hash of (site, IP, UA);
-- the salt rotates every day and is never persisted, so yesterday's hashes
-- cannot be recomputed and no row here is reversible to an IP.
CREATE TABLE IF NOT EXISTS visits (
	id            TEXT   NOT NULL PRIMARY KEY,
	website_id    TEXT   NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
	visitor_hash  TEXT   NOT NULL,
	hostname      TEXT   NOT NULL DEFAULT '',
	browser       TEXT   NOT NULL DEFAULT '',
	os            TEXT   NOT NULL DEFAULT '',
	device        TEXT   NOT NULL DEFAULT '',
	screen        TEXT   NOT NULL DEFAULT '',
	language      TEXT   NOT NULL DEFAULT '',
	country       TEXT   NOT NULL DEFAULT '',
	region        TEXT   NOT NULL DEFAULT '',
	city          TEXT   NOT NULL DEFAULT '',
	referrer      TEXT   NOT NULL DEFAULT '',
	utm_source    TEXT   NOT NULL DEFAULT '',
	utm_medium    TEXT   NOT NULL DEFAULT '',
	utm_campaign  TEXT   NOT NULL DEFAULT '',
	utm_term      TEXT   NOT NULL DEFAULT '',
	utm_content   TEXT   NOT NULL DEFAULT '',
	first_at      BIGINT NOT NULL,
	last_at       BIGINT NOT NULL,
	views         INTEGER NOT NULL DEFAULT 0
);

-- The ingest hot path: "is there a live visit for this hash?" on every beacon.
CREATE INDEX IF NOT EXISTS idx_visits_lookup ON visits (website_id, visitor_hash, last_at);
CREATE INDEX IF NOT EXISTS idx_visits_first_at ON visits (website_id, first_at);
CREATE INDEX IF NOT EXISTS idx_visits_last_at ON visits (website_id, last_at);

-- Pageviews (type 1) and custom events (type 2) share one table: every report
-- filters by visit anyway, and splitting them would double every join.
CREATE TABLE IF NOT EXISTS events (
	id         TEXT   NOT NULL PRIMARY KEY,
	website_id TEXT   NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
	visit_id   TEXT   NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
	type       INTEGER NOT NULL,
	name       TEXT   NOT NULL DEFAULT '',
	url_path   TEXT   NOT NULL DEFAULT '',
	url_query  TEXT   NOT NULL DEFAULT '',
	referrer   TEXT   NOT NULL DEFAULT '',
	page_title TEXT   NOT NULL DEFAULT '',
	created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_site_time ON events (website_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_visit ON events (visit_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_name ON events (website_id, type, name);
CREATE INDEX IF NOT EXISTS idx_events_path ON events (website_id, url_path, created_at);

-- Custom-event properties. String and numeric values live in separate columns
-- so numeric properties can be summed without a cast that differs per engine.
CREATE TABLE IF NOT EXISTS event_data (
	id           TEXT   NOT NULL PRIMARY KEY,
	event_id     TEXT   NOT NULL REFERENCES events(id) ON DELETE CASCADE,
	website_id   TEXT   NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
	data_key     TEXT   NOT NULL,
	string_value TEXT   NOT NULL DEFAULT '',
	number_value DOUBLE PRECISION NOT NULL DEFAULT 0,
	is_number    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_event_data_event ON event_data (event_id);
CREATE INDEX IF NOT EXISTS idx_event_data_key ON event_data (website_id, data_key);

-- Heatmap samples. Positions are page-relative percentages, not pixels, so a
-- map recorded at one viewport width still means something at another; the CSS
-- selector alongside is what lets a click map survive a layout change.
CREATE TABLE IF NOT EXISTS heat_samples (
	id         TEXT   NOT NULL PRIMARY KEY,
	website_id TEXT   NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
	visit_id   TEXT   NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
	url_path   TEXT   NOT NULL DEFAULT '',
	kind       TEXT   NOT NULL,
	x_pct      DOUBLE PRECISION NOT NULL DEFAULT 0,
	y_pct      DOUBLE PRECISION NOT NULL DEFAULT 0,
	viewport_w INTEGER NOT NULL DEFAULT 0,
	viewport_h INTEGER NOT NULL DEFAULT 0,
	scroll_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
	dwell_ms   INTEGER NOT NULL DEFAULT 0,
	selector   TEXT   NOT NULL DEFAULT '',
	created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_heat_lookup ON heat_samples (website_id, url_path, kind, created_at);

-- Ecommerce revenue, attributed to the visit that produced it. Integer minor
-- units in an explicit currency — never a float, never an implied currency.
CREATE TABLE IF NOT EXISTS revenue (
	id           TEXT   NOT NULL PRIMARY KEY,
	website_id   TEXT   NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
	visit_id     TEXT   NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
	event_id     TEXT   NOT NULL DEFAULT '',
	order_id     TEXT   NOT NULL DEFAULT '',
	currency     TEXT   NOT NULL DEFAULT 'USD',
	amount_minor BIGINT NOT NULL DEFAULT 0,
	created_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revenue_site_time ON revenue (website_id, created_at);
CREATE INDEX IF NOT EXISTS idx_revenue_visit ON revenue (visit_id);
`,
	},
}
