# API

Athar's dashboard talks to itself over a REST API, which is also yours to use. Three trust zones:

| Prefix | Guard |
|---|---|
| `/api/auth/*`, `/api/health` | public, some routes rate-limited |
| `/api/share/*` | public, but scoped to one website by an unguessable share id |
| everything else under `/api/` | session cookie required, plus CSRF on state-changing methods |

## Auth & session

Login issues two cookies: `athar_session` (httpOnly, the real credential — only a SHA-256 hash of its value is stored server-side) and `athar_csrf` (readable by JavaScript on purpose). For any non-`GET`/`HEAD`/`OPTIONS` request to an authenticated route, echo the CSRF cookie's value back in the **`X-Athar-CSRF`** header — a request missing it or carrying a mismatched value gets `403`. This is checked in shared middleware ahead of every handler, so a new authenticated route is protected by construction, not by remembering to add a check to it.

### `GET /api/health`
Public. `{ ok }` — liveness and database reachability, and deliberately nothing more: the build version and the storage engine are fingerprints, so an anonymous caller gets neither. Returns `503` if the database is unreachable. An **authenticated** caller gets `{ ok, version, store }`.

### `POST /api/auth/login`
Public, rate-limited on username **and** client address together (guessing at one known account, or spraying one password across many accounts, both hit a limit). Body: `{ username, password }`. `401` with the same message for "no such user" and "wrong password" — telling them apart is a username oracle.

### `GET /api/auth/status`
Public. `{ needs_setup, authenticated, signup_blocked }` — tells the dashboard whether to show a login form or the first-run setup form. Never reveals a username, only whether *any* account exists.

### `POST /api/auth/bootstrap`
Public, but only succeeds while the instance has zero users — the check is against the live user count on every call, not a flag decided at boot, so it can't be used to add a second account later. Body: `{ username, password }` (username 2–64 chars, no whitespace; password 12–512 chars). Creates the first account as `admin` and logs it in.

### `POST /api/auth/logout`
Authenticated. Ends the current session.

### `GET /api/me`
Authenticated. The caller's own user record (password hash and TOTP secret are never included — omitted by construction, not by a field tag, so a new field can't accidentally leak).

### `POST /api/me/password`
Authenticated. Body: `{ current, new }`. Verifies the current password, then rehashes and **invalidates every other session for the user** — a password change that didn't evict other sessions wouldn't actually be a password change.

## Websites

### `GET /api/websites`
Authenticated. Lists websites the caller owns or has been granted a role on (admins see all). Each entry includes `access`: `owner` / `editor` / `viewer`.

### `POST /api/websites`
Authenticated. Body: `{ name, domain }`. Creates a website owned by the caller.

### `GET /api/websites/{id}`
Authenticated, requires at least `viewer` access.

### `PATCH /api/websites/{id}`
Authenticated, requires `editor` access. Body: `{ name, domain }` (either field optional).

### `DELETE /api/websites/{id}`
Authenticated, requires `owner` access. Cascades to every visit, event, heatmap sample and revenue row the website owns.

Every website route resolves access before touching the row, and a caller without access gets `404`, never `403` — a `403` would confirm the id exists, which turns the id space into something worth probing.

### `POST /api/websites/{id}/share`
Authenticated, requires `editor` access. Body: `{ enabled }`. Enabling always mints a **fresh** share id rather than reusing a previous one — so disabling sharing and re-enabling it later does not resurrect an old link.

## Stats endpoints

All of the following require at least `viewer` access to `{id}`, and accept `?from=&to=` as **Unix milliseconds** (default: last 24 hours; range capped at two years — an unbounded range is a table scan a public share-link visitor could otherwise trigger for free).

### `GET /api/websites/{id}/stats`
Headline summary: `pageviews, visits, visitors, bounces, bounce_rate, avg_visit_seconds, total_time_seconds, from, to`.

### `GET /api/websites/{id}/series`
Time series. `?interval=hour|day` (default: hourly under a 48-hour range, daily above it). Gaps are filled server-side — a missing bucket in the response always means zero traffic, never "no data," so a chart doesn't have to guess.

### `GET /api/websites/{id}/metrics`
Top-N breakdown. `?metric=` one of: `path, entry_path, exit_path, referrer, browser, os, device, screen, language, country, region, city, utm_source, utm_medium, utm_campaign, event`. `?limit=` (default 20, max 500).

### `GET /api/websites/{id}/active`
`{ active }` — distinct visitors seen in the last 5 minutes.

### `GET /api/websites/{id}/heatmap`
`?path=` (required) `&kind=click|scroll|attn` (default `click`) `&from=&to=&limit=` (default 5000, max 50000). Returns raw samples — coordinates, viewport size, scroll/dwell, selector — never page content. See [Heatmaps](./heatmaps.md).

### `GET /api/websites/{id}/revenue`
`{ totals: [{ currency, amount_minor }] }`. See [Ecommerce](./ecommerce.md).

## Users (admin only)

`GET /api/users`, `POST /api/users` (`{ username, password, role }`), `DELETE /api/users/{id}` — all require the instance `admin` role. Deleting your own account is refused: bootstrap only works on an empty instance, so an admin-less instance with users already in it would have no way to make a new one.

## Public share links

Scoped entirely by the unguessable `{shareID}` in the path — a share handler never touches a caller-supplied website id, so a share link can't be pivoted into reading a different site.

### `GET /api/share/{shareID}`
`{ name, domain, share_id, created_at }` — the site's own internal id and owner are never included, so this response can't be turned into an authenticated-API identifier.

### `GET /api/share/{shareID}/stats`
The same summary shape as `GET /api/websites/{id}/stats`, for the shared site.

## Collector

### `POST /api/send`
Public, unauthenticated by necessity — this is what the tracker script calls. Rate-limited per IP (burst of 60, sustained 5/sec). Body is the tracker's `{type, payload}` envelope; see [Tracker script](./tracker.md). Always answers `204 No Content`, on success *and* on most failures (unknown website id, malformed body) — a beacon endpoint must never surface an error into a visitor's console, and answering differently for a bad website id vs. a good one would make the id space enumerable.

### `GET /athar.js`
Serves the tracker script — minified by default, or the readable source with `?source=1`. See [Tracker script](./tracker.md).
