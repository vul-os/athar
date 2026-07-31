// Command athar is the Athar analytics server: collector, dashboard and API in
// one static binary.
//
// It is designed to be started with no arguments on a machine someone owns:
//
//	./athar
//
// which listens on 127.0.0.1:3100, stores to ./athar.db, and serves the
// dashboard. Everything else is optional.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"athar/backend/internal/api"
	"athar/backend/internal/auth"
	"athar/backend/internal/config"
	"athar/backend/internal/geoip"
	"athar/backend/internal/ingest"
	"athar/backend/internal/store"
	"athar/backend/internal/tracker"
)

// Version is injected at build time via -ldflags "-X main.Version=vX.Y.Z".
var Version = "dev"

func main() {
	if err := run(); err != nil {
		log.Fatalf("athar: %v", err)
	}
}

func run() error {
	var (
		portFlag    = flag.String("port", "", "port to listen on (overrides config)")
		hostFlag    = flag.String("host", "", "interface to bind (overrides config)")
		dbFlag      = flag.String("db", "", "database DSN: a path for SQLite, or postgres://… (overrides config)")
		geoFlag     = flag.String("geoip", "", "path to a MaxMind .mmdb file (overrides config)")
		secureFlag  = flag.Bool("secure-cookies", false, "mark session cookies Secure (set this behind HTTPS)")
		versionFlag = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *versionFlag {
		fmt.Println("athar", Version)
		return nil
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	// Flags win over file and environment: an operator debugging a box should
	// not have to fight their own config file.
	if *portFlag != "" {
		cfg.Port = *portFlag
	}
	if *hostFlag != "" {
		cfg.Host = *hostFlag
	}
	if *dbFlag != "" {
		cfg.Database = *dbFlag
	}
	if *geoFlag != "" {
		cfg.GeoIPPath = *geoFlag
	}
	if err := cfg.Validate(); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// ── Storage ───────────────────────────────────────────────────────────
	st, err := store.Open(ctx, cfg.Database)
	if err != nil {
		return err
	}
	defer st.Close()

	if err := st.Migrate(ctx); err != nil {
		return err
	}
	log.Printf("athar %s — store: %s", Version, st.Dialect())

	// ── GeoIP ─────────────────────────────────────────────────────────────
	geo, err := geoip.New(cfg.GeoIPPath)
	if err != nil {
		return err
	}
	defer geo.Close()

	if geo.Enabled() {
		log.Printf("geoip: resolving locally from %s", cfg.GeoIPPath)
	} else {
		log.Printf("geoip: disabled (no database configured) — country/region/city will be empty")
	}

	// ── Ingest ────────────────────────────────────────────────────────────
	ident, err := ingest.NewIdentifier(ctx, st)
	if err != nil {
		return err
	}
	collector := ingest.New(ingest.Options{
		Store:         st,
		GeoIP:         geo,
		Identifier:    ident,
		SessionWindow: cfg.SessionWindow.D(),
		TrustProxy:    cfg.TrustProxyHeaders,
	})
	if cfg.TrustProxyHeaders {
		log.Printf("proxy headers: TRUSTED — only correct if Athar is behind a proxy that overwrites X-Forwarded-For")
	}

	// ── HTTP ──────────────────────────────────────────────────────────────
	sessions := auth.NewManager(auth.ManagerOptions{
		Store:  st,
		TTL:    cfg.SessionTTL.D(),
		Secure: *secureFlag,
	})

	trackerHandler, err := tracker.New()
	if err != nil {
		return err
	}
	raw, gz := trackerHandler.Size()
	log.Printf("tracker: %s (%d B, %d B gzipped)", cfg.TrackerPath, raw, gz)

	mux := http.NewServeMux()

	// Collector and tracker script. Both paths are configurable, because the
	// default names are the first thing a content blocker matches on.
	mux.Handle("GET "+cfg.TrackerPath, trackerHandler)
	mux.Handle("HEAD "+cfg.TrackerPath, trackerHandler)
	mux.HandleFunc(cfg.CollectPath, collector.Handler())

	api.New(api.Options{
		Store:     st,
		Sessions:  sessions,
		Collector: collector,
		Config:    cfg,
		Version:   Version,
	}).Register(mux)

	// Marketing site (cloud-only) and the dashboard SPA.
	if cfg.ServeLanding {
		if site := newSiteHandler(); site != nil {
			mux.Handle("/site/", http.StripPrefix("/site", site))
		}
	}
	mux.Handle("/", newFrontendHandler())

	srv := &http.Server{
		Addr:    cfg.Addr(),
		Handler: securityHeaders(cfg, mux),
		// An ingest endpoint is exposed to the open internet, so every phase of
		// a request is bounded. Without these, a slowloris client can hold
		// connections open indefinitely at negligible cost to itself.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go backgroundTasks(ctx, st, sessions, cfg)

	errCh := make(chan error, 1)
	go func() {
		log.Printf("listening on http://%s", cfg.Addr())
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Printf("shutting down…")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

// backgroundTasks runs the periodic housekeeping: expired login sessions, and
// data retention when it is configured.
func backgroundTasks(ctx context.Context, st store.Store, sessions *auth.Manager, cfg *config.Config) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()

	runOnce := func() {
		if n, err := sessions.PurgeExpired(ctx); err != nil {
			log.Printf("session purge: %v", err)
		} else if n > 0 {
			log.Printf("session purge: removed %d expired sessions", n)
		}
		if cfg.RetentionDays > 0 {
			applyRetention(ctx, st, cfg.RetentionDays)
		}
	}

	runOnce()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runOnce()
		}
	}
}

// applyRetention deletes data older than the configured window, per website.
//
// It deletes whole visitor sessions and lets the schema's cascades take the
// events, heatmap samples and revenue rows with them — a retention pass that
// deleted events directly would leave sessions behind and skew every subsequent
// bounce-rate calculation.
func applyRetention(ctx context.Context, st store.Store, days int) {
	cutoff := time.Now().UTC().AddDate(0, 0, -days)

	// Retention is instance-wide, so it runs over every website. Listing as an
	// admin is correct here: this is the server's own maintenance, not a user
	// request.
	sites, err := st.ListWebsitesForUser(ctx, "", true)
	if err != nil {
		log.Printf("retention: could not list websites: %v", err)
		return
	}
	var total int64
	for _, site := range sites {
		n, err := st.PurgeBefore(ctx, site.ID, cutoff)
		if err != nil {
			log.Printf("retention: %s: %v", site.Domain, err)
			continue
		}
		total += n
	}
	if total > 0 {
		log.Printf("retention: removed %d sessions older than %d days", total, days)
	}
}

// securityHeaders sets the response headers that apply to every route.
func securityHeaders(cfg *config.Config, next http.Handler) http.Handler {
	// The dashboard is hand-written HTML/CSS/JS with no inline script and no
	// inline style — ui.css is a plain external stylesheet and app.js an
	// external ES module — so the CSP needs no 'unsafe-inline' anywhere,
	// tighter than the Tailwind-era policy this replaced.
	csp := []string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' data:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"base-uri 'self'",
		"form-action 'self'",
	}
	if cfg.FrameAncestors != "" {
		csp = append(csp, "frame-ancestors "+cfg.FrameAncestors)
	} else {
		csp = append(csp, "frame-ancestors 'self'")
	}
	policy := strings.Join(csp, "; ")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The tracker script and collector are cross-origin by design and set
		// their own headers; a frame-ancestors policy on them is meaningless
		// and a restrictive CSP would be misleading.
		if r.URL.Path == cfg.TrackerPath || r.URL.Path == cfg.CollectPath {
			next.ServeHTTP(w, r)
			return
		}

		h := w.Header()
		h.Set("Content-Security-Policy", policy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if cfg.FrameAncestors == "" {
			h.Set("X-Frame-Options", "DENY")
		}
		next.ServeHTTP(w, r)
	})
}
