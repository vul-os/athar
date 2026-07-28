# Configuration

Athar needs no configuration to run. Every key below has a working default
(`backend/internal/config/config.go`'s `Default()`), and the config file
itself is optional — an analytics collector that refuses to boot without one
would be hostile to the "just run it on your box" path this project exists
for.

## Precedence

Lowest to highest: **built-in defaults → `athar.config.json` → `ATHAR_*`
environment variables → command-line flags.** Environment wins over the file
so a container can override a baked-in config without rebuilding it; flags
win over everything so an operator debugging a live box always gets the
last word.

## The config file

`athar.config.json` is searched for, in order:

1. The working directory, then each of its parents in turn.
2. `~/.config/athar/athar.config.json`.
3. The directory the binary itself lives in.

The first one found is used; the rest are not merged in. It's plain JSON:

```json
{
  "host": "127.0.0.1",
  "port": "3100",
  "database": "athar.db",
  "session_window": "30m",
  "retention_days": 90
}
```

**Unknown keys are a hard startup error.** The decoder uses
`json.Decoder.DisallowUnknownFields()` specifically so a typo in a
security-relevant key — `trust_proxy_headers` misspelled as
`trust_proxy_header`, say — fails loudly at boot instead of being silently
ignored while the operator believes it's in effect.

## Reference

| Key | Env | Flag | Type | Default | Notes |
|---|---|---|---|---|---|
| `host` | `ATHAR_HOST` | `--host` | string | `127.0.0.1` | Bind address. Deliberately loopback-only by default even though Athar must eventually receive beacons from the internet — see [SELF-HOSTING.md](SELF-HOSTING.md). |
| `port` | `ATHAR_PORT` | `--port` | string | `3100` | HTTP port. Must parse as a number; validated at startup. |
| `database` | `ATHAR_DATABASE` | `--db` | string | `athar.db` | Store DSN. A bare path or `sqlite://path` is SQLite; `postgres://…` or `postgresql://…` is Postgres. Empty resolves to `athar.db`. |
| `geoip_path` | `ATHAR_GEOIP_PATH` | `--geoip` | string | *(empty)* | Path to a MaxMind-format `.mmdb`. Empty disables geo resolution entirely — no download is ever attempted. Startup fails if a non-empty path isn't readable. |
| `tracker_path` | `ATHAR_TRACKER_PATH` | — | string | `/athar.js` | Where the tracker script is served. Must be distinct from `collect_path` (validated). |
| `collect_path` | `ATHAR_COLLECT_PATH` | — | string | `/api/send` | Where the tracker POSTs beacons. |
| `session_window` | `ATHAR_SESSION_WINDOW` | — | duration | `30m` | Idle gap before the next pageview from the same visitor hash starts a *new* visitor session, rather than extending the current one. |
| `session_ttl` | `ATHAR_SESSION_TTL` | — | duration | `24h` | Idle lifetime of a *dashboard login* session (not a visitor session) — sliding, refreshed on use. |
| `retention_days` | `ATHAR_RETENTION_DAYS` | — | int | `0` | `0` keeps data forever. A positive value runs an hourly sweep that deletes whole visitor sessions (cascading events/heatmap samples/revenue) older than N days. |
| `trust_proxy_headers` | `ATHAR_TRUST_PROXY_HEADERS` | — | bool | `false` | See [SELF-HOSTING.md](SELF-HOSTING.md#trust_proxy_headers) — this is a security-relevant default, not a convenience one. |
| `frame_ancestors` | `ATHAR_FRAME_ANCESTORS` | — | string | *(empty)* | Space-separated CSP origin allow-list for embedding the dashboard in an iframe. The CSP always carries a `frame-ancestors` directive: empty sends `frame-ancestors 'self'` **and** `X-Frame-Options: DENY`, any other value sends `frame-ancestors <value>` and drops `X-Frame-Options` (a browser that honours both ignores the legacy header whenever `frame-ancestors` is present). Either way, no cross-origin framing without an explicit allow-list. |
| `serve_landing` | `ATHAR_SERVE_LANDING` | — | bool | `false` | Serves the embedded marketing mini-site at `/` and `/site/*`. A self-hosted instance normally wants the dashboard at `/`, not a landing page — this is for the hosted/cloud shape. |
| `disable_signup` | `ATHAR_DISABLE_SIGNUP` | — | bool | `false` | Blocks first-run bootstrap explicitly. Bootstrap already only ever succeeds while the instance has zero users, so this is a belt-and-braces switch, not the primary guard. |
| — | — | `--secure-cookies` | bool | `false` | Marks session and CSRF cookies `Secure`. Off by default only so `http://localhost:3100` works during setup — turn it on for any real deployment reachable over HTTPS. |
| — | — | `--version` | — | — | Print the version and exit. |

### Duration format

`session_window` and `session_ttl` parse with Go's `time.ParseDuration`
syntax (`"30m"`, `"24h"`, `"90s"`) in the config file; the `ATHAR_*` env
equivalents parse the same way. A bare number in the JSON file is tolerated
and interpreted as seconds.

### Boolean env values

`ATHAR_TRUST_PROXY_HEADERS`, `ATHAR_SERVE_LANDING`, and
`ATHAR_DISABLE_SIGNUP` parse with Go's `strconv.ParseBool` (`1`, `t`,
`true`, `TRUE`, `0`, `f`, `false`, …). An unparseable value is **ignored**
rather than treated as `false` — so a typo like `TRUST_PROXY_HEADERS=yes`
doesn't silently turn a setting off that an operator believes is on.

## Precedence example

```bash
# athar.config.json sets "port": "3100"
ATHAR_PORT=8080 ./athar --port 9000
# → listens on 9000: the flag wins over the env var, which won over the file.
```
