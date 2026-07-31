# Athar Roadmap

Athar is a self-hosted web analytics tool maintained by [Vulos](https://vulos.org):
a single Go binary (dashboard embedded via `go:embed`, no cgo) that collects
cookieless, no-PII analytics with heatmaps and basic ecommerce tooling, backed
by SQLite or Postgres behind one interface (the "Store seam" — see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

This file exists to be honest about what already works (don't re-build it)
and what's genuinely still open. See [README.md](README.md#features) for the
authoritative, user-facing feature list and [CHANGELOG.md](CHANGELOG.md) for
what has actually shipped, release by release.

---

## Shipped in 0.1.0

Verified end-to-end (collector → store → dashboard) before release:

- **Cookieless, no-PII tracking.** The tracker sets no cookie and touches no
  storage. Visitor identity is `HMAC(salt, website_id ‖ ip ‖ user_agent)`
  with `salt = HMAC(instance_secret, YYYY-MM-DD)`, rotating at UTC midnight —
  unlinkable across days by construction. The raw IP is used only to compute
  the hash and the GeoIP lookup, then discarded; it is never written to the
  database or a log.
- **In-process GeoIP** from a local MaxMind-format `.mmdb` (DB-IP Lite or
  GeoLite2) — no network call, no service. Not bundled (size and licence);
  unset means the location fields are simply empty.
- **The tracker itself** — 3.3 KB raw, 1.6 KB gzipped. Automatic pageviews
  (including SPA route changes via `pushState`/`replaceState`/`popstate`),
  custom events, revenue events, and click / scroll / attention heatmap
  sampling. Served at a configurable path (`/athar.js` by default), with
  `?source=1` serving the readable original so anyone can check what a site
  is actually running.
- **Bot filtering** at ingest — bot traffic is dropped, not recorded.
- **Reporting**: pageviews, unique visitors, sessions, bounce rate, average
  visit time; top pages, entry/exit pages, referrers, UTM campaigns;
  browser/OS/device/screen/language breakdowns; country/region/city; custom
  events; realtime active-visitor count; revenue totals per currency
  (integer minor units — never summed across currencies, never floats).
- **Auth**: argon2id (64 MiB, t=2, tuned parallelism), server-side sessions
  (only a SHA-256 of the token is stored), httpOnly + `SameSite=Lax`
  cookies, double-submit CSRF on every state-changing route, login rate
  limiting keyed on username *and* client address, per-website roles
  (owner/editor/viewer) layered on instance roles (admin/user). Fail-closed
  throughout.
- **The heatmap dashboard view** — click, scroll-depth and attention modes,
  with a page picker driven by the top-pages metric. The click map is drawn
  as a density field on a proportional frame, with the clicked elements
  listed beside it as CSS selectors.
- **Public share links** — an unguessable id serves read-only summary stats
  for one website with no login; re-enabling sharing mints a fresh id, so
  disabling it is a real revocation. **Server-side and API-only**: mint and
  revoke via `POST /api/websites/{id}/share`; the dashboard has no toggle for
  it yet (Near-term below).
- **Retention** — deletes whole visitor sessions (cascading to their events,
  heatmap samples and revenue rows) past a configurable age, so no
  orphaned rows skew a later bounce-rate calculation.
- **Multiple websites per instance**, a REST API, dark-mode dashboard.
- **The Store seam** — SQLite (zero setup, self-host default) or Postgres
  (`postgres://` DSN), same binary, chosen by the `database` config value.

---

## On main, unreleased

Built, tested, and sitting on `main` — but not in the 0.1.0 you can
download today. Lands in the next release.

- **Heatmap-over-page-capture underlay.** The click heatmap can now draw its
  density field over a real picture of the page, not only the wireframe. The
  picture is **operator-supplied upload, not automatic capture**: an editor
  takes a full-page screenshot of their own page and uploads it through the
  dashboard (`PUT /api/websites/{id}/page-image?path=…&viewport=…`), one
  image per (site, path, viewport width), replaced rather than accumulated.
  Athar's tracker still captures nothing about page content — no DOM
  snapshot, no HTML, no text, no form values — and the server never fetches
  the tracked site; a capture exists only because a human produced and
  uploaded it. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
  `page_images` table and
  [backend/internal/api/pageimages.go](backend/internal/api/pageimages.go)
  for why upload beat both a tracker-side DOM snapshot and server-side
  rasterisation (the two alternatives, and why each was rejected).
  **This is not the session-replay item in Non-goals below** — see that
  entry for the distinction.
- **Honest degradation stays the default.** With no capture for the selected
  page and viewport, the heatmap shows the wireframe schematic, badged
  `SCHEMATIC` and captioned "not a picture of the page" — never another
  page's or another viewport's image. "All viewports" always shows the
  schematic: averaging a 390px and a 1440px layout onto one picture would be
  exactly the authoritative-looking lie this feature exists to avoid.
- **Capture management lives in the dashboard**, gated to editor/owner
  access with CSRF enforced like every other write, and states the privacy
  consequence — that anything visible in the capture becomes visible to
  every viewer of the dashboard — at the point of upload, not in a
  disclosure triangle.

---

## Near-term

Genuinely unfinished, prioritised roughly by how often it's asked for:

- **PWA reinstatement — installability, deliberately without the offline
  machinery.** v0.1.0 shipped an installable PWA (`manifest.webmanifest`, a
  service worker, app icons); it was removed in the rewrite from a React
  dashboard to hand-written HTML/CSS/JS embedded in the binary (see
  [CHANGELOG.md](CHANGELOG.md)), because the service worker's offline cache
  and its update/staleness handling was real, ongoing complexity in a
  dashboard that is otherwise build-free and has no compiled bundle to go
  stale against. That removal bundled two different jobs together, which is
  what made it look cheaper to drop than it is to bring back:
  **installability** — a web manifest plus a couple of app icons, so the
  dashboard gets a home-screen icon and its own window — is nearly free.
  **Offline support** — a service worker, a cache to invalidate, an update
  cycle to reason about — is materially bigger, and it isn't implied by the
  first. It's also of limited value here regardless of cost: the dashboard's
  entire purpose is showing live server state, and an offline copy of that
  is a stale copy. The plan is to bring back the manifest and icons; the
  service worker stays out unless a concrete case for it shows up.
- **Website settings UI** — enabling/revoking a share link
  (`POST /api/websites/{id}/share`) and deleting a website
  (`DELETE /api/websites/{id}`) are enforced and tested server-side, but the
  dashboard has no screen for either; both are API-only today.
- **Funnels** — including a cart/checkout funnel for the ecommerce data
  Athar already collects (revenue events exist; funnel *analysis* of them
  does not).
- **Segmentation / filtering UI** — slicing a report by browser, country,
  referrer, etc. from the dashboard, rather than one metric at a time via
  the API.
- **TOTP two-factor enrolment.** What exists today is persistence only:
  the `users.totp_secret` column, `store.UpdateUserTOTP`, and `GET /api/me`
  reporting `totp: false`. Nothing generates, stores or verifies a code —
  the login path has no second factor at any point. The enrolment flow (QR
  code, secret generation, verification step in login) is entirely unbuilt.
- **Teams UI** — per-website roles already exist in the schema and are
  enforced server-side (`WebsiteAccess`, `website_users`); there is no
  dashboard screen yet to invite a user onto a website or manage their role.
- **Account & user administration UI** — changing your own password
  (`POST /api/me/password`) and the admin user CRUD (`GET`/`POST /api/users`,
  `DELETE /api/users/{id}`) are implemented, authenticated and tested, but
  nothing in the dashboard calls them. The dashboard today is: first-run
  setup, login, the reporting overview, the heatmap views, and adding a
  website.
- **Data export / import.**
- **Browser end-to-end tests** driving the actual production bundle, the way
  the sibling Vulos products do.
- **Docker image** — today "self-host Athar" means "build or download the
  binary"; a maintained image and compose file are not published yet.

---

## Later / exploratory

- **Session insight via rrweb** — session replay is explicitly *not* how
  Athar's heatmaps work today (no DOM snapshot, no keystrokes, no text is
  ever captured); a separate, clearly-scoped replay feature is a future
  discussion, not an extension of the existing heatmap sampler.
- **Richer ecommerce events** — product-level and cart-level events beyond
  the current single "revenue event per order" shape.
- **Alerting** — threshold or anomaly notifications on top of the existing
  metrics.
- **Additional Store engines.** The two portability rules (epoch-millisecond
  timestamps, application-generated primary keys) exist specifically so that
  a third engine is a new `Dialect` + migration, not a fork — see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-store-seam). Nothing
  concrete is planned; the point of the roadmap note is that a new deployment
  shape is expected to stay a config change.

---

## Non-goals

- **Session replay as currently scoped for heatmaps.** The click/scroll/
  attention sampler is deliberately not a DOM recorder; conflating the two
  would quietly turn a privacy-first tool into one that captures page
  content. **This is not the same thing as the page-capture upload above.**
  An operator uploading a picture of their own page is a manual, occasional,
  human-produced action with no tracker involvement at all; session replay
  would mean the tracker itself recording a visitor's DOM automatically, on
  every session. The upload feature adds no tracker-side capture of any
  kind — it is still true that the tracker records only coordinates and a
  selector, never DOM content.
- **A hosted, multi-tenant SaaS as the primary product.** Athar's whole
  premise is that your visitors' data stays on infrastructure you control;
  the Postgres option exists for *your own* cloud deployment via the Store
  seam, not for Vulos to run a shared instance on your behalf.
- **Cross-day visitor tracking.** The daily salt rotation is load-bearing,
  not a placeholder for a "remember visitors longer" setting — see
  [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Notes for contributors

- Keep `make check` green on every change (`gofmt`, `go build`, `go vet`,
  `go test`, the tracker up-to-date check, and the dashboard's
  `node --test scripts/jstest/*.test.mjs` suite).
- Anything touching `backend/internal/ingest` or `backend/internal/auth` is
  security-sensitive by definition — see [SECURITY.md](SECURITY.md) and
  [CONTRIBUTING.md](CONTRIBUTING.md#scope-what-we-say-yes-and-no-to) for the
  frozen invariants (no cgo, no raw IP at rest, no cookies from the tracker,
  nothing that phones home).
