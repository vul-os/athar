# Changelog

All notable changes to Athar are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

No unreleased changes.

---

## [0.1.0] - 2026-07-24

Initial release.

### Added

- **Single static Go binary.** The Vite/React dashboard is embedded via
  `embed.FS` behind the `embed_frontend` build tag — the same pattern used
  across the Vulos suite — so a plain `go build ./...` still produces a
  working (dev-mode) binary, and `npm run build:all` produces the full
  self-contained one. No cgo; cross-compiles cleanly to linux/darwin
  amd64+arm64 and windows/amd64.
- **The Store seam** (`backend/internal/store`) — one `database/sql`-backed
  implementation plus a tiny `Dialect`, serving SQLite (`modernc.org/sqlite`,
  pure Go) by default and Postgres (`pgx`) when `database` is a
  `postgres://` DSN. Two portability rules make one schema work on both
  engines: every timestamp is stored as an integer Unix millisecond, and
  every primary key is an application-generated random hex string.
- **Cookieless, no-PII visitor identity** (`backend/internal/ingest`) —
  `HMAC(salt, website_id ‖ ip ‖ user_agent)` with a daily-rotating
  `salt = HMAC(instance_secret, YYYY-MM-DD)`. No cookie, no storage write,
  unlinkable across days, and unlinkable across websites on the same
  instance because the website id is inside the hash. The instance secret
  is persisted in the `settings` table so a restart doesn't re-count
  returning visitors.
- **In-process GeoIP** (`backend/internal/geoip`) reading a local MaxMind
  `.mmdb` file with no network call; disabled (empty location fields) when
  none is configured.
- **The tracker** (`backend/internal/tracker`, `athar.js` / `athar.min.js`)
  — 3.3 KB raw, 1.6 KB gzipped. Automatic pageviews including SPA route
  changes, custom events, revenue events, click/scroll/attention heatmap
  sampling, `sendBeacon` with a `fetch` fallback, `data-*` attribute
  configuration, and a `window.athar` JS API. Served with a stable ETag and
  4-hour cache; `?source=1` serves the readable original.
- **Bot detection** at ingest — recognised bot traffic is dropped rather
  than recorded.
- **Reporting API** (`backend/internal/api`) — summary (pageviews, visits,
  unique visitors, bounces, bounce rate, average visit time), a gap-filled
  time series at hour or day granularity, top-N breakdowns for path,
  entry/exit path, referrer, browser, OS, device, screen, language,
  country/region/city, UTM source/medium/campaign, and custom events,
  realtime active-visitor count, raw heatmap samples per page and kind, and
  a per-currency revenue summary in integer minor units.
- **Auth** (`backend/internal/auth`) — argon2id password hashing (64 MiB,
  t=2, CPU-scaled parallelism capped at 4, parameters embedded in the hash
  for transparent upgrades), server-side sessions identified by a
  SHA-256'd token, httpOnly + `SameSite=Lax` cookies, double-submit CSRF
  enforced on every state-changing method by the auth middleware itself (not
  per-handler), login rate limiting keyed on both username and client
  address, and per-website roles (owner/editor/viewer) layered on
  instance-wide roles (admin/user).
- **Public share links** — an unguessable id serves read-only summary stats
  for one website with no login (`GET /api/share/{shareID}`,
  `GET /api/share/{shareID}/stats}`); re-enabling sharing mints a fresh id
  so disabling it is a genuine revocation, not a soft toggle.
- **First-run bootstrap** — `POST /api/auth/bootstrap` creates the first
  admin account and is only reachable while the instance has zero users;
  `disable_signup` can also close it off explicitly.
- **Retention** — an hourly background sweep deletes whole visitor sessions
  (cascading to their events, heatmap samples and revenue rows) older than
  `retention_days`, so no orphaned rows survive to skew a later query.
- **Configuration** (`backend/internal/config`) — `athar.config.json`,
  `ATHAR_*` environment variables, and CLI flags, in that precedence order;
  unknown JSON keys are a hard startup error so a typo in a security-relevant
  key (`trust_proxy_headers`, `frame_ancestors`) fails loudly. Loopback-only
  bind by default.
- **Security headers** — a strict CSP (`script-src 'self'`, no inline
  script, no third-party origins) applied to every route except the tracker
  and collector, which are cross-origin by design and set their own
  headers; `frame_ancestors` support for embedding the dashboard behind a
  host shell (e.g. the Vulos OS).
- **PWA-installable dashboard**, dark mode, multiple websites per instance.
- Root-level OSS scaffolding: README, CONTRIBUTING, SECURITY, ROADMAP, this
  CHANGELOG, `Makefile`, `scripts/check.sh`, `scripts/gen-notices.sh`, CI and
  tag-triggered release workflows, and `docs/` (architecture, getting
  started, configuration reference, privacy threat model, self-hosting,
  Postgres deployment).

[Unreleased]: https://github.com/vul-os/athar/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vul-os/athar/releases/tag/v0.1.0
