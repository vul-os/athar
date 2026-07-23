# Tracker script

`athar.js` is the entire client-side integration: one script tag, no config file, no build step on your side. It is served by the binary itself at the configured `tracker_path` (default `/athar.js`).

```html
<script defer src="https://analytics.example.com/athar.js"
        data-website-id="YOUR_WEBSITE_ID"></script>
```

It is small on purpose: **3.3 KB raw, 1.6 KB gzipped** (the minified build served to real visitors). Append `?source=1` to the script URL to fetch the commented, readable original instead — useful for checking exactly what a site is running, since the file is the same one this repository publishes.

## `data-*` attributes

| Attribute | Default | Effect |
|---|---|---|
| `data-website-id` | *(required)* | the website id from your Athar dashboard |
| `data-host-url` | script's own origin | send beacons somewhere other than where the script is hosted |
| `data-domains` | *(none)* | comma-separated hostname allowlist; the script no-ops on any other host |
| `data-auto-track` | `true` | set to `"false"` to disable automatic pageview tracking (including SPA route changes) |
| `data-heatmap` | `false` | set to `"true"` to collect click / scroll / attention samples — see [Heatmaps](./heatmaps.md) |
| `data-do-not-track` | `false` | set to `"true"` to honour the browser's Do Not Track signal. Off by default: a self-hosted first-party install is a different thing from third-party tracking, and it's the site owner's call, not the script's |
| `data-exclude-search` | `false` | set to `"true"` to drop query strings from the tracked URL before sending |

If `data-website-id` is missing, the script does nothing at all.

## Automatic pageviews

With `data-auto-track` on (the default), the script sends a pageview on initial load and again on every client-side route change — it patches `history.pushState` / `replaceState` and listens for `popstate`, so single-page apps are tracked without extra code. A `pushState` to the same URL (a re-render, not a navigation) does not count as a second pageview.

## JS API

Once loaded, the script exposes `window.athar`:

```js
athar.track()                       // pageview for the current URL
athar.track('signup_clicked')       // named custom event
athar.track('signup_clicked', {plan: 'pro'})  // …with properties
athar.revenue(49.99, 'USD', 'order_123', 'purchase')  // revenue event
```

- `track(name, data)` — `data` is a flat object of properties; values are stored as strings or numbers (nested objects/arrays are flattened to JSON text rather than dropped). Up to 50 properties are kept per event.
- `revenue(amount, currency, orderId, name)` — `amount` is major units (e.g. `49.99`), converted to integer minor units server-side so money is never carried as a float. `currency` is free text, upper-cased on the way in (use ISO 4217, e.g. `USD`). `name` defaults to `"purchase"` if omitted. See [Ecommerce](./ecommerce.md).

## How beacons are sent

The script uses `navigator.sendBeacon` when available, so the final heatmap flush on page unload actually survives — it falls back to a `fetch` with `keepalive: true` when `sendBeacon` isn't present. Beacons are `POST`ed as a `{type, payload}` JSON envelope to `<host-url>/api/send` (or your configured `collect_path`). A failed send is swallowed silently: analytics must never break the page it's embedded in.

The endpoint is credential-free by design — no cookie is set, none is read, `Access-Control-Allow-Origin: *` is safe here specifically because there is nothing to steal with credentials.
