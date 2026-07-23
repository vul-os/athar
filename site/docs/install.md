# Install

Athar has one supported install path today: build the static binary from source. There is no published Docker image or release binary yet — see [Roadmap](./roadmap.md).

## Requirements

- Go 1.25+
- Node 22+ (only needed at build time, to build the tracker script and the dashboard bundle — the running binary needs neither Go toolchain nor Node)

## Build

```
git clone https://github.com/vul-os/athar.git
cd athar
npm install
npm run build:all
```

`build:all` runs three steps in order:

1. `build:tracker` — compiles and minifies `backend/internal/tracker/athar.js` into `athar.min.js`, which is committed alongside the source copy so `go build` alone (no Node) can still produce a working binary from a checkout that already has it.
2. `vite build` — builds the React dashboard.
3. a build script that embeds the dashboard output and produces the `athar` binary.

The result is a single executable. Copy it wherever you like; it needs no accompanying files except an optional `athar.config.json` and, if you want geography, a `.mmdb` file.

## Run

```
./athar
```

With no arguments this binds `127.0.0.1:3100` and stores to `./athar.db` in the current directory. See [Configuration](./configuration.md) to change any of that, and [Self-hosting](./self-hosting.md) for running it as a long-lived service behind a proxy.

Check what you built:

```
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

```
./athar -db "postgres://user:pass@host:5432/athar?sslmode=require"
```

or `ATHAR_DATABASE=postgres://…`, or `"database"` in `athar.config.json`. A bare path (or an empty value) means SQLite; anything starting `postgres://` or `postgresql://` means Postgres.
