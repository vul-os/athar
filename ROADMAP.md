# Athar Roadmap

Athar is a self-hosted web analytics tool maintained by [Vulos](https://vulos.org):
a single Go binary (embedded React dashboard, no cgo) that collects
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
- **Public share links** — an unguessable id serves read-only summary stats
  for one website with no login; re-enabling sharing mints a fresh id, so
  disabling it is a real revocation.
- **Retention** — deletes whole visitor sessions (cascading to their events,
  heatmap samples and revenue rows) past a configurable age, so no
  orphaned rows skew a later bounce-rate calculation.
- **Multiple websites per instance**, a REST API, dark-mode dashboard
  installable as a **PWA**.
- **The Store seam** — SQLite (zero setup, self-host default) or Postgres
  (`postgres://` DSN), same binary, chosen by the `database` config value.

---

## Near-term

Genuinely unfinished, prioritised roughly by how often it's asked for:

- **Heatmap overlay rendering UI** — the collector and the `/api/websites/{id}/heatmap`
  endpoint already return raw click/scroll/attention samples; the dashboard
  visualisation that overlays them on a page screenshot is not built yet.
- **Funnels** — including a cart/checkout funnel for the ecommerce data
  Athar already collects (revenue events exist; funnel *analysis* of them
  does not).
- **Segmentation / filtering UI** — slicing a report by browser, country,
  referrer, etc. from the dashboard, rather than one metric at a time via
  the API.
- **TOTP two-factor enrolment.** `store.User.TOTPSecret` and the
  `ErrTOTPRequired` / `ErrTOTPInvalid` error values already exist in the
  auth package; the enrolment flow (QR code, secret generation, verification
  step in login) does not.
- **Teams UI** — per-website roles already exist in the schema and are
  enforced server-side (`WebsiteAccess`, `website_users`); there is no
  dashboard screen yet to invite a user onto a website or manage their role.
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
  content.
- **A hosted, multi-tenant SaaS as the primary product.** Athar's whole
  premise is that your visitors' data stays on infrastructure you control;
  the Postgres option exists for *your own* cloud deployment via the Store
  seam, not for Vulos to run a shared instance on your behalf.
- **Cross-day visitor tracking.** The daily salt rotation is load-bearing,
  not a placeholder for a "remember visitors longer" setting — see
  [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Notes for contributors

- Keep `make check` green on every change (`go build`, `go vet`, `go test`,
  the tracker up-to-date check, `npm run lint`, `npm run build`).
- Anything touching `backend/internal/ingest` or `backend/internal/auth` is
  security-sensitive by definition — see [SECURITY.md](SECURITY.md) and
  [CONTRIBUTING.md](CONTRIBUTING.md#scope-what-we-say-yes-and-no-to) for the
  frozen invariants (no cgo, no raw IP at rest, no cookies from the tracker,
  nothing that phones home).
