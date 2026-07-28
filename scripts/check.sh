#!/usr/bin/env bash
# Single verification gate for Athar. Run this before every commit; CI runs
# the same steps (see .github/workflows/ci.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

step "go: gofmt"
# gofmt -l prints the files it would change and exits 0 either way, so the exit
# status is useless as a gate — the output is the signal. Empty means formatted.
unformatted="$(gofmt -l backend/)"
if [ -n "$unformatted" ]; then
  printf 'not gofmt-formatted:\n%s\n\nrun: gofmt -w backend/\n' "$unformatted"
  fail=1
else
  echo "backend/ is gofmt-clean"
fi

step "go: build"
go build ./backend/... || fail=1

step "go: vet"
go vet ./backend/... || fail=1

step "go: test"
go test ./backend/... || fail=1

step "tracker: up to date"
node scripts/build-tracker.mjs --check || fail=1

step "frontend: lint"
npm run lint || fail=1

# vitest exits 1 when it matches no test files, so this step cannot pass by
# running nothing. Each test module additionally asserts that every export of
# the module it covers is named in its own exercised-set, so a new export
# widens the gate instead of slipping past it.
step "frontend: test"
npm test || fail=1

step "frontend: build"
npm run build || fail=1

if [ "$fail" -ne 0 ]; then
  printf '\n\033[31mCHECK FAILED\033[0m\n'
  exit 1
fi
printf '\n\033[32mCHECK PASSED\033[0m\n'
