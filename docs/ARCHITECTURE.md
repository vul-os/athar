# Architecture

Athar is a single static Go binary: a collector, a REST API, and an embedded
React dashboard, with no external services required. This document covers
the pieces worth understanding before changing them: the Store seam, the
ingest path end to end, the embed/build-tag pattern, and why the dashboard
ships as a PWA rather than a desktop app.

## Layout

```
backend/cmd/athar/        main.go, frontend_embed.go / frontend_dev.go, site_embed.go / site_dev.go
backend/internal/store/   the Store seam: one database/sql impl + a Dialect (SQLite / Postgres)
backend/internal/config/  athar.config.json + ATHAR_* env + flags
backend/internal/ingest/  collector, cookieless identity, user-agent classifier
backend/internal/geoip/   in-process MaxMind .mmdb reader
backend/internal/auth/    argon2id, sessions, CSRF, roles
backend/internal/api/     REST API
backend/internal/tracker/ athar.js + athar.min.js, embedded and served
src/                      React dashboard
site/                     static product mini-site
scripts/                  build-tracker.mjs, build-binary.mjs, check.sh, gen-notices.sh
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

Go's `embed` directive can only reach files inside the package directory it
is declared in, and a plain `go build ./...` should still produce a working
binary without requiring Node or a built frontend to exist. Athar resolves
both constraints the same way the sibling Vulos products do, with a build
tag selecting between two implementations of the same function:

- **`frontend_dev.go`** (`//go:build !embed_frontend`) — the default build.
  `newFrontendHandler()` serves the dashboard from a `dist/` directory found
  by walking up from the working directory, or prints a friendly "run
  `npm run dev`" page if none exists. This is what `go run ./backend/cmd/athar`
  and a plain `go build ./...` use.
- **`frontend_embed.go`** (`//go:build embed_frontend`) — `//go:embed dist`
  compiles a `dist/` directory that must exist *inside*
  `backend/cmd/athar/` at build time into the binary via `embed.FS`.

`scripts/build-binary.mjs` (invoked by `npm run build:all`) does the staging
this requires: it copies the repo-root `dist/` (the Vite build output) and
`site/` into `backend/cmd/athar/dist` and `backend/cmd/athar/site`, compiles
with `-tags embed_frontend`, then removes the staged copies — so the
embedded build tag only ever sees the frontend at compile time, and the
working tree has no leftover duplicate between builds. `site_embed.go` /
`site_dev.go` follow the identical pattern for the marketing mini-site
(served only when `serve_landing` is set).

The tracker script (`backend/internal/tracker/athar.min.js`) is committed
outright rather than built as part of this pipeline or gitignored — see
`backend/internal/tracker/tracker.go`'s package doc — specifically so that a
Go toolchain alone, with no Node involved, produces a binary that serves a
working (if not freshly rebuilt) tracker. `node scripts/build-tracker.mjs --check`
in CI is what keeps the committed file from silently drifting out of sync
with `athar.js`.

## Why a PWA, not a desktop app

The collector is a server process: it has to keep running to receive
beacons from visitors' browsers at any hour, on any device, for as long as
the tracked site is up. A desktop-app packaging of the dashboard would
invite exactly the wrong mental model — close the app, and it looks like
you've closed Athar, when in fact the thing that actually needs to stay
running is wherever you deployed the binary, not wherever you're viewing
the dashboard from.

A PWA is the better fit for what the dashboard actually is: a client for a
service that runs somewhere else. Installing it (`index.html`'s
`manifest.webmanifest` link) gets you an app-like icon and window on
Android, iOS, Windows, macOS and Linux from the one Vite build — no
per-platform packaging — while the collector keeps doing its job
independently of whether anyone has the dashboard open at all.
