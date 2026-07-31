# Contributing to Athar

## Code of Conduct

We follow the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## Dev Environment Setup

Requirements: Go 1.25+. Node 22+ is only needed for the tracker build and
for `scripts/screenshots.mjs` (Playwright) — the dashboard has no build step
and no npm dependency.

```bash
git clone https://github.com/vul-os/athar.git
cd athar
```

**Backend + dashboard** (Go, hot-reload via `go run`):

```bash
go run ./backend/cmd/athar
# listens on http://127.0.0.1:3100, storing to ./athar.db, dashboard at /
```

There is no separate frontend dev server. The dashboard is hand-written
HTML/CSS and plain ES modules under `backend/internal/webui/static/`
(`index.html`, `ui.css`, `app.js` and friends), embedded via `go:embed`. Edit
those files directly, then Ctrl-C and re-run the command above — `go:embed`
reads the files fresh on the next compile, so a restart is the entire
"reload" step.

**Full single-binary build** (tracker rebuilt, marketing site embedded):

```bash
npm run build
# outputs ./athar
```

A plain `go build -o athar ./backend/cmd/athar` also works with no Node
involved at all — it just won't rebuild the tracker or embed the marketing
site (see [ARCHITECTURE.md](docs/ARCHITECTURE.md#the-embed--build-tag-pattern)).

**Before opening a PR**, run the same gate CI runs:

```bash
make check
```

which runs, in order: `gofmt -l backend/` (any output fails the gate),
`go build ./backend/...`, `go vet ./backend/...`, `go test ./backend/...`, a
check that the committed `backend/internal/tracker/athar.min.js` matches
`athar.js` (`node scripts/build-tracker.mjs --check`), and the dashboard's
JS tests (`node --test scripts/jstest/*.test.mjs`).

Both scoped gates are worth knowing the shape of. `gofmt -l` exits 0 whether
or not it found unformatted files, so the gate tests its *output*, not its
status. Node's built-in test runner exits 0 on an empty glob rather than
failing like vitest used to, so `make check` and CI expand
`scripts/jstest/*.test.mjs` explicitly and fail if it matches nothing — the
JS test step cannot pass by silently running no tests. Each test module also
asserts that every export of the module it covers is named in its own
exercised-set, so adding an export without a test fails the suite instead of
quietly widening the untested surface.

Note the gates are scoped to `./backend/...`, not `./...`: the Go tool walks
`node_modules/`, which contains a vendored Go package (`flatted`) that is not
Athar's code.

## Branch and PR Conventions

- Branch off `main`. Name: `feat/description`, `fix/description`,
  `chore/description`.
- One logical change per PR. Keep diffs reviewable.
- PRs require at least one approving review.
- Squash-merge preferred.

## Commit Message Style

Conventional Commits welcome, not required:

```
feat(ingest): drop bot traffic before it reaches the visit table
fix(store): correct off-by-one in TimeBucket for the postgres dialect
chore: bump modernc.org/sqlite to 1.51
```

## Testing Expectations

Before opening a PR:

```bash
gofmt -l backend/          # must print nothing
go build ./backend/...
go vet ./backend/...
go test ./backend/...
node scripts/build-tracker.mjs --check
node --test scripts/jstest/*.test.mjs
```

Anything touching `backend/internal/ingest` (the identity hash, the
collector) or `backend/internal/auth` is privacy- or security-sensitive by
definition — see [SECURITY.md](SECURITY.md) for what "sensitive" means here.
Add a test that would fail without your fix. Anything touching
`backend/internal/store` should pass against both dialects where the change
is dialect-observable — `sql.go` and `dialect.go` are written so this is
usually automatic, but a new query is worth eyeballing against both.

## Scope: What We Say Yes and No To

### Yes
- Bug fixes and security improvements.
- Reporting/query correctness (bounce rate, session windowing, time-bucket
  edge cases) — this is an analytics tool; wrong numbers are bugs, not
  cosmetics.
- New Store-seam capability that stays inside the two portability rules (all
  timestamps as epoch milliseconds, all primary keys as application-generated
  random hex) — see `backend/internal/store/store.go`.
- Heatmap, funnel, and other reporting UI that reads data already being
  collected.
- Tests and documentation.

### No — frozen invariants
- **No cgo** in any Go code. Pure Go only — it's why the SQLite driver is
  `modernc.org/sqlite` and not `mattn/go-sqlite3`, and it's what keeps
  cross-compilation (`CGO_ENABLED=0`) trivial for every release target.
- **No frontend build step for the dashboard.** It is hand-written HTML,
  CSS and plain ES modules (`backend/internal/webui/static/`) embedded via
  `go:embed` — no React, no JSX/TSX, no bundler, no npm dependency. A PR
  that reintroduces a framework or build pipeline for the dashboard is the
  wrong PR unless discussed first.
- **Nothing that phones home.** No telemetry, no CDN-loaded asset, no
  external font, no remote GeoIP lookup — ever. "The data never leaves your
  server" has to stay true of Athar's own runtime behaviour, not just of the
  data it collects. A dependency that fetches anything at runtime from a
  third party is a bug, not a feature.
- **No raw IP persisted**, anywhere — not in a database column, not in a log
  line, not in an error message. It is used in-process for the visitor hash
  and the GeoIP lookup and then it is gone; a PR that gives it a third use is
  the wrong PR.
- **No cookies set by the tracker.** `backend/internal/tracker/athar.js` sets
  no cookie, reads no cookie, and writes nothing to `localStorage` or
  `sessionStorage`. Visitor identity is the daily salted hash, full stop.
- **No new runtime dependency without prior issue discussion** — Go module or
  npm package. Every dependency is something `make notices` has to attribute
  and something the security scope in SECURITY.md has to reason about.

## Finding a Good First Issue

Look for `good first issue` or `help wanted` labels. Reporting UI, heatmap
overlay rendering, and documentation are low-friction entry points; see
[ROADMAP.md](ROADMAP.md) for what's genuinely unstarted.

## Licensing

Athar is dual-licensed **MIT OR Apache-2.0**. Contributions are accepted
under both licences; by opening a PR you agree your contribution is licensed
the same way. No CLA required.
