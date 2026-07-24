// Command athar-demo fabricates a rich, backdated demo dataset for one
// website, writing straight through the store package.
//
// # This is a development tool, not part of the product
//
// It is built by `go build ./backend/...` — and therefore vetted and
// compiled in CI like every other package — but it is NEVER linked into the
// `athar` binary and NEVER shipped to a user. Its only job is to give the
// screenshot pipeline (scripts/screenshots.mjs) and anyone eyeballing the
// dashboard locally something that looks like thirty days of a real small
// site, instead of the flat one-hour line that seeding through the live
// /api/send endpoint produces (that endpoint stamps time.Now() on every
// beacon — there is no way to backdate through it, and adding one would be a
// production backdoor).
//
// Because it writes directly to the store, it bypasses every safeguard the
// collector normally applies — rate limiting, bot filtering, GeoIP
// resolution, field validation. That is the point, but it is also why this
// command refuses to run against a database that already holds data unless
// -force is passed: nobody should be able to point it at a real instance by
// fat-fingering the -db flag.
//
// Usage:
//
//	go run ./backend/cmd/athar-demo -db ./athar.db -days 30
package main

import (
	"context"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"math"
	"math/rand"
	"time"

	"athar/backend/internal/auth"
	"athar/backend/internal/store"
)

func main() {
	var (
		dbFlag       = flag.String("db", "athar.db", "store DSN, passed straight to store.Open")
		daysFlag     = flag.Int("days", 30, "how many days of backdated history to generate")
		siteFlag     = flag.String("site", "Demo Shop", "website name")
		domainFlag   = flag.String("domain", "demo.example", "website domain")
		userFlag     = flag.String("user", "demo", "admin username to create")
		passwordFlag = flag.String("password", "athar-demo-password", "admin password to create")
		seedFlag     = flag.Int64("seed", 424242, "PRNG seed; the same seed always produces the same database")
		forceFlag    = flag.Bool("force", false, "allow writing into a database that already has data")
	)
	flag.Parse()

	if err := run(*dbFlag, *siteFlag, *domainFlag, *userFlag, *passwordFlag, *daysFlag, *seedFlag, *forceFlag); err != nil {
		log.Fatalf("athar-demo: %v", err)
	}
}

func run(dsn, site, domain, username, password string, days int, seed int64, force bool) error {
	if days < 1 {
		return fmt.Errorf("-days must be at least 1")
	}
	ctx := context.Background()

	st, err := store.Open(ctx, dsn)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	if err := st.Migrate(ctx); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	// A freshly migrated database has zero users. Anything else means either
	// this command already ran here, or -db points at a real instance — both
	// are reasons to stop, not reasons to guess.
	existing, err := st.CountUsers(ctx)
	if err != nil {
		return fmt.Errorf("count users: %w", err)
	}
	if existing > 0 && !force {
		return fmt.Errorf("database %q already has %d user(s) — refusing to seed demo data without -force", dsn, existing)
	}

	rng := rand.New(rand.NewSource(seed))

	passwordHash, err := auth.HashPassword(password)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	admin := &store.User{
		ID:           newID(rng),
		Username:     username,
		PasswordHash: passwordHash,
		Role:         store.RoleAdmin,
	}
	if err := st.CreateUser(ctx, admin); err != nil {
		return fmt.Errorf("create admin user: %w", err)
	}

	website := &store.Website{
		ID:      newID(rng),
		Name:    site,
		Domain:  domain,
		OwnerID: admin.ID,
	}
	if err := st.CreateWebsite(ctx, website); err != nil {
		return fmt.Errorf("create website: %w", err)
	}

	sum, err := generate(ctx, st, rng, website.ID, domain, days)
	if err != nil {
		return fmt.Errorf("generate demo data: %w", err)
	}

	log.Printf("athar-demo: seeded %q (%s) over %d days", site, website.ID, days)
	log.Printf("athar-demo: visits=%d pageviews=%d custom_events=%d heat_samples=%d revenue_rows=%d",
		sum.Visits, sum.Pageviews, sum.CustomEvents, sum.HeatSamples, sum.Revenue)

	// The last line on stdout is the machine-readable contract: the calling
	// script parses this to find the website it should screenshot. Everything
	// else above went to stderr via log.Printf so this stays the last line.
	fmt.Printf("website_id=%s\n", website.ID)
	return nil
}

// newID mints a deterministic 32-character hex identifier from the seeded
// PRNG. store.NewID() uses crypto/rand and cannot be seeded, so every row
// that needs an id gets one from here instead — that is what makes "same
// seed, same database" true down to the primary keys, not just the metrics.
func newID(rng *rand.Rand) string {
	b := make([]byte, 16)
	_, _ = rng.Read(b) // math/rand.Rand.Read never errors
	return hex.EncodeToString(b)
}

// ── Weighted choice ───────────────────────────────────────────────────────────

// weighted pairs a value with a relative selection weight. Weights are
// relative to each other within one slice, not normalised to any particular
// total — pick sums them itself.
type weighted[T any] struct {
	Value  T
	Weight float64
}

// pick draws one value from items, with probability proportional to weight.
func pick[T any](rng *rand.Rand, items []weighted[T]) T {
	var total float64
	for _, it := range items {
		total += it.Weight
	}
	r := rng.Float64() * total
	for _, it := range items {
		if r < it.Weight {
			return it.Value
		}
		r -= it.Weight
	}
	return items[len(items)-1].Value
}

// ── Site model: pages, navigation, geography, devices ─────────────────────────
//
// Everything in this section is a deliberately small, hand-authored model of
// one plausible SaaS-with-a-shop site. It exists so the generator can walk a
// visitor through a *path*, not just stamp independent random rows — reports
// like entry/exit page and bounce rate only look real when the underlying
// sessions are coherent journeys.

type pageSpec struct{ Path, Title string }

var pages = map[string]pageSpec{
	"/":                     {"/", "Demo Shop — self-hosted web analytics"},
	"/pricing":              {"/pricing", "Pricing — Demo Shop"},
	"/features":             {"/features", "Features — Demo Shop"},
	"/docs/getting-started": {"/docs/getting-started", "Getting Started — Demo Shop Docs"},
	"/docs/api":             {"/docs/api", "API Reference — Demo Shop Docs"},
	"/blog/why-self-host":   {"/blog/why-self-host", "Why Self-Host Your Analytics — Demo Shop Blog"},
	"/blog/changelog-0-1":   {"/blog/changelog-0-1", "Changelog 0.1 — Demo Shop Blog"},
	"/cart":                 {"/cart", "Your Cart — Demo Shop"},
	"/checkout":             {"/checkout", "Checkout — Demo Shop"},
	"/thanks":               {"/thanks", "Thank You — Demo Shop"},
}

// entryWeights governs which page a session lands on. Skewed hard to the
// homepage and the blog, because that is what acquisition traffic actually
// hits — nobody's first pageview is /checkout.
var entryWeights = []weighted[string]{
	{"/", 40},
	{"/blog/why-self-host", 15},
	{"/blog/changelog-0-1", 10},
	{"/pricing", 10},
	{"/features", 8},
	{"/docs/getting-started", 10},
	{"/docs/api", 4},
	{"/cart", 1},
	{"/checkout", 1},
	{"/thanks", 1},
}

// transitions is a small hand-authored Markov chain over the site: from each
// page, where a visitor plausibly clicks next. It is not exhaustive — a
// session that reaches a page with no listed transition (or rolls off the
// end of one) falls back to a fresh entryWeights pick, which just models a
// visitor jumping to another popular page via nav/search rather than ending
// the session outright. Session length is decided independently (see
// sessionViews), so this only shapes *which* pages appear, not how many.
var transitions = map[string][]weighted[string]{
	"/":                     {{"/pricing", 25}, {"/features", 20}, {"/docs/getting-started", 15}, {"/blog/why-self-host", 15}, {"/blog/changelog-0-1", 8}, {"/docs/api", 5}, {"/cart", 2}},
	"/pricing":              {{"/checkout", 22}, {"/features", 15}, {"/docs/getting-started", 10}, {"/", 10}, {"/cart", 8}},
	"/features":             {{"/pricing", 30}, {"/docs/getting-started", 20}, {"/", 15}},
	"/docs/getting-started": {{"/docs/api", 30}, {"/pricing", 10}, {"/", 10}, {"/blog/why-self-host", 8}},
	"/docs/api":             {{"/docs/getting-started", 20}, {"/pricing", 10}, {"/", 10}},
	"/blog/why-self-host":   {{"/", 20}, {"/pricing", 15}, {"/blog/changelog-0-1", 15}, {"/docs/getting-started", 10}},
	"/blog/changelog-0-1":   {{"/", 20}, {"/blog/why-self-host", 15}, {"/docs/getting-started", 10}},
	"/cart":                 {{"/checkout", 55}, {"/pricing", 10}},
	// "/checkout" and "/thanks" have no listed transitions: reaching either is
	// the end of a natural funnel, so running past them falls back to
	// entryWeights (a visitor browsing on after checking out).
}

// transitionPick returns the next page after cur, if the chain defines one.
func transitionPick(rng *rand.Rand, cur string) (string, bool) {
	next, ok := transitions[cur]
	if !ok || len(next) == 0 {
		return "", false
	}
	return pick(rng, next), true
}

// buildPath walks the transition chain from entry until it has views pages.
func buildPath(rng *rand.Rand, entry string, views int) []string {
	path := make([]string, 1, views)
	path[0] = entry
	cur := entry
	for len(path) < views {
		next, ok := transitionPick(rng, cur)
		if !ok {
			next = pick(rng, entryWeights)
		}
		path = append(path, next)
		cur = next
	}
	return path
}

// buildPurchasePath builds a session that ends in a completed checkout: a
// short lead-in through the marketing site, then pricing → checkout →
// thanks. This is used for the sessions the generator has pre-selected to
// carry a revenue row (see purchase selection in generate), so that revenue
// is correlated with actual checkout journeys rather than sprinkled onto
// arbitrary sessions.
func buildPurchasePath(rng *rand.Rand) []string {
	leadViews := 1 + rng.Intn(3) // 1..3 pages before pricing
	entry := pick(rng, entryWeights)
	path := make([]string, 1, leadViews+3)
	path[0] = entry
	cur := entry
	for len(path) < leadViews {
		next, ok := transitionPick(rng, cur)
		if !ok || next == "/checkout" || next == "/thanks" {
			next = pick(rng, entryWeights)
		}
		path = append(path, next)
		cur = next
	}
	if path[len(path)-1] != "/pricing" {
		path = append(path, "/pricing")
	}
	return append(path, "/checkout", "/thanks")
}

// sessionViews picks a pageview count for a non-bounce session. Weighted
// toward the low end — most people who click past the first page still only
// look at two or three — with a long, thin tail up to the 8-page ceiling.
var viewCountWeights = []weighted[int]{
	{2, 35}, {3, 25}, {4, 15}, {5, 10}, {6, 8}, {7, 4}, {8, 3},
}

// geoPoint is one internally-consistent country/region/city/language tuple.
// Populated directly on visits rather than resolved via GeoIP, since no
// .mmdb ships with this tool — see the package doc.
type geoPoint struct{ Country, Region, City, Lang string }

// geos is a plausible, weighted spread of visitor geography. Region and city
// are real places for the given country — an inconsistent combination (a
// screenshot reading "United States / Bavaria") would be worse than empty
// fields, so every row here was picked by hand rather than assembled from
// independent lists.
var geos = []weighted[geoPoint]{
	{geoPoint{"US", "California", "San Francisco", "en-US"}, 20},
	{geoPoint{"GB", "England", "London", "en-GB"}, 10},
	{geoPoint{"DE", "Berlin", "Berlin", "de-DE"}, 8},
	{geoPoint{"IN", "Maharashtra", "Mumbai", "en-IN"}, 8},
	{geoPoint{"BR", "São Paulo", "São Paulo", "pt-BR"}, 6},
	{geoPoint{"NG", "Lagos", "Lagos", "en-NG"}, 5},
	{geoPoint{"KE", "Nairobi County", "Nairobi", "sw-KE"}, 5},
	{geoPoint{"JP", "Tokyo", "Tokyo", "ja-JP"}, 5},
	{geoPoint{"FR", "Île-de-France", "Paris", "fr-FR"}, 5},
	{geoPoint{"CA", "Ontario", "Toronto", "en-CA"}, 5},
	{geoPoint{"AU", "New South Wales", "Sydney", "en-AU"}, 4},
	{geoPoint{"NL", "North Holland", "Amsterdam", "nl-NL"}, 4},
	{geoPoint{"ES", "Community of Madrid", "Madrid", "es-ES"}, 3},
	{geoPoint{"SE", "Stockholm County", "Stockholm", "sv-SE"}, 3},
	{geoPoint{"SG", "Central Singapore", "Singapore", "en-SG"}, 3},
	{geoPoint{"ZA", "Gauteng", "Johannesburg", "en-ZA"}, 3},
	{geoPoint{"PL", "Masovian Voivodeship", "Warsaw", "pl-PL"}, 3},
	{geoPoint{"MX", "Mexico City", "Mexico City", "es-MX"}, 3},
}

// devArchetype bundles device/OS/browser/screen so the combination is always
// coherent — an archetype is picked as one unit, never assembled from
// independently-rolled dimensions, which is what keeps "Safari on Windows"
// or "iPadOS phone" from ever appearing. Every Browser/OS/Device string here
// is copied verbatim from ingest/useragent.go's classifier output.
type devArchetype struct {
	Device, OS, Browser string
	Screens             []string
}

var archetypes = []weighted[devArchetype]{
	{devArchetype{"desktop", "Windows", "Chrome", []string{"1920x1080", "2560x1440", "1366x768"}}, 26},
	{devArchetype{"desktop", "Windows", "Edge", []string{"1920x1080", "1536x864"}}, 8},
	{devArchetype{"desktop", "Windows", "Firefox", []string{"1920x1080", "1440x900"}}, 5},
	{devArchetype{"desktop", "Windows", "Brave", []string{"1920x1080"}}, 2},
	{devArchetype{"desktop", "macOS", "Safari", []string{"1512x982", "1440x900", "2560x1600"}}, 12},
	{devArchetype{"desktop", "macOS", "Chrome", []string{"1512x982", "1440x900"}}, 10},
	{devArchetype{"desktop", "macOS", "Firefox", []string{"1440x900"}}, 2},
	{devArchetype{"desktop", "Linux", "Firefox", []string{"1920x1080"}}, 4},
	{devArchetype{"desktop", "Linux", "Chrome", []string{"1920x1080"}}, 3},
	{devArchetype{"desktop", "Chrome OS", "Chrome", []string{"1366x768"}}, 2},
	{devArchetype{"mobile", "iOS", "Safari", []string{"390x844", "393x852", "428x926"}}, 14},
	{devArchetype{"mobile", "Android", "Chrome", []string{"412x915", "360x800", "393x873"}}, 16},
	{devArchetype{"mobile", "Android", "Samsung Internet", []string{"412x915"}}, 4},
	{devArchetype{"mobile", "Android", "Opera", []string{"412x915"}}, 2},
	{devArchetype{"mobile", "Android", "Firefox", []string{"393x873"}}, 1},
	{devArchetype{"tablet", "iPadOS", "Safari", []string{"1024x1366", "820x1180"}}, 5},
	{devArchetype{"tablet", "Android", "Chrome", []string{"800x1280"}}, 2},
}

// referrers is the acquisition mix once "direct" (handled separately, see
// pickReferrer) is excluded.
var referrers = []weighted[string]{
	{"google.com", 25},
	{"news.ycombinator.com", 10},
	{"duckduckgo.com", 8},
	{"github.com", 8},
	{"reddit.com", 6},
	{"bing.com", 5},
	{"lobste.rs", 4},
	{"mastodon.social", 4},
}

// pickReferrer chooses a session's referring host. On the spike day it skews
// hard toward Hacker News, which is the whole point of modelling a spike day
// at all — a chart with an unexplained traffic bump is less interesting than
// one a viewer can attribute to "front page of HN".
func pickReferrer(rng *rand.Rand, spike bool) string {
	if spike && rng.Float64() < 0.72 {
		return "news.ycombinator.com"
	}
	if rng.Float64() < 0.40 {
		return "" // direct
	}
	return pick(rng, referrers)
}

// campaign is one named UTM campaign with a source/medium pair sensible for
// that channel, and the referring host (if any) that traffic through it
// would plausibly carry — an email campaign has no referrer, a launch post
// does.
type campaign struct{ Source, Medium, Campaign, Referrer string }

var campaigns = []campaign{
	{"producthunt", "referral", "launch", "producthunt.com"},
	{"newsletter", "email", "newsletter-oct", ""},
	{"twitter", "social", "docs-refresh", "t.co"},
}

// planWeights covers the pricing tiers a "plan_selected" event might report.
var planWeights = []weighted[string]{{"starter", 50}, {"pro", 35}, {"team", 15}}

var docQueries = []string{
	"heatmaps", "utm tracking", "self hosting", "postgres migration",
	"api keys", "csv export", "bounce rate", "geoip setup",
}

// priceTiers are amounts (integer minor units) a checkout might land on —
// clustered around a few plan prices, with a couple of larger outliers for
// annual/enterprise orders.
var priceTiers = []weighted[int64]{
	{2900, 28}, {4900, 28}, {9900, 20}, {14997, 14}, {49900, 6}, {99900, 4},
}

// ── Time shape ──────────────────────────────────────────────────────────────
//
// A believable traffic chart needs three things layered on top of each
// other: a weekly rhythm, a daily (diurnal) rhythm, and a slow trend across
// the whole window. Each is modelled as an independent multiplier and
// combined, which is what lets each be reasoned about (and tuned)
// separately.

// hourWeights is the diurnal curve: quiet overnight, ramps up through the
// morning, a mid-morning peak, a dip around lunch, an afternoon peak, then a
// gentle decline into the evening. Index is the hour of day (UTC).
var hourWeights = [24]float64{
	0.35, 0.22, 0.12, 0.08, 0.07, 0.10, 0.22, 0.45,
	0.75, 1.15, 1.55, 1.35, 1.10, 1.05, 1.25, 1.60,
	1.35, 1.05, 0.85, 0.75, 0.65, 0.55, 0.48, 0.40,
}

func pickHour(rng *rand.Rand) int {
	items := make([]weighted[int], 24)
	for h, w := range hourWeights {
		items[h] = weighted[int]{h, w}
	}
	return pick(rng, items)
}

// weekdayMultiplier is the weekly rhythm: a B2B/dev-tool site's traffic
// leans hard into the work week and drops off on weekends.
func weekdayMultiplier(t time.Time) float64 {
	switch t.Weekday() {
	case time.Saturday:
		return 0.55
	case time.Sunday:
		return 0.50
	case time.Friday:
		return 1.15
	default:
		return 1.05
	}
}

// daySchedule is one calendar day's slice of the plan: how many sessions
// land on it, and whether it is the one spike day.
type daySchedule struct {
	date    time.Time // midnight UTC
	visits  int
	isSpike bool
}

// baseVisitsPerDay is the traffic level an unremarkable weekday in the
// middle of the window gets, before the weekly/growth/spike multipliers are
// applied. It is picked to land the whole window in "small real site"
// territory (a couple of thousand sessions over 30 days), not a showcase.
const baseVisitsPerDay = 55

// buildSchedule lays out `days` full calendar days ending yesterday (never
// today) so that no generated timestamp can land in the future relative to
// when this command runs — a "backdated" dataset should never accidentally
// mean "postdated".
func buildSchedule(rng *rand.Rand, days int, now time.Time) []daySchedule {
	todayMidnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	start := todayMidnight.AddDate(0, 0, -days)

	// The spike lands 60-70% through the window — late enough to read as
	// "something happened recently", early enough that the growth trend
	// after it still has room to show.
	spikeIdx := int(math.Round(float64(days-1) * (0.60 + rng.Float64()*0.10)))
	spikeAmplitude := 4.5 + rng.Float64()*1.5 // 4.5x-6x, per the "4-6x" spec

	out := make([]daySchedule, days)
	for i := 0; i < days; i++ {
		date := start.AddDate(0, 0, i)
		mult := weekdayMultiplier(date)

		// Growth trend: linear from 0.75x at the start of the window to 1.35x
		// at the end, so a 30-day chart reads as "this is catching on"
		// instead of a flat shelf.
		growth := 0.75
		if days > 1 {
			growth = 0.75 + 0.60*float64(i)/float64(days-1)
		}
		mult *= growth

		isSpike := i == spikeIdx
		if isSpike {
			mult *= spikeAmplitude
		}

		visits := int(math.Round(baseVisitsPerDay * mult))
		if visits < 1 {
			visits = 1
		}
		out[i] = daySchedule{date: date, visits: visits, isSpike: isSpike}
	}
	return out
}

// ── Heatmap shape ─────────────────────────────────────────────────────────────

// heatCluster is one "hot spot" on a page: a gaussian blob of clicks around
// a centre point, with the CSS selector that spot represents. Real click
// maps cluster hard around a handful of interactive elements plus a thin
// scatter of stray clicks — never a uniform wash across the page — which is
// why sampling is centre+sigma per cluster rather than one bounding box.
type heatCluster struct {
	CX, CY, SigmaX, SigmaY, Weight float64
	Selector                       string
}

// strayCluster models the residual clicks that land nowhere in particular —
// misclicks, text selection, clicks on plain content. A wide sigma spreads
// them across most of the page rather than concentrating them anywhere.
var strayCluster = heatCluster{CX: 50, CY: 50, SigmaX: 35, SigmaY: 35, Weight: 10, Selector: ""}

var heatClusters = map[string][]heatCluster{
	"/": {
		{CX: 50, CY: 4, SigmaX: 18, SigmaY: 1.5, Weight: 30, Selector: "header > nav a.nav-link"},
		{CX: 50, CY: 32, SigmaX: 8, SigmaY: 4, Weight: 40, Selector: "main > section.hero button.cta"},
		{CX: 50, CY: 97, SigmaX: 20, SigmaY: 1.5, Weight: 15, Selector: "footer > div a"},
	},
	"/pricing": {
		{CX: 50, CY: 4, SigmaX: 18, SigmaY: 1.5, Weight: 20, Selector: "header > nav a.nav-link"},
		{CX: 22, CY: 46, SigmaX: 5, SigmaY: 4, Weight: 15, Selector: "main > section.plans div.plan-card button"},
		{CX: 50, CY: 46, SigmaX: 5, SigmaY: 4, Weight: 35, Selector: "main > section.plans div.plan-card button"}, // the highlighted "pro" card gets the most clicks
		{CX: 78, CY: 46, SigmaX: 5, SigmaY: 4, Weight: 15, Selector: "main > section.plans div.plan-card button"},
		{CX: 50, CY: 97, SigmaX: 20, SigmaY: 1.5, Weight: 10, Selector: "footer > div a"},
	},
	"/docs/getting-started": {
		{CX: 50, CY: 4, SigmaX: 18, SigmaY: 1.5, Weight: 15, Selector: "header > nav a.nav-link"},
		{CX: 12, CY: 50, SigmaX: 4, SigmaY: 22, Weight: 35, Selector: "aside.docs-nav a"},
		{CX: 55, CY: 88, SigmaX: 12, SigmaY: 3, Weight: 20, Selector: "main article a.next"},
	},
}

func clusterWeights(clusters []heatCluster) []weighted[heatCluster] {
	items := make([]weighted[heatCluster], 0, len(clusters)+1)
	for _, c := range clusters {
		items = append(items, weighted[heatCluster]{c, c.Weight})
	}
	return append(items, weighted[heatCluster]{strayCluster, strayCluster.Weight})
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

// sampleScrollDepth models the classic drop-off curve: most sessions make it
// a quarter to two-thirds down the page, a smaller share scrolls deep, and a
// thin tail hits the very bottom.
func sampleScrollDepth(rng *rand.Rand) float64 {
	r := rng.Float64()
	switch {
	case r < 0.65:
		return 20 + rng.Float64()*40 // 20-60%
	case r < 0.90:
		return 60 + rng.Float64()*30 // 60-90%
	default:
		return 90 + rng.Float64()*10 // 90-100%
	}
}

// attnDwellMS models per-band attention time decaying with depth: visitors
// spend the most time with what they see first.
func attnDwellMS(rng *rand.Rand, band int) int {
	base := 4200 - band*380
	if base < 300 {
		base = 300
	}
	return base + rng.Intn(700) - 300
}

// ── Generation ────────────────────────────────────────────────────────────────

// summary is what gets reported to the operator at the end of a run.
type summary struct {
	Visits, Pageviews, CustomEvents, HeatSamples, Revenue int
}

// pathHit records one occasion a generated session viewed one of the target
// heatmap pages, so heat samples can be attached to a *real* visit that
// actually viewed that path, at a time within that visit's own window.
type pathHit struct {
	VisitID                       string
	At, VisitFirstAt, VisitLastAt time.Time
	ScreenW, ScreenH              int
}

// heatTargetPaths are the pages heatmap samples are generated for. Three, as
// the brief asks for, chosen because they cover the product's three main
// heatmap use cases: a marketing homepage, a pricing/conversion page, and a
// content page with a sidebar.
var heatTargetPaths = []string{"/", "/pricing", "/docs/getting-started"}

func generate(ctx context.Context, st store.Store, rng *rand.Rand, websiteID, hostname string, days int) (summary, error) {
	schedule := buildSchedule(rng, days, time.Now().UTC())

	// Flatten the per-day plan into one slice mapping session index -> day
	// index. This keeps the rest of the function from caring how sessions
	// are distributed across days; it just walks a flat list.
	var sessionDay []int
	for i, d := range schedule {
		for n := 0; n < d.visits; n++ {
			sessionDay = append(sessionDay, i)
		}
	}
	total := len(sessionDay)

	// Reserve a subset of sessions, spread uniformly across the whole
	// window, to be completed checkouts. Picking the set up front (rather
	// than rolling the dice per-session) is what lets the count land exactly
	// in the 60-90 range the brief asks for, regardless of how traffic
	// happens to be distributed across days.
	purchaseCount := 60 + rng.Intn(31)
	if purchaseCount > total {
		purchaseCount = total
	}
	forcePurchase := make([]bool, total)
	for _, idx := range rng.Perm(total)[:purchaseCount] {
		forcePurchase[idx] = true
	}

	pathHits := make(map[string][]pathHit, len(heatTargetPaths))
	for _, p := range heatTargetPaths {
		pathHits[p] = nil
	}

	var sum summary
	orderSeq := 1000

	for i := 0; i < total; i++ {
		day := schedule[sessionDay[i]]

		firstAt := day.date.Add(
			time.Duration(pickHour(rng))*time.Hour +
				time.Duration(rng.Intn(60))*time.Minute +
				time.Duration(rng.Intn(60))*time.Second,
		)

		arch := pick(rng, archetypes)
		screen := arch.Screens[rng.Intn(len(arch.Screens))]
		geo := pick(rng, geos)

		// UTM campaigns imply their own referrer (or lack of one) and are
		// mutually exclusive with the spike-day HN skew — a campaign click
		// and an organic HN hit are different visitors telling different
		// stories.
		var utm campaign
		hasUTM := !day.isSpike && rng.Float64() < 0.20
		referrer := ""
		if hasUTM {
			utm = campaigns[rng.Intn(len(campaigns))]
			referrer = utm.Referrer
		} else {
			referrer = pickReferrer(rng, day.isSpike)
		}

		purchase := forcePurchase[i]

		var path []string
		switch {
		case purchase:
			path = buildPurchasePath(rng)
		case rng.Float64() < 0.45: // bounce: the single-pageview session
			path = []string{pick(rng, entryWeights)}
		default:
			path = buildPath(rng, pick(rng, entryWeights), pick(rng, viewCountWeights))
		}

		gaps := sessionGaps(rng, len(path))
		timestamps := make([]time.Time, len(path))
		timestamps[0] = firstAt
		for j, g := range gaps {
			timestamps[j+1] = timestamps[j].Add(g)
		}
		lastAt := timestamps[len(timestamps)-1]

		visit := &store.Visit{
			ID:          newID(rng),
			WebsiteID:   websiteID,
			VisitorHash: newID(rng), // stands in for the salted per-day hash a real beacon would carry
			Hostname:    hostname,
			Browser:     arch.Browser,
			OS:          arch.OS,
			Device:      arch.Device,
			Screen:      screen,
			Language:    geo.Lang,
			Country:     geo.Country,
			Region:      geo.Region,
			City:        geo.City,
			Referrer:    referrer,
			Views:       len(path),
			FirstAt:     firstAt,
			LastAt:      lastAt,
		}
		if hasUTM {
			visit.UTMSource = utm.Source
			visit.UTMMedium = utm.Medium
			visit.UTMCampaign = utm.Campaign
		}
		if err := st.CreateVisit(ctx, visit); err != nil {
			return sum, fmt.Errorf("create visit: %w", err)
		}
		sum.Visits++

		screenW, screenH := splitScreen(screen)
		var checkoutEventID string

		for j, p := range path {
			spec, ok := pages[p]
			if !ok {
				spec = pageSpec{p, p}
			}
			ev := &store.Event{
				ID:        newID(rng),
				WebsiteID: websiteID,
				VisitID:   visit.ID,
				Type:      store.EventTypePageview,
				URLPath:   spec.Path,
				PageTitle: spec.Title,
				CreatedAt: timestamps[j],
			}
			if j > 0 {
				ev.Referrer = path[j-1] // on-site navigation, mirroring parseReferrer's InternalPath
			}
			if j == 0 && hasUTM {
				ev.URLQuery = fmt.Sprintf("utm_source=%s&utm_medium=%s&utm_campaign=%s", utm.Source, utm.Medium, utm.Campaign)
			}
			if err := st.CreateEvent(ctx, ev); err != nil {
				return sum, fmt.Errorf("create pageview: %w", err)
			}
			sum.Pageviews++

			for _, hp := range heatTargetPaths {
				if hp == p {
					pathHits[hp] = append(pathHits[hp], pathHit{
						VisitID: visit.ID, At: timestamps[j],
						VisitFirstAt: firstAt, VisitLastAt: lastAt,
						ScreenW: screenW, ScreenH: screenH,
					})
				}
			}

			// Custom events fired alongside particular pages — the shape a
			// real shop's instrumentation would actually produce.
			switch p {
			case "/pricing":
				if purchase || rng.Float64() < 0.12 {
					plan := pick(rng, planWeights)
					data := []store.EventDatum{{Key: "plan", StringVal: plan}}
					if plan == "team" {
						data = append(data, store.EventDatum{Key: "seats", NumberVal: float64(2 + rng.Intn(8)), IsNumber: true})
					}
					id, err := emitCustom(ctx, st, rng, websiteID, visit.ID, spec, "plan_selected", timestamps[j], lastAt, data)
					if err != nil {
						return sum, err
					}
					_ = id
					sum.CustomEvents++
				}
				if !purchase && rng.Float64() < 0.10 {
					if _, err := emitCustom(ctx, st, rng, websiteID, visit.ID, spec, "add_to_cart", timestamps[j], lastAt,
						[]store.EventDatum{{Key: "sku", StringVal: fmt.Sprintf("SKU-%d", 100+rng.Intn(20))}}); err != nil {
						return sum, err
					}
					sum.CustomEvents++
				}
			case "/cart":
				if rng.Float64() < 0.35 {
					if _, err := emitCustom(ctx, st, rng, websiteID, visit.ID, spec, "add_to_cart", timestamps[j], lastAt,
						[]store.EventDatum{{Key: "sku", StringVal: fmt.Sprintf("SKU-%d", 100+rng.Intn(20))}}); err != nil {
						return sum, err
					}
					sum.CustomEvents++
				}
			case "/docs/getting-started", "/docs/api":
				if rng.Float64() < 0.15 {
					data := []store.EventDatum{
						{Key: "query", StringVal: docQueries[rng.Intn(len(docQueries))]},
						{Key: "results", NumberVal: float64(rng.Intn(12)), IsNumber: true},
					}
					if _, err := emitCustom(ctx, st, rng, websiteID, visit.ID, spec, "docs_search", timestamps[j], lastAt, data); err != nil {
						return sum, err
					}
					sum.CustomEvents++
				}
			case "/checkout":
				if purchase || rng.Float64() < 0.5 {
					id, err := emitCustom(ctx, st, rng, websiteID, visit.ID, spec, "begin_checkout", timestamps[j], lastAt, nil)
					if err != nil {
						return sum, err
					}
					checkoutEventID = id
					sum.CustomEvents++
				}
			}
		}

		// Signup is independent of any one page — it fires near the end of a
		// session that engaged with the site but did not purchase.
		if !purchase && len(path) >= 2 && rng.Float64() < 0.04 {
			last := pages[path[len(path)-1]]
			source := "organic"
			if hasUTM {
				source = utm.Source
			}
			if _, err := emitCustom(ctx, st, rng, websiteID, visit.ID, last, "signup", lastAt, lastAt,
				[]store.EventDatum{{Key: "plan", StringVal: "trial"}, {Key: "source", StringVal: source}}); err != nil {
				return sum, err
			}
			sum.CustomEvents++
		}

		if purchase {
			amount := pick(rng, priceTiers)
			currency := "USD"
			if rng.Float64() < 0.15 {
				currency = "EUR"
			}
			orderSeq++
			rev := &store.Revenue{
				ID:          newID(rng),
				WebsiteID:   websiteID,
				VisitID:     visit.ID,
				EventID:     checkoutEventID,
				OrderID:     fmt.Sprintf("ATH-%05d", orderSeq),
				Currency:    currency,
				AmountMinor: amount,
				CreatedAt:   lastAt,
			}
			if err := st.CreateRevenue(ctx, rev); err != nil {
				return sum, fmt.Errorf("create revenue: %w", err)
			}
			sum.Revenue++
		}
	}

	n, err := generateHeatSamples(ctx, st, rng, websiteID, pathHits)
	if err != nil {
		return sum, err
	}
	sum.HeatSamples = n

	return sum, nil
}

// sessionGaps produces the inter-pageview gaps for a session with the given
// number of pageviews, capped so total session dwell never exceeds six
// minutes — long enough to look like someone reading, short enough to still
// look like one sitting.
func sessionGaps(rng *rand.Rand, views int) []time.Duration {
	if views <= 1 {
		return nil
	}
	gaps := make([]time.Duration, views-1)
	var total time.Duration
	for i := range gaps {
		g := time.Duration(10+rng.Intn(80)) * time.Second // 10-89s per page
		gaps[i] = g
		total += g
	}
	const cap = 6 * time.Minute
	if total > cap {
		scale := float64(cap) / float64(total)
		for i := range gaps {
			gaps[i] = time.Duration(float64(gaps[i]) * scale)
		}
	}
	return gaps
}

// emitCustom writes one custom event (and its properties, if any) at a time
// shortly after pageAt, clamped to stay inside the visit's own window.
// Returns the event id so callers that need to reference it (revenue →
// begin_checkout) can.
func emitCustom(ctx context.Context, st store.Store, rng *rand.Rand, websiteID, visitID string, spec pageSpec, name string, pageAt, visitLastAt time.Time, data []store.EventDatum) (string, error) {
	at := pageAt.Add(time.Duration(1+rng.Intn(10)) * time.Second)
	if at.After(visitLastAt) {
		at = visitLastAt
	}
	ev := &store.Event{
		ID:        newID(rng),
		WebsiteID: websiteID,
		VisitID:   visitID,
		Type:      store.EventTypeCustom,
		Name:      name,
		URLPath:   spec.Path,
		PageTitle: spec.Title,
		CreatedAt: at,
	}
	if err := st.CreateEvent(ctx, ev); err != nil {
		return "", fmt.Errorf("create custom event %s: %w", name, err)
	}
	if len(data) > 0 {
		for i := range data {
			data[i].ID = newID(rng)
			data[i].EventID = ev.ID
			data[i].WebsiteID = websiteID
		}
		if err := st.CreateEventData(ctx, data); err != nil {
			return "", fmt.Errorf("create event data for %s: %w", name, err)
		}
	}
	return ev.ID, nil
}

// generateHeatSamples builds click/scroll/attention samples for each target
// path from the real visits recorded as having viewed it. Writes are
// batched through CreateHeatSamples rather than one call per sample — with
// several thousand samples, per-row calls would be the difference between
// this command taking seconds and taking minutes.
func generateHeatSamples(ctx context.Context, st store.Store, rng *rand.Rand, websiteID string, pathHits map[string][]pathHit) (int, error) {
	const (
		clicksPerPath     = 800
		scrollsPerPath    = 250
		attnGroupsPerPath = 120
		flushEvery        = 500
	)

	total := 0
	var batch []store.HeatSample
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := st.CreateHeatSamples(ctx, batch); err != nil {
			return fmt.Errorf("create heat samples: %w", err)
		}
		total += len(batch)
		batch = batch[:0]
		return nil
	}

	for _, path := range heatTargetPaths {
		hits := pathHits[path]
		if len(hits) == 0 {
			continue // no session ever viewed this path at these traffic levels; nothing to sample
		}
		clusters := clusterWeights(heatClusters[path])

		sampleAt := func(h pathHit) time.Time {
			slack := h.VisitLastAt.Sub(h.At)
			if slack <= 0 {
				return h.At
			}
			if slack > 30*time.Second {
				slack = 30 * time.Second
			}
			return h.At.Add(time.Duration(rng.Int63n(int64(slack) + 1)))
		}

		for k := 0; k < clicksPerPath; k++ {
			h := hits[rng.Intn(len(hits))]
			c := pick(rng, clusters)
			x := clampPct(c.CX + rng.NormFloat64()*c.SigmaX)
			y := clampPct(c.CY + rng.NormFloat64()*c.SigmaY)
			batch = append(batch, store.HeatSample{
				ID: newID(rng), WebsiteID: websiteID, VisitID: h.VisitID, URLPath: path,
				Kind: store.HeatClick, XPct: x, YPct: y,
				ViewportW: h.ScreenW, ViewportH: h.ScreenH,
				Selector: c.Selector, CreatedAt: sampleAt(h),
			})
			if len(batch) >= flushEvery {
				if err := flush(); err != nil {
					return total, err
				}
			}
		}

		for k := 0; k < scrollsPerPath; k++ {
			h := hits[rng.Intn(len(hits))]
			batch = append(batch, store.HeatSample{
				ID: newID(rng), WebsiteID: websiteID, VisitID: h.VisitID, URLPath: path,
				Kind: store.HeatScroll, ScrollPct: sampleScrollDepth(rng),
				ViewportW: h.ScreenW, ViewportH: h.ScreenH,
				CreatedAt: sampleAt(h),
			})
			if len(batch) >= flushEvery {
				if err := flush(); err != nil {
					return total, err
				}
			}
		}

		for k := 0; k < attnGroupsPerPath; k++ {
			h := hits[rng.Intn(len(hits))]
			at := sampleAt(h)
			for band := 0; band < 10; band++ {
				batch = append(batch, store.HeatSample{
					ID: newID(rng), WebsiteID: websiteID, VisitID: h.VisitID, URLPath: path,
					Kind: store.HeatAttn, ScrollPct: float64(band * 10), DwellMS: attnDwellMS(rng, band),
					ViewportW: h.ScreenW, ViewportH: h.ScreenH,
					CreatedAt: at,
				})
				if len(batch) >= flushEvery {
					if err := flush(); err != nil {
						return total, err
					}
				}
			}
		}
	}
	if err := flush(); err != nil {
		return total, err
	}
	return total, nil
}

// splitScreen parses a "WxH" screen string, tolerating the malformed case
// (returns zeros, which is what an unset viewport already means downstream).
func splitScreen(screen string) (w, h int) {
	var a, b int
	if _, err := fmt.Sscanf(screen, "%dx%d", &a, &b); err != nil {
		return 0, 0
	}
	return a, b
}
