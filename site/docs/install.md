# Install

Athar has one supported install path today: build the static binary from source. There is no published Docker image or release binary yet — see [Roadmap](./roadmap.md).

## Requirements

- Go 1.25+
- Node 22+ — optional. It's only needed to rebuild the tracker script from source and to produce a release binary that also embeds the marketing mini-site. The dashboard itself has no build step (it's hand-written HTML/CSS/JS embedded via `go:embed`), and the running binary needs neither Go toolchain nor Node.

## Build

The simplest build, no Node involved:

```bash
git clone https://github.com/vul-os/athar.git
cd athar
go build -o athar ./backend/cmd/athar
```

This alone produces a self-contained binary with the dashboard and the (already-committed) tracker script both embedded. For a release build that also rebuilds the tracker from source and embeds the marketing site, use `npm run build` instead:

```bash
git clone https://github.com/vul-os/athar.git
cd athar
npm install
npm run build
```

`npm run build` runs two steps in order:

1. `build:tracker` — compiles and minifies `backend/internal/tracker/athar.js` into `athar.min.js`, which is also committed alongside the source copy so `go build` alone (no Node) can still produce a working binary from a checkout that already has it.
2. `build:binary` — stages `site/` into `backend/cmd/athar/site`, compiles with `go build -tags embed_site`, then removes the staged copy — so the resulting binary also serves this marketing site under the `embed_site` build tag. See [Architecture](./architecture.md) for what that build tag does; the dashboard itself is embedded unconditionally either way.

The result is a single executable. Copy it wherever you like; it needs no accompanying files except an optional `athar.config.json` and, if you want geography, a `.mmdb` file.

## Run

```bash
./athar
```

With no arguments this binds `127.0.0.1:3100` and stores to `./athar.db` in the current directory. See [Configuration](./configuration.md) to change any of that, and [Self-hosting](./self-hosting.md) for running it as a long-lived service behind a proxy.

Check what you built:

```bash
./athar -version
```

## Command-line flags

| Flag | Effect |
|---|---|
| `-port` | port to listen on (overrides config) |
| `-host` | interface to bind (overrides config) |
| `-db` | database DSN — a path for SQLite, or `postgres://…` (overrides config) |
| `-geoip` | path to a MaxMind `.mmdb` file (overrides config) |
| `-secure-cookies` | mark session cookies `Secure` — set this once Athar is reached over HTTPS |
| `-version` | print the version and exit |

Flags always win over `athar.config.json` and `ATHAR_*` environment variables — see [Configuration](./configuration.md#precedence) for the full precedence order.

## Postgres instead of SQLite

The same binary runs on Postgres; nothing is rebuilt or reconfigured beyond the DSN:

```bash
./athar -db "postgres://user:pass@host:5432/athar?sslmode=require"
```

or `ATHAR_DATABASE=postgres://…`, or `"database"` in `athar.config.json`. A bare path (or an empty value) means SQLite; anything starting `postgres://` or `postgresql://` means Postgres.
