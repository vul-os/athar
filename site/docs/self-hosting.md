# Self-hosting

Self-hosting is the only way Athar runs — there is no hosted version to fall back to. This page covers the parts of running it long-term that [Getting started](./getting-started.md) skips.

## Binding and reaching it publicly

Athar binds `127.0.0.1` by default (see [Configuration](./configuration.md#host--port)). To collect real traffic you need something in front of it that's actually reachable:

- **A tunnel** — cloudflared, ngrok, or Ephor, pointed at `127.0.0.1:3100`. Simplest option if you don't want to manage TLS or open a port.
- **A reverse proxy** — nginx or Caddy terminating TLS on a domain you control and forwarding to loopback. If you go this route, set `trust_proxy_headers: true` (or `ATHAR_TRUST_PROXY_HEADERS=true`) **and** confirm the proxy actually overwrites `X-Forwarded-For`/`X-Real-IP` rather than passing through whatever a client sent — with it on, that header is how Athar decides what country to record, and if anything can still reach Athar directly, that becomes forgeable. See [Configuration](./configuration.md#trust_proxy_headers).

Once you're behind TLS, also pass `-secure-cookies` (or set it up however you run the process) so the dashboard's session cookie is marked `Secure`.

## Running as a service

Athar is a single static binary with no runtime dependencies beyond its database file (or a Postgres DSN) and, optionally, a `.mmdb` file — it fits any process supervisor. A minimal systemd unit:

```ini
[Unit]
Description=Athar analytics
After=network.target

[Service]
ExecStart=/opt/athar/athar -secure-cookies
WorkingDirectory=/opt/athar
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`-secure-cookies` has no config-file or env-var form — pass it as a flag, as above. Keep `athar.config.json` itself in the working directory or `~/.config/athar/` — see [Configuration](./configuration.md#where-the-config-file-is-found).

## Storage

- **SQLite** (default): a single file, `athar.db` unless `database` says otherwise. Back it up like any file — copy it while the process is stopped, or use SQLite's own backup/VACUUM INTO if you need a live snapshot.
- **Postgres**: point `database` at a `postgres://` DSN. Same schema, same binary, standard Postgres backup practice applies (`pg_dump`, replication, whatever your infrastructure already does).

## GeoIP

Country/region/city resolution needs a local `.mmdb` file — DB-IP Lite (free, no account) or GeoLite2 (free, requires a MaxMind account to download) both work. Point `geoip_path` at it. Athar checks the file is readable at startup and refuses to boot if it isn't, rather than silently running with empty location fields for a month before anyone notices. Refresh the file periodically yourself (monthly is typical for these datasets) — Athar never fetches or updates it.

## Retention

Set `retention_days` to bound how long collected data is kept; `0` (default) keeps it forever. Retention runs once an hour in the background and deletes whole visitor sessions (and everything that cascades from them — events, heatmap samples, revenue) rather than trimming individual rows, so bounce-rate and other aggregate numbers stay internally consistent after a purge.

## Multiple sites, one instance

One Athar instance tracks any number of websites. Each has its own website id, its own script tag, and its own per-user access grants (owner/editor/viewer) — see [API](./api.md#websites). There's nothing per-site to configure at the instance level beyond creating the website in the dashboard.

## Upgrading

`Migrate()` runs on every boot and brings the schema up to date automatically — replace the binary and restart; there's no separate migration step to run by hand. Back up your database file (or take a Postgres snapshot) before a version jump, as you would before any schema-touching upgrade.
