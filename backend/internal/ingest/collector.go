// Package ingest receives tracking beacons and turns them into stored analytics.
//
// Everything privacy-relevant about Athar is decided in this package. The rules
// it enforces, in order of how much they matter:
//
//   - No cookie is ever set. Visitor identity is a daily, per-site, salted hash
//     (see Identifier) computed at request time.
//   - The client IP is used for two things — the visitor hash and the GeoIP
//     lookup — and is then discarded. It is never written to the database and
//     never logged.
//   - Geography is resolved here, at ingest, from a local .mmdb file. Only the
//     country/region/city strings are stored; no coordinates, no IP.
//   - Bot traffic is dropped rather than recorded.
//
// If a change to this package would break one of those, it is the change that is
// wrong.
package ingest

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"athar/backend/internal/geoip"
	"athar/backend/internal/store"
)

// maxBodyBytes bounds a single beacon. Generous enough for a full heatmap flush
// (a few hundred samples), small enough that an open collector endpoint cannot
// be used to push megabytes into the database one request at a time.
const maxBodyBytes = 128 << 10 // 128 KiB

// maxHeatSamplesPerBeacon caps one flush. The tracker sends far fewer; this is
// the backstop against a hand-crafted request.
const maxHeatSamplesPerBeacon = 500

// maxEventProperties caps custom-event properties per event.
const maxEventProperties = 50

// Collector handles tracking beacons.
type Collector struct {
	store         store.Store
	geo           *geoip.Resolver
	ident         *Identifier
	sessionWindow time.Duration
	trustProxy    bool

	sites *siteCache
	limit *rateLimiter
}

// Options configures a Collector.
type Options struct {
	Store         store.Store
	GeoIP         *geoip.Resolver
	Identifier    *Identifier
	SessionWindow time.Duration
	TrustProxy    bool
}

// New builds a Collector.
func New(opt Options) *Collector {
	window := opt.SessionWindow
	if window <= 0 {
		window = 30 * time.Minute
	}
	return &Collector{
		store:         opt.Store,
		geo:           opt.GeoIP,
		ident:         opt.Identifier,
		sessionWindow: window,
		trustProxy:    opt.TrustProxy,
		sites:         newSiteCache(5 * time.Minute),
		limit:         newRateLimiter(),
	}
}

// ── Wire format ───────────────────────────────────────────────────────────────

// beacon is the tracker's request body. The {type, payload} envelope matches
// the shape Umami uses, which makes an existing tracker integration easy to
// point at Athar instead.
type beacon struct {
	Type    string  `json:"type"`
	Payload payload `json:"payload"`
}

type payload struct {
	Website  string         `json:"website"`  // website id
	Hostname string         `json:"hostname"` // page host, used to detect off-site referrers
	Screen   string         `json:"screen"`   // "1920x1080"
	Language string         `json:"language"`
	URL      string         `json:"url"`      // path + query, never an absolute URL
	Referrer string         `json:"referrer"` // document.referrer, may be absolute
	Title    string         `json:"title"`
	Name     string         `json:"name"` // custom event name
	Data     map[string]any `json:"data,omitempty"`
	Revenue  *revenueBody   `json:"revenue,omitempty"`
	Heat     []heatBody     `json:"heat,omitempty"`
}

type revenueBody struct {
	Currency string  `json:"currency"`
	Amount   float64 `json:"amount"` // major units, e.g. 49.99
	OrderID  string  `json:"order_id"`
}

type heatBody struct {
	Kind      string  `json:"k"`
	X         float64 `json:"x"`   // 0..100, page-relative
	Y         float64 `json:"y"`   // 0..100, page-relative
	VW        int     `json:"vw"`  // viewport width
	VH        int     `json:"vh"`  // viewport height
	Scroll    float64 `json:"s"`   // 0..100
	DwellMS   int     `json:"d"`   // milliseconds
	Selector  string  `json:"sel"` // CSS selector of the target
	Path      string  `json:"p"`   // path the sample belongs to
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

// Handler serves the collect endpoint. It answers 204 on success and on most
// failures: a tracking script must never surface an error into a visitor's
// console or retry storm against someone else's site, and a beacon that reveals
// whether a website id exists is an enumeration oracle.
func (c *Collector) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// The tracker runs on third-party origins, so the endpoint is
		// cross-origin by nature. It is safe to allow any origin because the
		// endpoint is credential-free: it sets no cookie, reads no cookie, and
		// returns no data. Access-Control-Allow-Credentials is deliberately
		// absent, which is what keeps "*" from being a hole.
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type")
		h.Set("Access-Control-Max-Age", "86400")
		h.Set("Cache-Control", "no-store")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		ua := r.Header.Get("User-Agent")
		if agent := ParseUserAgent(ua); agent.IsBot {
			// Drop silently. Answering 204 keeps crawlers from noticing they
			// are filtered and switching to a less obvious UA.
			w.WriteHeader(http.StatusNoContent)
			return
		}

		ip := geoip.ClientIP(r, c.trustProxy)
		if !c.limit.allow(ip, time.Now()) {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}

		var b beacon
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
		if err := dec.Decode(&b); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		if err := c.Process(r.Context(), &b, ip, ua, time.Now().UTC()); err != nil {
			if errors.Is(err, errUnknownWebsite) || errors.Is(err, errBadBeacon) {
				// Same 204 as success: no oracle for which ids are real.
				w.WriteHeader(http.StatusNoContent)
				return
			}
			log.Printf("ingest: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

var (
	errUnknownWebsite = errors.New("ingest: unknown website")
	errBadBeacon      = errors.New("ingest: malformed beacon")
)

// ── Processing ────────────────────────────────────────────────────────────────

// Process records one beacon. Exported so tests can drive the full ingest path
// without an HTTP round trip.
func (c *Collector) Process(ctx context.Context, b *beacon, ip, ua string, now time.Time) error {
	if b.Payload.Website == "" {
		return errBadBeacon
	}
	site, err := c.sites.get(ctx, c.store, b.Payload.Website, now)
	if err != nil {
		return err
	}

	visit, err := c.resolveVisit(ctx, site, &b.Payload, ip, ua, now)
	if err != nil {
		return err
	}

	switch b.Type {
	case "heat":
		return c.recordHeat(ctx, site.ID, visit.ID, &b.Payload, now)
	case "event", "":
		return c.recordEvent(ctx, site.ID, visit.ID, &b.Payload, now)
	default:
		return errBadBeacon
	}
}

// resolveVisit finds the visitor's live session or opens a new one.
//
// Note the ordering: the visitor hash is computed, the GeoIP lookup is done, and
// the IP is then out of scope. Nothing downstream of this function has access to
// it.
func (c *Collector) resolveVisit(ctx context.Context, site *store.Website, p *payload, ip, ua string, now time.Time) (*store.Visit, error) {
	hash := c.ident.VisitorHash(site.ID, ip, ua, now)

	existing, err := c.store.GetVisitByHash(ctx, site.ID, hash, now.Add(-c.sessionWindow))
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}

	agent := ParseUserAgent(ua)
	screenW := screenWidth(p.Screen)
	loc := c.geo.Lookup(ip)
	ref := parseReferrer(p.Referrer, p.Hostname)
	utm := parseUTM(p.URL)

	v := &store.Visit{
		WebsiteID:   site.ID,
		VisitorHash: hash,
		Hostname:    p.Hostname,
		Browser:     agent.Browser,
		OS:          agent.OS,
		Device:      DeviceFromScreen(agent.Device, screenW),
		Screen:      p.Screen,
		Language:    normalizeLanguage(p.Language),
		Country:     loc.Country,
		Region:      loc.Region,
		City:        loc.City,
		Referrer:    ref.ExternalHost,
		UTMSource:   utm.Source,
		UTMMedium:   utm.Medium,
		UTMCampaign: utm.Campaign,
		UTMTerm:     utm.Term,
		UTMContent:  utm.Content,
		FirstAt:     now,
		LastAt:      now,
		Views:       0, // incremented by the pageview that follows
	}
	if err := c.store.CreateVisit(ctx, v); err != nil {
		return nil, err
	}
	return v, nil
}

func (c *Collector) recordEvent(ctx context.Context, siteID, visitID string, p *payload, now time.Time) error {
	path, query := splitURL(p.URL)
	ref := parseReferrer(p.Referrer, p.Hostname)

	e := &store.Event{
		WebsiteID: siteID,
		VisitID:   visitID,
		Type:      store.EventTypePageview,
		URLPath:   path,
		URLQuery:  query,
		Referrer:  ref.InternalPath,
		PageTitle: p.Title,
		CreatedAt: now,
	}
	if p.Name != "" {
		e.Type = store.EventTypeCustom
		e.Name = p.Name
	}
	if err := c.store.CreateEvent(ctx, e); err != nil {
		return err
	}

	// Only pageviews advance the view counter. A custom event must not turn a
	// single-page visit into a non-bounce, or bounce rate becomes a measure of
	// how much a site instruments itself rather than how visitors behave.
	if err := c.store.TouchVisit(ctx, visitID, now, e.Type == store.EventTypePageview); err != nil {
		return err
	}

	if len(p.Data) > 0 {
		if err := c.store.CreateEventData(ctx, buildEventData(siteID, e.ID, p.Data)); err != nil {
			return err
		}
	}
	if p.Revenue != nil {
		rev := &store.Revenue{
			WebsiteID:   siteID,
			VisitID:     visitID,
			EventID:     e.ID,
			OrderID:     p.Revenue.OrderID,
			Currency:    strings.ToUpper(strings.TrimSpace(p.Revenue.Currency)),
			AmountMinor: toMinorUnits(p.Revenue.Amount),
			CreatedAt:   now,
		}
		if err := c.store.CreateRevenue(ctx, rev); err != nil {
			return err
		}
	}
	return nil
}

func (c *Collector) recordHeat(ctx context.Context, siteID, visitID string, p *payload, now time.Time) error {
	if len(p.Heat) == 0 {
		return nil
	}
	if len(p.Heat) > maxHeatSamplesPerBeacon {
		p.Heat = p.Heat[:maxHeatSamplesPerBeacon]
	}
	defaultPath, _ := splitURL(p.URL)

	samples := make([]store.HeatSample, 0, len(p.Heat))
	for _, h := range p.Heat {
		kind := store.HeatKind(h.Kind)
		switch kind {
		case store.HeatClick, store.HeatScroll, store.HeatAttn:
		default:
			continue // unknown kinds are dropped, not stored as-is
		}
		path := defaultPath
		if h.Path != "" {
			path, _ = splitURL(h.Path)
		}
		samples = append(samples, store.HeatSample{
			WebsiteID: siteID,
			VisitID:   visitID,
			URLPath:   path,
			Kind:      kind,
			XPct:      clampPct(h.X),
			YPct:      clampPct(h.Y),
			ViewportW: clampInt(h.VW, 0, 20000),
			ViewportH: clampInt(h.VH, 0, 20000),
			ScrollPct: clampPct(h.Scroll),
			DwellMS:   clampInt(h.DwellMS, 0, 24*60*60*1000),
			Selector:  h.Selector,
			CreatedAt: now,
		})
	}
	if len(samples) == 0 {
		return nil
	}
	if err := c.store.CreateHeatSamples(ctx, samples); err != nil {
		return err
	}
	// Heatmap flushes keep the session alive but do not count as views.
	return c.store.TouchVisit(ctx, visitID, now, false)
}

// buildEventData converts a property map into typed rows, capping the count.
func buildEventData(siteID, eventID string, data map[string]any) []store.EventDatum {
	out := make([]store.EventDatum, 0, len(data))
	for k, v := range data {
		if len(out) >= maxEventProperties {
			break
		}
		d := store.EventDatum{EventID: eventID, WebsiteID: siteID, Key: k}
		switch val := v.(type) {
		case float64:
			d.NumberVal, d.IsNumber = val, true
		case bool:
			d.StringVal = strconv.FormatBool(val)
		case string:
			d.StringVal = val
		case nil:
			continue
		default:
			// Nested objects and arrays are flattened to their JSON text rather
			// than dropped; a property that arrives as an object is usually a
			// mistake, but losing it silently is worse than storing it.
			if raw, err := json.Marshal(val); err == nil {
				d.StringVal = string(raw)
			}
		}
		out = append(out, d)
	}
	return out
}

// toMinorUnits converts major units to integer minor units, rounding half away
// from zero. Money is never carried as a float past this point.
func toMinorUnits(amount float64) int64 {
	scaled := amount * 100
	if scaled >= 0 {
		return int64(scaled + 0.5)
	}
	return int64(scaled - 0.5)
}

func clampPct(v float64) float64 {
	switch {
	case v < 0:
		return 0
	case v > 100:
		return 100
	default:
		return v
	}
}

func clampInt(v, lo, hi int) int {
	switch {
	case v < lo:
		return lo
	case v > hi:
		return hi
	default:
		return v
	}
}

// ── Site cache ────────────────────────────────────────────────────────────────

// siteCache memoises website lookups. Every beacon needs one, and a self-hosted
// instance tracks a handful of sites — re-reading the row on each pageview would
// be the single hottest query in the process for no reason.
type siteCache struct {
	ttl time.Duration

	mu      sync.RWMutex
	entries map[string]siteCacheEntry
}

type siteCacheEntry struct {
	site    *store.Website
	expires time.Time
}

func newSiteCache(ttl time.Duration) *siteCache {
	return &siteCache{ttl: ttl, entries: map[string]siteCacheEntry{}}
}

func (sc *siteCache) get(ctx context.Context, st store.Store, id string, now time.Time) (*store.Website, error) {
	sc.mu.RLock()
	e, ok := sc.entries[id]
	sc.mu.RUnlock()
	if ok && now.Before(e.expires) {
		if e.site == nil {
			return nil, errUnknownWebsite // negative result, also cached
		}
		return e.site, nil
	}

	site, err := st.GetWebsite(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		// Cache the miss too: without it, a flood of beacons carrying a bogus
		// website id becomes a flood of database queries.
		sc.put(id, nil, now)
		return nil, errUnknownWebsite
	}
	if err != nil {
		return nil, err
	}
	sc.put(id, site, now)
	return site, nil
}

func (sc *siteCache) put(id string, site *store.Website, now time.Time) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	// Bound the map so cached misses cannot themselves become the memory leak.
	if len(sc.entries) > 10_000 {
		sc.entries = map[string]siteCacheEntry{}
	}
	sc.entries[id] = siteCacheEntry{site: site, expires: now.Add(sc.ttl)}
}

// Invalidate drops a cached website, so a rename or deletion takes effect
// immediately rather than after the TTL.
func (sc *siteCache) Invalidate(id string) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	delete(sc.entries, id)
}

// InvalidateSite lets the API layer evict a website the operator just changed.
func (c *Collector) InvalidateSite(id string) { c.sites.Invalidate(id) }

// ── Rate limiting ─────────────────────────────────────────────────────────────

// rateLimiter is a per-IP token bucket. The collect endpoint is unauthenticated
// by necessity, so it needs some bound; this one is generous enough that a real
// visitor clicking around a site will never see it, and tight enough that a
// single host cannot fabricate a million pageviews in a minute.
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	swept   time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

const (
	rateBurst      = 60.0 // requests available immediately
	ratePerSecond  = 5.0  // sustained rate
	rateSweepEvery = 10 * time.Minute
)

func newRateLimiter() *rateLimiter {
	return &rateLimiter{buckets: map[string]*bucket{}}
}

func (rl *rateLimiter) allow(key string, now time.Time) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	rl.sweepLocked(now)

	b, ok := rl.buckets[key]
	if !ok {
		rl.buckets[key] = &bucket{tokens: rateBurst - 1, last: now}
		return true
	}
	b.tokens += now.Sub(b.last).Seconds() * ratePerSecond
	if b.tokens > rateBurst {
		b.tokens = rateBurst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweepLocked discards idle buckets so the map cannot grow without bound under
// a spray of distinct source addresses.
func (rl *rateLimiter) sweepLocked(now time.Time) {
	if now.Sub(rl.swept) < rateSweepEvery {
		return
	}
	rl.swept = now
	cutoff := now.Add(-rateSweepEvery)
	for k, b := range rl.buckets {
		if b.last.Before(cutoff) {
			delete(rl.buckets, k)
		}
	}
}

// ── URL / referrer / UTM parsing ──────────────────────────────────────────────

// splitURL separates a tracker-reported URL into path and query. The tracker
// sends a path, but a hand-rolled integration may send an absolute URL, so both
// are handled.
func splitURL(raw string) (path, query string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "/", ""
	}
	if u, err := url.Parse(raw); err == nil {
		p := u.Path
		if p == "" {
			p = "/"
		}
		return p, u.RawQuery
	}
	if i := strings.IndexByte(raw, '?'); i >= 0 {
		return raw[:i], raw[i+1:]
	}
	return raw, ""
}

// referrerInfo separates the two kinds of referrer, which answer different
// questions: an external host is acquisition ("where did this visitor come
// from"), an internal path is navigation ("what did they read before this").
type referrerInfo struct {
	ExternalHost string
	InternalPath string
}

func parseReferrer(raw, hostname string) referrerInfo {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return referrerInfo{}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return referrerInfo{}
	}
	host := strings.TrimPrefix(strings.ToLower(u.Host), "www.")
	self := strings.TrimPrefix(strings.ToLower(hostname), "www.")

	if host == "" || (self != "" && host == self) {
		p := u.Path
		if p == "" {
			p = "/"
		}
		return referrerInfo{InternalPath: p}
	}
	return referrerInfo{ExternalHost: host}
}

// utmParams are the five standard campaign parameters.
type utmParams struct {
	Source, Medium, Campaign, Term, Content string
}

func parseUTM(rawURL string) utmParams {
	_, query := splitURL(rawURL)
	if query == "" {
		return utmParams{}
	}
	v, err := url.ParseQuery(query)
	if err != nil {
		return utmParams{}
	}
	return utmParams{
		Source:   v.Get("utm_source"),
		Medium:   v.Get("utm_medium"),
		Campaign: v.Get("utm_campaign"),
		Term:     v.Get("utm_term"),
		Content:  v.Get("utm_content"),
	}
}

// screenWidth pulls the width out of a "1920x1080" screen string.
func screenWidth(screen string) int {
	w, _, ok := strings.Cut(screen, "x")
	if !ok {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(w))
	if err != nil {
		return 0
	}
	return n
}

// normalizeLanguage lowercases and trims a BCP-47 tag, keeping at most
// language-REGION. Browsers report a long weighted list; storing the whole thing
// would fragment the breakdown into near-unique values.
func normalizeLanguage(lang string) string {
	lang = strings.TrimSpace(lang)
	if lang == "" {
		return ""
	}
	if i := strings.IndexAny(lang, ",;"); i >= 0 {
		lang = lang[:i]
	}
	parts := strings.Split(lang, "-")
	if len(parts) == 1 {
		return strings.ToLower(parts[0])
	}
	return strings.ToLower(parts[0]) + "-" + strings.ToUpper(parts[1])
}
