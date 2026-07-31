# Getting Started

## Requirements

- To build from source: Go 1.25+. Node.js 22+ is only needed if you also
  want to rebuild the tracker from source or embed the marketing mini-site
  (see below) — the dashboard itself has no build step.
- To just run a prebuilt binary from [GitHub Releases](https://github.com/vul-os/athar/releases):
  nothing — it's static.

## 1. Get a binary

**Build from source:**

```bash
git clone https://github.com/vul-os/athar.git
cd athar
go build -o athar ./backend/cmd/athar
```

This alone produces `./athar` — a self-contained binary with the dashboard
(hand-written HTML/CSS/JS) and the tracker both embedded via `go:embed`, so
a Go toolchain is all you need: no Node, no npm install.

For a release build that also rebuilds the tracker from source and embeds
the marketing mini-site, use `npm run build` instead (requires Node.js
22+). It runs two steps in order (`scripts/build-tracker.mjs`,
`scripts/build-binary.mjs`); see
[ARCHITECTURE.md](ARCHITECTURE.md#the-embed--build-tag-pattern) for what
each does.

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

## 6. Optional: add a page capture to a heatmap

Once heatmap samples exist for a page (step 5, `data-heatmap="true"`), the
dashboard's heatmap view can draw the click density field over a real
picture of that page instead of only a wireframe schematic. This is a
manual, per-page step — nothing about the tracker changes, and Athar's
server never fetches the page itself:

1. Open the heatmap view for the page you want, pick the recorded viewport
   width you're capturing (the picker showing `~1440px wide` etc.).
2. Take a **full-page** screenshot of that page at that same viewport width
   — most browsers: developer tools → device toolbar → set the width →
   "Capture full size screenshot". It has to be the whole page, not just
   what's visible above the fold, since click positions are stored as
   percentages of the whole document.
3. In the "Page capture" panel next to the heatmap, choose the file and
   upload it (requires editor or owner access to the website).

**Capture the page as a logged-out visitor would see it.** The image is
stored in this Athar instance's own database and shown to every signed-in
user of this website's dashboard, so anything on screen when it's
captured — a real customer's name, a basket, an order — becomes visible to
all of them too. Without a capture, the heatmap simply shows the wireframe
schematic, which is honest and requires no action; capturing is optional.
See [PRIVACY.md](PRIVACY.md#page-captures-the-one-thing-an-operator-not-the-tracker-can-add)
for the full reasoning.

## 7. Optional: GeoIP

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
