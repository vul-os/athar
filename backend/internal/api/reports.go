package api

import (
	"context"
	"net/http"
	"time"

	"athar/backend/internal/auth"
	"athar/backend/internal/store"
)

// summaryView is the headline metrics block.
//
// Bounce rate and average visit time are returned pre-computed rather than left
// to the client: they are ratios over the same two numbers, and two clients
// computing them independently is two chances to disagree about what a bounce is.
type summaryView struct {
	Pageviews    int64   `json:"pageviews"`
	Visits       int64   `json:"visits"`
	Visitors     int64   `json:"visitors"`
	Bounces      int64   `json:"bounces"`
	BounceRate   float64 `json:"bounce_rate"`
	AvgVisitSec  float64 `json:"avg_visit_seconds"`
	TotalTimeSec int64   `json:"total_time_seconds"`
	From         int64   `json:"from"`
	To           int64   `json:"to"`
}

func (a *API) handleStats(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessRead)
	if site == nil {
		return
	}
	a.writeSummary(r.Context(), w, r, site.ID)
}

func (a *API) writeSummary(ctx context.Context, w http.ResponseWriter, r *http.Request, websiteID string) {
	rg, err := parseRange(r)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	sum, err := a.store.Summary(ctx, websiteID, rg)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not compute stats")
		return
	}
	auth.WriteJSON(w, http.StatusOK, summaryView{
		Pageviews:    sum.Pageviews,
		Visits:       sum.Visits,
		Visitors:     sum.Visitors,
		Bounces:      sum.Bounces,
		BounceRate:   sum.BounceRate(),
		AvgVisitSec:  sum.AvgVisitSec(),
		TotalTimeSec: sum.TotalTimeSec,
		From:         rg.From.UnixMilli(),
		To:           rg.To.UnixMilli(),
	})
}

type seriesPoint struct {
	T         int64 `json:"t"`
	Pageviews int64 `json:"pageviews"`
	Visitors  int64 `json:"visitors"`
}

func (a *API) handleSeries(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessRead)
	if site == nil {
		return
	}
	rg, err := parseRange(r)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}
	iv := parseInterval(r, rg)

	points, err := a.store.Series(r.Context(), site.ID, rg, iv)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not compute series")
		return
	}

	auth.WriteJSON(w, http.StatusOK, map[string]any{
		"interval": string(iv),
		// Gaps are filled server-side so a chart does not have to decide whether
		// a missing bucket means zero traffic or missing data. It means zero.
		"points": fillGaps(points, rg, iv),
	})
}

// fillGaps expands a sparse series into one point per bucket across the range.
func fillGaps(points []store.TimePoint, rg store.Range, iv store.Interval) []seriesPoint {
	step := time.Hour
	if iv == store.IntervalDay {
		step = 24 * time.Hour
	}

	byBucket := make(map[int64]store.TimePoint, len(points))
	for _, p := range points {
		byBucket[p.T.UnixMilli()] = p
	}

	// Start at the bucket containing From, using the same integer flooring the
	// SQL layer uses, so client and database agree on bucket boundaries.
	stepMS := step.Milliseconds()
	start := (rg.From.UnixMilli() / stepMS) * stepMS
	end := rg.To.UnixMilli()

	out := make([]seriesPoint, 0, 64)
	for ms := start; ms < end; ms += stepMS {
		if p, ok := byBucket[ms]; ok {
			out = append(out, seriesPoint{T: ms, Pageviews: p.Pageviews, Visitors: p.Visitors})
		} else {
			out = append(out, seriesPoint{T: ms})
		}
	}
	return out
}

func (a *API) handleMetrics(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessRead)
	if site == nil {
		return
	}
	rg, err := parseRange(r)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	metric := r.URL.Query().Get("metric")
	if !store.ValidMetric(metric) {
		auth.WriteError(w, http.StatusBadRequest, "unknown metric")
		return
	}

	rows, err := a.store.TopMetrics(r.Context(), site.ID, rg, metric, parseLimit(r, 20, 500))
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not compute metric")
		return
	}

	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, map[string]any{"value": row.Value, "count": row.Count})
	}
	auth.WriteJSON(w, http.StatusOK, map[string]any{"metric": metric, "rows": out})
}

// handleActive is the realtime number: distinct visitors seen in the last five
// minutes.
func (a *API) handleActive(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessRead)
	if site == nil {
		return
	}
	n, err := a.store.ActiveVisitors(r.Context(), site.ID, time.Now().UTC().Add(-5*time.Minute))
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not count active visitors")
		return
	}
	auth.WriteJSON(w, http.StatusOK, map[string]int64{"active": n})
}

type heatPointView struct {
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
	ViewportW int     `json:"vw"`
	ViewportH int     `json:"vh"`
	Scroll    float64 `json:"scroll,omitempty"`
	DwellMS   int     `json:"dwell_ms,omitempty"`
	Selector  string  `json:"selector,omitempty"`
}

// handleHeatmap returns raw samples for one page, which the dashboard renders as
// a click / scroll / attention overlay.
//
// Samples are returned as coordinates and selectors only — there is no page
// content here, because none is ever collected. A heatmap in Athar shows where
// people clicked, not what they saw or typed.
//
// The dashboard may composite these coordinates over a picture of the page, but
// that picture does not come from here and does not come from a visitor: it is a
// screenshot an operator uploaded, served separately by the page-image routes.
// See backend/internal/api/pageimages.go for the whole argument.
func (a *API) handleHeatmap(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessRead)
	if site == nil {
		return
	}
	rg, err := parseRange(r)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		auth.WriteError(w, http.StatusBadRequest, "path is required")
		return
	}

	kind := store.HeatKind(r.URL.Query().Get("kind"))
	switch kind {
	case store.HeatClick, store.HeatScroll, store.HeatAttn:
	case "":
		kind = store.HeatClick
	default:
		auth.WriteError(w, http.StatusBadRequest, "kind must be click, scroll or attn")
		return
	}

	samples, err := a.store.HeatSamples(r.Context(), site.ID, path, kind, rg, parseLimit(r, 5000, 50000))
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not load heatmap")
		return
	}

	out := make([]heatPointView, 0, len(samples))
	for _, s := range samples {
		out = append(out, heatPointView{
			X: s.XPct, Y: s.YPct,
			ViewportW: s.ViewportW, ViewportH: s.ViewportH,
			Scroll: s.ScrollPct, DwellMS: s.DwellMS, Selector: s.Selector,
		})
	}
	auth.WriteJSON(w, http.StatusOK, map[string]any{
		"path":    path,
		"kind":    string(kind),
		"samples": out,
	})
}

// handleRevenue totals ecommerce revenue per currency.
func (a *API) handleRevenue(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessRead)
	if site == nil {
		return
	}
	rg, err := parseRange(r)
	if err != nil {
		auth.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	totals, err := a.store.RevenueSummary(r.Context(), site.ID, rg)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not compute revenue")
		return
	}

	// Minor units are reported alongside the currency so the client formats
	// rather than divides — dividing by 100 is wrong for JPY and KWD alike.
	out := make([]map[string]any, 0, len(totals))
	for currency, amount := range totals {
		out = append(out, map[string]any{"currency": currency, "amount_minor": amount})
	}
	auth.WriteJSON(w, http.StatusOK, map[string]any{"totals": out})
}
