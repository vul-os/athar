.PHONY: check build build-backend test dashboard-test fmt tracker notices dev run screenshots

# One verification gate — run before every commit and in CI.
check:
	@bash scripts/check.sh

# Backend. `go build ./...` alone already produces a binary with a fully
# working dashboard — it is embedded via go:embed (backend/internal/webui),
# not a build artifact of a separate frontend toolchain.
build-backend:
	go build ./backend/...

test:
	go test ./backend/...

fmt:
	gofmt -w backend/

# format.js / countries.js are the only real logic in the hand-written
# dashboard; this is their test coverage. node:test, no npm install beyond
# the `node` binary itself.
dashboard-test:
	node --test scripts/jstest/*.test.mjs

# Rebuild backend/internal/tracker/athar.min.js from athar.js. The minified
# file is committed (not gitignored) so a Go toolchain alone can build the
# binary; re-run this after editing athar.js.
tracker:
	node scripts/build-tracker.mjs

# Regenerate THIRD-PARTY-NOTICES.txt from the real dependency graph (Go
# modules + npm tree). Re-run after changing go.mod or package.json.
notices:
	./scripts/gen-notices.sh

# Full release build: tracker rebuilt, marketing site embedded alongside the
# always-embedded dashboard. See scripts/build-binary.mjs.
build:
	npm run build

# Dev loop: just the Go server. There is no separate frontend dev server any
# more — edit backend/internal/webui/static/*, then re-run this; go:embed
# picks the edit up on the next compile.
dev:
	go run ./backend/cmd/athar

run:
	go run ./backend/cmd/athar

# Regenerate the screenshots used by the README and the marketing site.
screenshots:
	npm run screenshots
