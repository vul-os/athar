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

The dashboard fetches raw samples for one page via `GET /api/websites/{id}/heatmap?path=…&kind=click|scroll|attn&from=…&to=…` — see [API](./api.md#get-apiwebsitesidheatmap). The response contains coordinates, viewport size, scroll/dwell numbers and selectors only; there is no page content in it, because the tracker never captured any.

## Page captures

For the click view, the dashboard can draw the density field over one of two backdrops:

- **A real capture of the page**, when an editor or owner has uploaded one for the selected page and viewport width. It's an ordinary screenshot the operator takes themselves — nothing the tracker does — and is uploaded through the dashboard as a PNG or JPEG (`PUT /api/websites/{id}/page-image?path=…&viewport=…`; see [API](./api.md#page-captures)). Alignment works because both sides are proportions of the same document: the tracker records a click's `x`/`y` as a percentage of the full document, and a full-page capture at viewport width *W* is exactly one document wide and one document tall, so a sample at (x%, y%) of the image is the pixel that was actually pressed, at any display scale. There's one capture per (website, path, viewport width) — uploading again replaces it, so a redesign doesn't leave a stale picture lying around, and it's served only to signed-in users of that website, with its own restrictive `Content-Security-Policy`.
- **A wireframe schematic**, reconstructed from the recorded data itself, whenever no capture matches: for every selector that was actually clicked, the bounding box of the (x, y) positions recorded for it becomes a labelled rectangle, in the same coordinate space the density field is plotted in. Nothing is drawn for anything that wasn't recorded, and there is no assumed or fetched page layout underneath it. It's badged **Schematic** and captioned "not a picture of the page" so it's never mistaken for the real thing, and it's what you get by default — before any capture is uploaded, after one is deleted, for a page nobody has captured, or whenever "All viewports" is selected (a 390px layout and a 1440px layout are different documents; averaging their clicks onto one picture would misrepresent both).

Uploading, replacing or removing a capture requires editor or owner access to the website, the same as any other write, with the usual CSRF requirement. Because the capture lives in the operator's own database and is shown to every signed-in viewer of that dashboard, whatever is visible in it becomes visible to all of them — see [Privacy](./privacy.md#page-captures-an-operators-own-choice-not-the-trackers) for the guidance the dashboard states at upload time. See [Roadmap](./roadmap.md) for what's still unbuilt around this.
