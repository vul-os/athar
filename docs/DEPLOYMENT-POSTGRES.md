# Deploying against Postgres

Athar's default is SQLite: zero setup, one file, correct for the "run it on
a box you own" case the project is built around. For a hosted or managed
deployment, the same binary runs against Postgres instead — no separate
build, no separate image, no feature difference. This is what the
[Store seam](ARCHITECTURE.md#the-store-seam) is for.

## Switching engines

Set `database` to a `postgres://` (or `postgresql://`) DSN — in the config
file, the `ATHAR_DATABASE` environment variable, or the `--db` flag:

```bash
./athar --db "postgres://athar:password@db.internal:5432/athar?sslmode=require"
```

```json
{ "database": "postgres://athar:password@db.internal:5432/athar?sslmode=require" }
```

`backend/internal/store.Open` recognises the engine from the DSN prefix —
`postgres://` or `postgresql://` selects Postgres (via `pgx`); anything else
(a bare path, or an explicit `sqlite://path`) selects SQLite. There is no
separate flag for "which engine" — the DSN *is* the choice.

## What's identical either way

- **The schema.** One migration set (`backend/internal/store/migrations.go`),
  written in the SQL subset both engines accept literally. There is no
  Postgres-specific migration to also apply.
- **Every query.** `backend/internal/store/sql.go` has one implementation of
  every `Store` method; a `Dialect` only rewrites placeholder syntax
  (`?` → `$1, $2, …`) and the time-bucket expression, both mechanically, not
  semantically.
- **The API, the dashboard, the tracker, auth, retention.** None of it is
  aware which engine is behind the `Store` interface.

## What's engine-specific

- **Migrations run automatically on boot either way** (`Store.Migrate`,
  called from `main.go` before the HTTP server starts) — there's no separate
  migration step to remember for Postgres.
- **Connection pooling** is tuned per engine internally (SQLite: a small
  pool appropriate to a single file with WAL mode; Postgres: a pool sized
  for a real connection-pooled server) — nothing you need to configure.
- **You own provisioning the database itself.** Athar does not create a
  Postgres database or role for you — point it at an empty, already-created
  database and it migrates the schema into that on first boot.

## Operational notes

- Use `sslmode=require` (or stricter) in the DSN for any Postgres instance
  reachable over a network you don't fully control — this is a standard
  `pgx`/`lib/pq`-style DSN parameter, not an Athar-specific one.
- A managed Postgres (RDS, Cloud SQL, Neon, Supabase, etc.) works exactly as
  well as a self-run one; Athar only needs a reachable `postgres://` DSN and
  a role with permission to create tables in the target database (for the
  first-boot migration) and to read/write them afterward.
- Retention (`retention_days`) and session/expiry sweeps run the same
  hourly background loop regardless of engine.

## See also

- [docs/ARCHITECTURE.md](ARCHITECTURE.md#the-store-seam) — the Store seam
  and the two portability rules (epoch-millisecond timestamps,
  application-generated primary keys) that make one schema work on both
  engines.
- [docs/CONFIGURATION.md](CONFIGURATION.md) — the full `database` config
  reference.
- [docs/SELF-HOSTING.md](SELF-HOSTING.md) — reaching Athar from outside
  `localhost`, which applies identically regardless of which database is
  behind it.
