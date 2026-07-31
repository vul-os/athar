# Changelog

All notable changes to Athar are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Heatmap-over-page-capture underlay.** The click heatmap can now draw its
  density field over a real picture of the page: an editor or owner uploads
  a full-page PNG or JPEG capture of their own page through the dashboard,
  keyed to one page and one recorded viewport width, and it composites
  underneath the heat field. This is deliberately **operator-supplied
  upload, not automatic capture** — the tracker still records only an x/y
  position, viewport size and a CSS selector per click, nothing about page
  content, and the server never fetches the tracked site. See
  `backend/internal/api/pageimages.go`'s package doc for why upload beat
  both a tracker-side DOM snapshot (would leak whatever a visitor's own
  session showed — their name, basket, order) and server-side rasterisation
  (needs a headless browser next to a one-binary-no-cgo distribution story,
  and turns the server into an SSRF surface against operator-named URLs).
  - **Migration 2** adds a `page_images` table: one row per (website, URL
    path, viewport width), image bytes stored base64-encoded in a `TEXT`
    column rather than a binary column, because SQLite (`BLOB`) and Postgres
    (`BYTEA`) have no common literal spelling — see
    [ARCHITECTURE.md](docs/ARCHITECTURE.md#the-store-seam). Re-uploading a
    capture for the same (site, path, viewport) replaces the row rather than
    accumulating a new one, and the table cascades on website deletion.
  - **Four new routes**: `GET /api/websites/{id}/page-images` (list,
    metadata only), `GET`/`PUT`/`DELETE /api/websites/{id}/page-image`
    (`?path=&viewport=`). Read access to fetch or list, editor access to
    write or delete, CSRF enforced on every write like every other
    state-changing route. The stored format is decided by **decoding the
    uploaded bytes** (`image.DecodeConfig`), never by the caller's
    `Content-Type` header, so a mislabelled or malicious upload can't become
    a same-origin content-delivery route. Served back with the decoded MIME
    type, `Content-Security-Policy: default-src 'none'; sandbox`, and an
    ETag for conditional `GET`s.
  - **Dashboard uploader** (`backend/internal/webui/static/heatmap.js`) —
    a capture panel next to the heatmap with an upload/replace/remove
    control for editors, an alignment check that warns when an image looks
    like an above-the-fold screenshot rather than a full-page one, and a
    privacy statement shown at the moment of upload: the capture lives in
    the operator's own database and is visible to every signed-in viewer of
    that website's dashboard, so it should be captured as a logged-out
    visitor would see the page. A dedicated test
    (`TestPageCaptureUploaderShipsWithItsPrivacyStatement` in
    `backend/internal/webui/embed_test.go`) fails the build if the uploader
    ships without that statement.
  - **Honest degradation, unchanged as the default.** With no capture for
    the selected page/viewport, the view falls back to the wireframe
    schematic — reconstructed from recorded selector bounding boxes, badged
    `SCHEMATIC`, captioned "not a picture of the page" — never a stale or
    foreign image. "All viewports" always shows the schematic, since a
    single image can't honestly represent two different layouts.
  - `format.bytes` (`backend/internal/webui/static/format.js`) — a small
    human-readable byte-size formatter, used by the capture panel to show
    an uploaded image's size.
  - Tests: `backend/internal/api/pageimages_test.go` (round-trip dimensions
    and bytes, replace-not-accumulate, format decided by decoding rather
    than by header, auth/CSRF guards, delete) and the store-level coverage
    in `backend/internal/store/store_test.go`.

### Changed

- **Dashboard rewritten from React 19 + Vite + Tailwind to hand-written
  HTML/CSS and plain ES modules**, embedded directly via `go:embed`
  (`backend/internal/webui/static/`, `embed.go`) instead of a built `dist/`
  bundle staged in at compile time. A plain `go build ./...` (no Node, no
  npm install) now produces a binary with a fully working dashboard; there
  is no Vite dev server any more — the dev loop is
  `go run ./backend/cmd/athar`, editing `backend/internal/webui/static/*`
  directly. Charts are now hand-built SVG (`chart.js`); the heatmap is the
  ported canvas renderer (`heatcanvas.js`/`heatmap.js`), which now also
  draws a wireframe reconstructed from real recorded selector data, with a
  viewport-width picker. The `embed_frontend` build tag was renamed
  `embed_site`, since only the marketing site is still conditionally
  embedded now — see
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#the-embed--build-tag-pattern). The
  JS test gate moved from vitest to `node --test` accordingly — see
  Internal, below.

### Removed

- **The dashboard's PWA.** `manifest.webmanifest`, the service worker, and
  the PNG/`apple-touch-icon` app icons are gone — the service worker's
  offline cache and update/staleness handling was real, ongoing complexity
  for a dashboard that is otherwise build-free. The dashboard is now a plain
  web page; see Changed, above. Not abandoned: installability (manifest +
  icons, cheap) is planned to come back separately from offline support
  (service worker, cache invalidation, materially bigger and of limited
  value for a dashboard whose whole purpose is showing live state) — see
  [ROADMAP.md](ROADMAP.md#near-term).
- The React (`src/`), Vite, Tailwind, vitest and ESLint toolchain —
  `vite.config.js`, `eslint.config.js`, the repo-root `index.html`, and the
  committed `dist/` bundle. The dashboard's webfonts (`@fontsource`
  packages) are gone too; it now uses the system font stack.
- `auth.ErrTOTPRequired` and `auth.ErrTOTPInvalid` — declared but returned by
  no code path, which made the login flow read as two-factor-aware when it is
  not. TOTP remains persistence-only scaffolding; see
  [ROADMAP.md](ROADMAP.md#near-term).
- Unreferenced dashboard API-client wrappers (`api.health`, `api.setShare`,
  `api.deleteWebsite`). The endpoints themselves are unchanged, implemented
  and tested; no dashboard screen calls them yet.

### Fixed

- **`GET /api/health` no longer fingerprints the instance to anonymous
  callers.** The public response is now `{ ok }` — liveness and database
  reachability. `version` and `store` are still returned, but only to an
  authenticated caller. The build version tells a scanner which advisories
  apply to a box, and the engine name (`"sqlite"` / `"postgres"`) is the
  Store seam's internal vocabulary, which nothing outside the binary should
  be branching on. Monitoring that checks `ok` or the status code is
  unaffected; anything parsing `version` off the public endpoint must
  authenticate.
- Documentation reconciled with the code: the retention sweep is hourly, not
  daily; `frame_ancestors` always emits a CSP `frame-ancestors` directive;
  the heatmap dashboard view shipped in 0.1.0 (the page-capture underlay
  above shipped later, in this same unreleased cycle); and share links,
  website deletion, password change and user administration are marked
  API-only, since the dashboard has no screen for them.

### Internal

- `make check` and CI gate on `gofmt -l backend/` (tests its *output* rather
  than its exit status, which is always 0) and on the dashboard's JS tests —
  now `node --test scripts/jstest/*.test.mjs`, not `npm test` (vitest); see
  Changed, above, for why. Node's test runner exits 0 on an empty glob rather
  than failing the way vitest did on zero matched files, so the gate expands
  the glob explicitly and fails if it matches nothing — the JS step still
  cannot pass by running nothing. 34 tests cover
  `backend/internal/webui/static/format.js` and `.../countries.js`, one
  export-set assertion per module so an untested export fails the suite.

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
