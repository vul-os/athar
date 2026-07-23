# Architecture

## One binary

Athar builds to a single static Go binary with the React dashboard embedded via `go:embed`. There is no separate frontend process, no message queue, no cache layer, and no second language runtime needed to run it — only to build it (Node, for the dashboard bundle and the tracker script; both outputs are committed/embedded so the binary itself needs nothing at runtime).

## Request paths

```
Visitor's browser
   │  GET  /athar.js            (tracker script; ?source=1 for the readable copy)
   │  POST /api/send            (beacons — pageviews, custom events, heatmap batches)
   ▼
┌─────────────────────────────────────────────────────────────┐
│  athar (single process)                                     │
│                                                               │
│  tracker.Handler   →  serves athar.min.js / athar.js         │
│  ingest.Collector  →  parses beacons, resolves visits,       │
│                       calls Identifier + geoip, writes Store │
│  api.API           →  dashboard REST, auth, reporting        │
│  auth.Manager      →  sessions, CSRF, argon2id                │
│  store.Store       →  one interface, SQLite or Postgres      │
│  geoip.Resolver    →  local .mmdb lookup, no network call    │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
SQLite file (default)  or  Postgres (config flag, same binary)
```

Dashboard requests (logged-in operator) go through `auth.Manager.Middleware`, which authenticates the session and enforces CSRF on state-changing methods. Collector requests (`/api/send`) are unauthenticated by necessity — that's the visitor-facing endpoint — and instead bounded by a per-IP rate limiter and a strict body size cap.

## The storage seam

Everything above `store.Store` talks to a single Go interface, never to a driver directly. One `database/sql`-backed implementation serves both SQLite and Postgres; a small `Dialect` abstracts the handful of things that actually differ between them (placeholder syntax, a couple of DDL types, and which migration set applies). Two rules keep the two engines behaving identically:

- **All timestamps are integer Unix milliseconds**, never native date/time columns — driver-level time handling is the single biggest source of SQLite/Postgres divergence, and integers range-scan identically on both.
- **All primary keys are application-generated random hex strings**, never autoincrement — portable across engines, and it lets the ingest path build a whole event graph (visit → event → event data / revenue) without a round trip to get generated ids back.

Adding a third engine means writing a `Dialect` and a migration file, not a second `Store` implementation.

## Ingest path

For one beacon: parse → look up the website (cached, including negative results, so a flood of bogus website ids doesn't become a flood of database queries) → drop it if the user agent looks like a bot → compute the visitor hash (see [Privacy](./privacy.md#visitor-identity-the-daily-salt)) → find or open a visit within the session window → resolve GeoIP from the IP, then discard the IP → write the event (and any heatmap samples / revenue row) → touch the visit's last-seen time and view count.

Everything privacy-relevant about Athar is decided in this one path: no cookie is ever set, the IP is used for exactly two computations and then discarded, geography comes from a local file, and bots are dropped rather than recorded.

## Frontend

A React dashboard (Vite build) covers reporting, heatmap viewing, website and user management, and settings. It's a static bundle embedded in the binary and served at `/`; it talks only to the JSON API described in [API](./api.md) — there's no server-rendering step and no separate frontend deploy.

## What "self-hosted" means structurally

Athar never calls out to any Vulos or third-party service to function — no phone-home, no license check, no remote GeoIP or analytics-of-the-analytics. The only network calls Athar's server makes on its own are the ones you configure (Postgres, if you chose it). Everything else is local: the SQLite file or your Postgres instance, the `.mmdb` file on disk, the binary itself.
