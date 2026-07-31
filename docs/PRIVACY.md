# Privacy: the threat model

This document is the rigorous version of the [README's privacy section](../README.md#privacy-architecture):
precisely what Athar stores, precisely what the visitor-identity construction
does and doesn't guarantee, and — honestly — what someone who steals a copy
of the database can and cannot recover from it. If a claim below isn't
something the code actually enforces, it says so; the point of this
document is to not oversell.

## What is stored

Per visitor session (`visits` table): a visitor hash (below), browser, OS,
device class, screen size, language, country/region/city, the referring
*host* (not the full referring URL), UTM parameters, first/last-seen
timestamps, and a view count. Per pageview/event (`events`): URL path and
query, an on-site referring *path* (for internal navigation), page title,
and a timestamp. Per heatmap sample (`heat_samples`): a page-relative
x/y percentage or scroll percentage, viewport size, dwell time, and a CSS
selector — never DOM content, never text, never form values, never
keystrokes. Per revenue event: an amount in integer minor units, a
currency, and an order id you supplied.

**Not stored, anywhere, ever, by the tracker:** the raw client IP address; a
device fingerprint beyond the coarse fields above; any cookie or
client-generated identifier; DOM snapshots or keystroke logs; exact
geographic coordinates (only country/region/city name strings, when GeoIP
is configured at all). No visitor page content ever reaches Athar's server —
the tracker records a click's position as a page-relative percentage plus a
short CSS selector, never the page itself.

## Page captures: the one thing an operator, not the tracker, can add

The heatmap dashboard can draw the click density field over a real picture
of the page instead of only a wireframe. That picture is never something
the tracker captures from a visitor's browser — it is a screenshot an
**operator** deliberately takes of their own page and uploads through the
dashboard (`PUT /api/websites/{id}/page-image`), stored one per (website,
URL path, viewport width) in the operator's own database (the `page_images`
table). No tracker code changed to add this, no visitor-facing request is
involved, and the boundary above still holds exactly as stated: the tracker
itself captures no page content, ever.

What changes is what the *operator's own database* can now contain: a
capture is visible to every signed-in user of that website's dashboard, so
whatever is on screen when it's taken — including a real visitor's name, a
basket, an order — becomes visible to all of them too. Athar's guidance,
stated in the dashboard at the moment of upload, is to capture the page as a
logged-out visitor sees it. This is the operator's own choice about their
own database, the same as any other content they might choose to store
there; it is not something Athar's tracker or server does on its own, and
it does not change what any visitor's browser sends.

## The visitor-identity construction

```
salt    = HMAC-SHA256(instance_secret, "YYYY-MM-DD")     # recomputed once per UTC day
visitor = HMAC-SHA256(salt, website_id ‖ 0x00 ‖ ip ‖ 0x00 ‖ user_agent)
```

(`backend/internal/ingest/identity.go`.) `instance_secret` is 32 bytes of
`crypto/rand`, generated once and persisted in the `settings` table. The
null-byte separators exist so that, say, a website id ending where an IP
begins can't be confused with a different website id / IP split that
happens to concatenate to the same bytes.

## What this guarantees, and why

**A visitor hash cannot be linked across days.** `salt` for one UTC day is
an HMAC of the instance secret keyed on that day's date string — it has no
algebraic relationship to the salt for any other day that would let someone
derive one from the other without redoing the HMAC with the secret in hand.
So two hashes for the *same real visitor* on two different days are, from
the stored data alone, indistinguishable from two hashes for two *different*
visitors. This is a property of the data, not a policy: there is no feature,
flag, or query that reconstructs cross-day identity, because the information
needed to do so was never retained. Deleting the `ingest_secret` row is a
deliberate, supported way to sever the link to every prior day's hashes at
once.

**One operator cannot build a cross-site profile from their own database.**
`website_id` is inside the HMAC input, not a separate, strippable field —
the same person visiting two different websites tracked by the same Athar
instance produces two hashes with no computable relationship between them
(short of, again, redoing the HMAC — see below). An operator running
several properties through one instance cannot join `visits` rows across
`website_id` by visitor identity, because the column that would let them do
that doesn't encode a per-visitor value independent of the site.

**The raw IP is not in the trust boundary of anything except the hash and
the GeoIP lookup, once.** It arrives in the HTTP request, is read once
(`geoip.ClientIP`), used to compute the hash and resolve a location, and is
then out of scope for the rest of the process — never written to a
database column, a log line, or an error message (`backend/internal/ingest/collector.go`'s
package doc states this as an invariant, and `CONTRIBUTING.md` lists it as
one of the frozen ones). This means a database backup, a database dump sent
to support, or a read-only reporting replica never carries the raw IP,
regardless of how it's handled downstream.

## What someone who steals the database can and cannot recover

This is the part worth being exact about, because "hashed" is not a synonym
for "safe against every attacker," and pretending otherwise would be the
kind of overclaim this document exists to avoid.

**Without the instance secret:** nothing. `visitor_hash` is the output of a
keyed hash (HMAC-SHA256) under a secret the attacker doesn't have. There is
no feasible way to invert it or to test candidate IP/UA pairs against it,
because computing the candidate hash requires the same secret used to
produce the stored one.

**With the instance secret** — and this matters, because the secret lives
in the *same database*, in the `settings` table, so a full database theft
(not merely a leaked backup of `visits` alone) hands an attacker both: the
hash stops being a one-way wall and becomes a **verification oracle**. For
a given day and website — both of which are visible in plaintext right next
to the hash — an attacker who already suspects a specific IP address and
user agent (say, they're trying to confirm whether a particular person
visited a particular page) can recompute `HMAC(salt, website_id ‖ ip ‖ ua)`
for that guess and compare it to a stored hash in seconds. HMAC-SHA256 is a
fast function with no work-factor tuning (unlike, say, Athar's own argon2id
password hashing) — it was never intended to resist brute-force the way a
password hash is, because its job is to be a stable per-day *identifier*,
not a credential.

What this does **not** turn into is bulk reversal: there is no way to take
a table of hashes and, without a list of candidate IPs to test, recover
"whose visit was this" for the general case — the IPv4 address space alone
is ~4.3 billion values, and testing every one against every hash for every
day in the table is a very different (and very much larger) computation
than confirming one suspected IP. In short: **a full database theft
downgrades the identity construction from "not reversible" to "not
reversible in bulk, but checkable against a specific suspect" — treat a
stolen database as capable of confirming a targeted guess, not as capable
of naming every visitor.** This is exactly why the raw IP is never stored
directly: even in the worst case (secret and hashes both stolen), the
attacker still needs an independent guess at the IP from somewhere else —
Athar's database is never that source.

## What's inherent to any analytics tool, not specific to Athar

The stored fields per visit — browser, OS, device, screen resolution,
language, coarse geography, referrer — are themselves a form of fingerprint.
On a low-traffic site, "the one visitor from a small country on an unusual
screen resolution who came from this specific referrer" can be a
practically identifying combination even with no hash involved at all, the
same way it would be for server access logs or any other analytics tool
that records a comparable feature set. Athar doesn't attempt k-anonymity
guarantees over this data — the mitigation is that this is *all* the data
model exposes about a visit; there is no richer profile sitting underneath
it that a different report could surface.

Similarly, this document describes what the *stored data* can and can't
reveal. An operator who cross-references Athar's dashboard against an
entirely separate data source they control (web server access logs with raw
IPs, a support ticket, a payment processor's records) can obviously combine
information Athar itself never joins — that's true of every analytics tool
and isn't a property Athar's data model could prevent even in principle.

## See also

- [SECURITY.md](../SECURITY.md) — anything that contradicts a guarantee in
  this document (a way to reverse a hash without the secret, a way to link
  hashes across days, a way to build a cross-site profile from stored data
  alone) is treated as a **security bug**, not a feature request.
- [CONTRIBUTING.md](../CONTRIBUTING.md#scope-what-we-say-yes-and-no-to) —
  the frozen invariants (no raw IP persisted, no cookies from the tracker,
  nothing that phones home) that keep this threat model accurate as the
  code evolves.
