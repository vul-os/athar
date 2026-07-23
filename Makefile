.PHONY: check build build-backend build-frontend test lint tracker notices dev run

# One verification gate — run before every commit and in CI.
check:
	@bash scripts/check.sh

# Backend
build-backend:
	go build ./backend/...

test:
	go test ./backend/...

# Frontend
lint:
	npm run lint

build-frontend:
	npm run build

# Rebuild backend/internal/tracker/athar.min.js from athar.js. The minified
# file is committed (not gitignored) so a Go toolchain alone can build the
# binary; re-run this after editing athar.js.
tracker:
	node scripts/build-tracker.mjs

# Regenerate THIRD-PARTY-NOTICES.txt from the real dependency graph (Go
# modules + npm tree). Re-run after changing go.mod or package.json.
notices:
	./scripts/gen-notices.sh

# Full single-binary build (tracker rebuilt, frontend embedded).
build:
	npm run build:all

# Dev loop: Vite dev server (frontend) — run `make run` in another terminal
# for the Go backend it proxies to.
dev:
	npm run dev

run:
	go run ./backend/cmd/athar
