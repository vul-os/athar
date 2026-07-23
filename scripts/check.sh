#!/usr/bin/env bash
# Single verification gate for Athar. Run this before every commit; CI runs
# the same steps (see .github/workflows/ci.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

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

step "frontend: build"
npm run build || fail=1

if [ "$fail" -ne 0 ]; then
  printf '\n\033[31mCHECK FAILED\033[0m\n'
  exit 1
fi
printf '\n\033[32mCHECK PASSED\033[0m\n'
