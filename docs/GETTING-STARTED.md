# Getting Started

## Requirements

- To build from source: Go 1.25+ and Node.js 22+.
- To just run a prebuilt binary from [GitHub Releases](https://github.com/vul-os/athar/releases):
  nothing — it's static.

## 1. Get a binary

**Build from source:**

```bash
git clone https://github.com/vul-os/athar.git
cd athar
npm install
npm run build:all   # runs the tracker build, the Vite build, then the Go build
```

This produces `./athar` — a self-contained binary with the dashboard and (if
present) the marketing mini-site embedded. `npm run build:all` runs three
steps in order (`scripts/build-tracker.mjs`, `vite build`,
`scripts/build-binary.mjs`); see [ARCHITECTURE.md](ARCHITECTURE.md#the-embed--build-tag-pattern)
for what each does.

**Or download a release** for your platform (linux/darwin, amd64/arm64;
windows/amd64) from the [Releases page](https://github.com/vul-os/athar/releases),
and verify it against the published `checksums.txt`.

## 2. Run it

```bash
./athar
```

With no configuration at all, Athar:

- listens on `http://127.0.0.1:3100`
- stores to `./athar.db` (SQLite) in the current directory
- serves the dashboard at `/`

Open [http://localhost:3100](http://localhost:3100).

## 3. First-run setup

The dashboard shows a setup screen instead of a login form until the
instance has its first account (`GET /api/auth/status` reports
`needs_setup: true` while zero users exist). Choose a username and a
password of at least 12 characters — length is what's enforced, not
character-class rules — and submit. This calls `POST /api/auth/bootstrap`,
which creates the first account as an **admin** and is only reachable while
the instance is empty; it cannot be used to add a second account later, and
you can close it off explicitly with `disable_signup` once you're done.

## 4. Add a website

From the dashboard, create a website (name + domain). This gives you a
website id — the value that goes into the tracker's `data-website-id`.

## 5. Install the tracker

Add this to the `<head>` of the site you want to track:

```html
<script defer src="https://your-athar-host/athar.js"
        data-website-id="YOUR_WEBSITE_ID"></script>
```

- Replace `your-athar-host` with wherever this Athar instance is actually
  reachable — during local development that's `http://localhost:3100`; for
  a real site it needs to be a publicly reachable address (see
  [SELF-HOSTING.md](SELF-HOSTING.md), since Athar binds loopback by
  default).
- Add `data-heatmap="true"` to also collect click/scroll/attention samples.
- See the [README's tracker section](../README.md#how-the-tracker-works)
  for the full attribute list and the `window.athar` JS API.

Pageviews should start appearing in the dashboard within a few seconds of
the first tracked page load — the reporting queries run against live data
with no batching delay.

## 6. Optional: GeoIP

Without a GeoIP database configured, country/region/city fields are simply
empty — everything else works normally. To enable them, get a
MaxMind-format `.mmdb` file (DB-IP Lite or GeoLite2 — Athar does not bundle
one; see [ARCHITECTURE.md](ARCHITECTURE.md) for why) and point Athar at it:

```bash
./athar --geoip /path/to/dbip-city-lite.mmdb
```

or set `geoip_path` in `athar.config.json` / `ATHAR_GEOIP_PATH`. Athar
refuses to start if the configured path isn't readable, rather than quietly
collecting geo-less data until someone notices.

## Next steps

- [docs/CONFIGURATION.md](CONFIGURATION.md) — every config key
- [docs/SELF-HOSTING.md](SELF-HOSTING.md) — reaching Athar from outside
  `localhost`
- [docs/PRIVACY.md](PRIVACY.md) — what Athar does and doesn't record, and why
- [docs/DEPLOYMENT-POSTGRES.md](DEPLOYMENT-POSTGRES.md) — running against
  Postgres instead of SQLite
