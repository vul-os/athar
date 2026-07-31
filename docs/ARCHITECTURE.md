# Architecture

Athar is a single static Go binary: a collector, a REST API, and an embedded
dashboard — hand-written HTML, CSS and plain ES modules, no framework — with
no external services required. This document covers the pieces worth
understanding before changing them: the Store seam, the ingest path end to
end, the embed/build-tag pattern, and why the dashboard has no build step.

## Layout

```
backend/cmd/athar/        main.go, frontend.go, site_embed.go / site_dev.go
backend/internal/store/   the Store seam: one database/sql impl + a Dialect (SQLite / Postgres)
backend/internal/config/  athar.config.json + ATHAR_* env + flags
backend/internal/ingest/  collector, cookieless identity, user-agent classifier
backend/internal/geoip/   in-process MaxMind .mmdb reader
backend/internal/auth/    argon2id, sessions, CSRF, roles
backend/internal/api/     REST API
backend/internal/tracker/ athar.js + athar.min.js, embedded and served
backend/internal/webui/   hand-written dashboard (static/, embed.go) — embedded unconditionally
site/                     static product mini-site
scripts/                  build-tracker.mjs, build-binary.mjs, check.sh, gen-notices.sh, jstest/
```

## The Store seam

Athar runs the same binary in two very different places: on a box someone
owns (SQLite, zero setup, no daemon) and in a hosted environment (Postgres,
managed, pooled). That difference is a config value
(`database` — see [CONFIGURATION.md](CONFIGURATION.md)), not a fork.
Everything above `backend/internal/store` talks to a single `Store`
interface (`backend/internal/store/store.go`) and never to a driver
directly.

The implementation is shared, not duplicated: one `database/sql`-backed type
(`sqlStore` in `sql.go`) serves both engines, and a small `Dialect`
interface (`dialect.go`) abstracts the three things that actually differ
between SQLite and Postgres:

- **Placeholder syntax** — `?` for SQLite, `$1, $2, …` for Postgres
  (`Dialect.Rebind`).
- **Driver name to open with** — `sqlite` (`modernc.org/sqlite`) or `pgx`.
- **Time-bucket flooring for the series query** — both dialects use the same
  integer-division expression on the epoch-millisecond column
  (`(col / bucket_ms) * bucket_ms`) rather than each engine's native date
  functions, so client and database can never disagree about which bucket a
  borderline event lands in.

Everything else — every query in `sql.go`, and the entire schema in
`migrations.go` — is written once, in the subset of SQL both engines accept
literally (`TEXT`, `INTEGER`, `BIGINT`, `DOUBLE PRECISION`,
`CREATE TABLE IF NOT EXISTS`, partial indexes, `ON DELETE CASCADE`). Adding a
third engine means writing a `Dialect` and, if the schema needs it, a new
migration — not a second `Store` implementation.

### What makes this a seam and not just an interface

Three rules, and a seam that breaks any of them stops being one. They are
restated here rather than imported from anywhere, because a shared *paragraph*
costs nothing and a shared *package* would couple every product that used it:

1. **The seam depends on nothing.** `backend/internal/store` imports the
   standard library and two database drivers, and nothing of Athar's. Nothing
   in it knows about beacons, sessions, heatmaps or HTTP — it knows about rows.
   A seam that imports the thing it is a seam for is a layering diagram, not a
   boundary.
2. **The default implementation works with zero external services.** `./athar`
   with no configuration opens a SQLite file. There is no service to stand up,
   no daemon, no account, no network call. Postgres is an *option* someone
   opts into by writing a DSN — the shape that needs infrastructure is never
   the shape you get by default.
3. **No provider name inside a type the seam exports.** Naming a specific
   engine in a method signature, a field, or a wire response exports that
   provider's jurisdiction to everyone downstream: every caller who branches on
   it, and every future implementation, now has to care which product Athar's
   operator chose. `Store.Dialect()` returns an engine string, which is the one
   place this could leak; it exists so the process can log what it opened, and
   it is deliberately not published to unauthenticated callers — see
   `handleHealth` in `backend/internal/api/api.go`, where the engine name and
   the build version are reported only to a logged-in operator.

The same three rules are why `geoip.Resolver` looks the way it does: its zero
value is a working resolver that returns an empty `Location`, so "no database
configured" is the ordinary path rather than an error case, and the alternative
every hosted analytics product reaches for — a geolocation API call — would
have broken rule 2 outright.

### Two portability rules

Keeping one schema honest across two engines depends on two rules, and both
are load-bearing:

1. **All timestamps are stored as integer Unix milliseconds**, never as a
   native date/time column. Driver-level time handling is the single
   biggest source of SQLite/Postgres divergence in practice (timezone
   handling, precision, how each driver marshals `time.Time`); integers
   behave identically on both and range-scan just as well.
2. **All primary keys are application-generated random hex strings**
   (`store.NewID()`, 16 bytes of `crypto/rand`, hex-encoded), never
   autoincrement. This is portable across engines, and — just as
   importantly for the ingest hot path — it lets the collector build an
   entire visit/event/heatmap-sample graph and hand every row its final ID
   before the first insert, with no round trip to read back a generated key.

A migration is never edited after release; a schema change is always a new
entry appended to the `migrations` slice in `migrations.go`, applied inside
one transaction per step and recorded in an `athar_migrations` ledger table
so it runs exactly once per database.

### Migration 2: `page_images`, and why the bytes are base64 in `TEXT`

Migration 2 adds `page_images` — one row per (website, URL path, viewport
width), holding an operator-uploaded picture of that page for the heatmap
dashboard view to composite its click density field over (see
`backend/internal/api/pageimages.go` for the feature; `docs/PRIVACY.md` for
why this doesn't compromise the tracker's no-page-content guarantee). It's a
direct test of the Store seam's two-engine promise: the column holding the
actual image bytes (`data_b64`) is `TEXT`, not a binary column, and that's
deliberate rather than an oversight.

SQLite spells a binary column `BLOB`; Postgres spells it `BYTEA`. There is
no literal spelling both accept, so a real binary column would need its own
`Dialect` method — exactly the growth `dialect.go`'s own doc comment warns
against ("if a `Dialect` ever needs a method like 'rewrite this SELECT', the
query has drifted out of the portable subset and should be rewritten
instead of accommodated here"). Base64-encoding the bytes and storing them
in `TEXT` costs 33% more on disk than a native binary column would, and
round-trips identically on both engines with no dialect-specific code at
all — the same trade the two portability rules above already make for
timestamps and primary keys. Uploads are capped (`maxPageImageBytes`, 8 MiB
before encoding) and one capture per (website, path, viewport) replaces
rather than accumulates, so the cost is bounded by how many distinct pages
and viewports an operator chooses to capture, not by traffic.

The table cascades on website deletion (`ON DELETE CASCADE`), the same as
every other per-website table.

## The ingest path

A beacon's trip from `athar.js` to a stored row, in order
(`backend/internal/ingest/collector.go`):

1. **`Collector.Handler()`** answers `OPTIONS` immediately (CORS preflight),
   rejects non-`POST` methods, and reads the User-Agent to classify and drop
   recognised bots — before touching the body.
2. The client IP is extracted (`geoip.ClientIP`, honouring
   `trust_proxy_headers`) and checked against a per-IP token-bucket rate
   limiter (60-request burst, 5/s sustained).
3. The JSON body is decoded into a `{type, payload}` envelope, bounded to
   128 KiB by `http.MaxBytesReader`.
4. **`Collector.Process`** resolves the website by id (through a 5-minute
   in-memory cache that also caches negative lookups, so a flood of beacons
   for a bogus id doesn't become a flood of database queries), then calls
   **`resolveVisit`**:
   - Computes the visitor hash (`Identifier.VisitorHash` — see
     [PRIVACY.md](PRIVACY.md) for the construction).
   - Looks for a live visit — one with this hash and a `last_at` within the
     configured `session_window` (default 30 minutes) — via
     `GetVisitByHash`.
   - If none exists, resolves geography from the IP (`geoip.Resolver`),
     classifies the user agent, and creates a new `visits` row. **This is
     the last point at which the raw IP exists anywhere in the process** —
     it goes into the hash and the GeoIP lookup and nothing else; it is
     never passed further down the call stack.
5. Depending on beacon type, either **`recordEvent`** (a pageview or a named
   custom event, plus optional properties and a revenue row) or
   **`recordHeat`** (up to 500 heatmap samples per beacon) is written, and
   the visit's `last_at` — and, for a pageview, its view count — is updated
   via `TouchVisit`.
6. The handler responds `204 No Content` for success **and** for a
   malformed or unknown-website beacon alike, so the collector can never be
   used as an oracle for which website ids are real, and a broken
   integration never surfaces an error to a visitor.

Everything privacy-relevant about Athar is decided inside this package. If a
change to it would make the raw IP reachable past step 4, or make a stored
row reversible to an IP, or make two days' hashes for the same visitor
linkable, the change is wrong — see [PRIVACY.md](PRIVACY.md) and
[SECURITY.md](../SECURITY.md).

## The embed / build-tag pattern

The dashboard is embedded unconditionally: `backend/internal/webui/embed.go`
does a plain `//go:embed static` on `backend/internal/webui/static/` (its
own hand-written HTML/CSS/JS, checked into this repository, not a build
artifact) and `backend/cmd/athar/frontend.go` hands that straight to
`http.FileServer`. There is no build tag and no dev/embed split for it — a
plain `go build ./...` (no Node, no npm) already produces a binary with a
fully working dashboard.

Only the marketing mini-site still needs the build-tag trick, because `site/`
is a standalone static tree outside the `backend/internal/webui` package
directory, and Go's `embed` directive can only reach files inside the
package directory it's declared in:

- **`site_dev.go`** (`//go:build !embed_site`) — the default build.
  `newSiteHandler()` serves `site/` from disk, found by walking up from the
  working directory, or mounts nothing at `/site/` if it isn't found. This
  is what `go run ./backend/cmd/athar` and a plain `go build ./...` use.
- **`site_embed.go`** (`//go:build embed_site`) — `//go:embed site` compiles
  a `site/` directory that must exist *inside* `backend/cmd/athar/` at build
  time into the binary via `embed.FS`.

`scripts/build-binary.mjs` (invoked by `npm run build`) does the staging
this requires: it copies the repo-root `site/` into `backend/cmd/athar/site`,
compiles with `-tags embed_site`, then removes the staged copy — so the
embedded build tag only ever sees the site at compile time, and the working
tree has no leftover duplicate between builds. This build tag was renamed
from `embed_frontend` to `embed_site` when the dashboard stopped being
conditional — only the marketing site is optional now.

The tracker script (`backend/internal/tracker/athar.min.js`) is committed
outright rather than built as part of this pipeline or gitignored — see
`backend/internal/tracker/tracker.go`'s package doc — specifically so that a
Go toolchain alone, with no Node involved, produces a binary that serves
both a working (if not freshly rebuilt) tracker and a fully working
dashboard: `go build -o athar ./backend/cmd/athar` alone is a complete,
runnable self-host build. `node scripts/build-tracker.mjs --check` in CI is
what keeps the committed tracker file from silently drifting out of sync
with `athar.js`.

## Why the dashboard has no build step

The dashboard used to be a React 19 + Vite + Tailwind single-page app,
embedded as a built `dist/` bundle behind the `embed_frontend` tag described
above. It is now hand-written HTML, CSS and plain ES modules
(`backend/internal/webui/static/`: `index.html`, `ui.css`, and modules like
`app.js`, `dom.js`, `api.js`, `theme.js`, `format.js`, `countries.js`,
`chart.js` for hand-built SVG charts, and `heatcanvas.js`/`heatmap.js` for
the heatmap canvas renderer) served directly via `go:embed`. There is no
compiler between the source you edit and the bytes the browser receives, so
"edit a file under `static/`, restart `go run ./backend/cmd/athar`" is the
entire dev loop — no separate frontend process, no `dist/` that can drift
out of sync with a source tree the way it used to.

This also removed the dashboard's PWA: `manifest.webmanifest`, the service
worker, and the app icons existed to make an installable app out of what is
fundamentally a thin client for a server process that has to keep running
regardless of whether anyone has the dashboard open. Installability wasn't
earning its complexity, so the dashboard is now a plain web page — open it
in a browser tab from wherever it's reachable, on any device, no
per-platform packaging and nothing to install.
