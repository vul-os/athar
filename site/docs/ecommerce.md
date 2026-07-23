# Ecommerce

Athar tracks revenue as a property of an event, not as a separate system — a purchase is a custom event with a `revenue` payload attached.

## Sending a revenue event

From the tracker's JS API:

```js
athar.revenue(49.99, 'USD', 'order_123', 'purchase')
```

Arguments: `amount` (major units, e.g. `49.99` — never pre-multiplied), `currency` (free text, upper-cased on arrival; use an ISO 4217 code like `USD` or `EUR`), `orderId` (your own order identifier, stored as-is), and `name` (the event name recorded alongside the revenue row — defaults to `"purchase"`).

## Storage

Amounts are converted to integer minor units (cents) at ingest and stored that way — money is never carried as a floating-point number past the tracker. Conversion rounds half away from zero. This also means the API reports `amount_minor`, not a divided float, so a client formats the amount rather than assuming two decimal places apply to every currency (dividing by 100 is wrong for JPY, and wrong the other way for currencies like KWD that use three decimal places).

Each revenue row is attributed to the visit and the event that produced it, so revenue always ties back to a session — which page it happened on, what referred that visit, which UTM campaign, etc. — via the same reporting the rest of Athar uses.

## Reading it back

`GET /api/websites/{id}/revenue?from=…&to=…` returns totals grouped by currency:

```json
{ "totals": [ { "currency": "USD", "amount_minor": 483200 } ] }
```

See [API](./api.md#get-apiwebsitesidrevenue) for the full endpoint reference, and [Tracker script](./tracker.md#js-api) for the rest of the JS API.

## What this is not (yet)

There's no product-level breakdown, no cart/checkout funnel, and no per-SKU reporting — revenue today is a total per currency over a time range, attributed to visits and events like everything else. See [Roadmap](./roadmap.md).
