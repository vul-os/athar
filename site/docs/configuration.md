# Configuration

Athar is meant to run with no configuration at all — `./athar` on its own works, storing to `./athar.db` and listening on loopback. Every setting below has a working default and the config file itself is optional.

## Precedence

Lowest to highest: **built-in defaults → `athar.config.json` → `ATHAR_*` environment variables → command-line flags.**

Environment wins over the file so a container can override a baked-in config without editing it. Flags win over everything so an operator debugging a live box always has the last word.

## Where the config file is found

`Load()` searches, in order, and stops at the first match:

1. `athar.config.json` in the current working directory, then each parent directory up to the filesystem root
2. `~/.config/athar/athar.config.json`
3. `athar.config.json` next to the running binary

A missing file is not an error — an analytics collector that refuses to boot without a config file would work against the "just run it on your box" path Athar exists for.

Unknown keys in the file are rejected rather than silently ignored, so a typo in a security-relevant key like `trust_proxy_headers` fails loudly at startup instead of quietly not taking effect.

## Keys

| Key | Env var | Default | Notes |
|---|---|---|---|
| `host` | `ATHAR_HOST` | `127.0.0.1` | see [Host & port](#host--port) |
| `port` | `ATHAR_PORT` | `3100` | must be numeric |
| `database` | `ATHAR_DATABASE` | `athar.db` | bare path = SQLite; `postgres://…` = Postgres, same binary |
| `geoip_path` | `ATHAR_GEOIP_PATH` | *(empty)* | path to a MaxMind-format `.mmdb`; empty disables geo resolution. If set, Athar checks the file is readable at startup and fails fast if it isn't — better than silently collecting geo-less data for a month |
| `tracker_path` | `ATHAR_TRACKER_PATH` | `/athar.js` | where the tracker script is served. Renaming it is the standard way to survive a blocklist that matches on filename |
| `collect_path` | `ATHAR_COLLECT_PATH` | `/api/send` | where beacons are POSTed. Must differ from `tracker_path` — both are mounted on the router |
| `session_window` | `ATHAR_SESSION_WINDOW` | `30m` | how long a visitor can be idle before their next pageview starts a new *visitor* session (industry-standard 30 minutes) |
| `session_ttl` | `ATHAR_SESSION_TTL` | `24h` | idle lifetime of a *dashboard login* session — not the same thing as `session_window` |
| `retention_days` | `ATHAR_RETENTION_DAYS` | `0` | delete visitor sessions (and everything that cascades from them) older than N days. `0` keeps data forever |
| `trust_proxy_headers` | `ATHAR_TRUST_PROXY_HEADERS` | `false` | see [trust_proxy_headers](#trust_proxy_headers) |
| `frame_ancestors` | `ATHAR_FRAME_ANCESTORS` | *(empty)* | space-separated origin list allowed to embed the dashboard in an iframe. Empty blocks all cross-origin framing |
| `serve_landing` | `ATHAR_SERVE_LANDING` | `false` | hosts this marketing site at `/` and `/site/*`. Cloud-only — a self-hosted instance should serve the dashboard at `/`, not a landing page |
| `disable_signup` | `ATHAR_DISABLE_SIGNUP` | `false` | blocks the first-run admin bootstrap. Has no effect once an admin already exists — bootstrap is only ever reachable on an empty instance regardless of this flag |

Durations (`session_window`, `session_ttl`) are Go duration strings in the JSON file — `"30m"`, `"24h"` — not raw nanosecond integers, so the file stays readable. The env-var forms use the same syntax.

### `host` & `port`

`host` defaults to `127.0.0.1` — loopback only — even though Athar has to receive beacons from the internet to be useful. That default is deliberate: the intended path to public reachability is a tunnel (cloudflared, ngrok, Ephor) or a reverse proxy, both of which reach loopback fine. Binding `0.0.0.0` is something an operator should say explicitly, not something that happens by accident of a default.

### `trust_proxy_headers`

Off by default, and that default is a security property, not just caution. With it on, Athar reads the client IP from `X-Forwarded-For` / `X-Real-IP` instead of the raw socket peer — which is correct and necessary behind a real reverse proxy, but if it's on and *anything* can still reach Athar directly (a misconfigured proxy, a firewall hole, the port itself), any client can set that header and forge their apparent country in every report. Turn it on only once you've confirmed the only path to Athar is through a proxy that overwrites those headers rather than passing through whatever the client sent.

## Example `athar.config.json`

```json
{
  "host": "127.0.0.1",
  "port": "3100",
  "database": "postgres://athar:secret@localhost:5432/athar?sslmode=require",
  "geoip_path": "/etc/athar/GeoLite2-City.mmdb",
  "retention_days": 400,
  "trust_proxy_headers": true
}
```

## Flags

`-port -host -db -geoip -secure-cookies -version` — see [Install](./install.md#command-line-flags) for what each does. Flags override the file and environment for the four values they cover; `-secure-cookies` and `-version` have no config-file equivalent.
