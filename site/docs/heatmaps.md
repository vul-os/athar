# Heatmaps

Turn heatmaps on per site with `data-heatmap="true"` on the script tag:

```html
<script defer src="https://analytics.example.com/athar.js"
        data-website-id="YOUR_WEBSITE_ID"
        data-heatmap="true"></script>
```

## What's captured

Three kinds of sample:

- **click** — position of a click, plus the CSS selector of the clicked element
- **scroll** — the maximum scroll depth reached on the page
- **attn** (attention) — dwell time within each 10%-of-page vertical band, closed out whenever the visitor moves to a new band

Positions are stored as **percentages of the document**, not pixels of the viewport — `x`/`y` are 0–100 relative to full document width/height. That's what lets a heatmap recorded on a phone overlay meaningfully onto one recorded on a desktop: both describe *where on the page*, not *where on this particular screen*. The clicked element's CSS selector rides along with click samples, so a click map stays interpretable after a layout change even though pixel positions would have shifted.

## What's not captured

No DOM snapshot. No page text. No form values. No keystrokes. A heatmap sample is a position, a viewport size, a scroll percentage, a dwell time, and — for clicks — a short CSS selector like `#hero > button.btn-primary`. Nothing else rides along.

## How it's sent

Samples batch client-side and flush:

- every 50 samples
- on `pagehide` (fires reliably on mobile Safari and is back/forward-cache compatible, unlike `unload`)
- on `visibilitychange` when the tab becomes hidden
- on every pageview/route change, so a batch always belongs to one page

Each flush is one `{type: "heat", payload: {..., heat: [...]}}` beacon. The server accepts at most 500 samples per beacon as a backstop against a hand-crafted request; the tracker itself sends far fewer per flush.

## Selector construction

The selector walks up from the clicked element, stopping at the first ancestor with an `id`, otherwise including the element's tag and (at most) one class per level, capped at 5 levels and 250 characters total. It's meant to be short and "stable-ish," not a unique CSS path — good enough to say *the primary CTA button*, not fragile enough to break on every unrelated DOM change.

## Viewing a heatmap

The dashboard fetches raw samples for one page via `GET /api/websites/{id}/heatmap?path=…&kind=click|scroll|attn&from=…&to=…` and renders the overlay — see [API](./api.md#get-apiwebsitesidheatmap). The response contains coordinates, viewport size, scroll/dwell numbers and selectors only; there is no page content in it, because none was ever captured.
