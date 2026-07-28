// Package config loads Athar's runtime configuration.
//
// Athar is meant to be started with no configuration at all: `./athar` on a home
// box should work, storing to ./athar.db and listening on loopback. Every knob
// below therefore has a working default, and the file is optional.
//
// Precedence, lowest to highest: built-in defaults → athar.config.json → ATHAR_*
// environment variables → command-line flags. Environment above file so a
// container can override a baked-in config; flags above everything so an
// operator debugging a box always wins.
package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config is the complete set of runtime settings.
type Config struct {
	// Host is the interface to bind. Default "127.0.0.1" — loopback only.
	//
	// This default is deliberately restrictive even though Athar must receive
	// beacons from the internet to be useful. The intended path to public
	// reachability is a tunnel (cloudflared, ngrok, Ephor) or a reverse
	// proxy, both of which reach loopback. Anyone who genuinely wants to bind
	// 0.0.0.0 can say so; nobody should do it by accident.
	Host string `json:"host,omitempty"`

	// Port to listen on. Default "3100".
	Port string `json:"port,omitempty"`

	// Database is the Store DSN. Empty (default) means SQLite at ./athar.db.
	// A bare path is SQLite; a postgres:// URL is Postgres. Same binary.
	Database string `json:"database,omitempty"`

	// GeoIPPath points at a MaxMind-format .mmdb (DB-IP Lite or GeoLite2).
	// Empty (default) disables geo resolution entirely — Athar does not
	// download one, and never resolves geography over the network.
	GeoIPPath string `json:"geoip_path,omitempty"`

	// TrackerPath is the URL the tracker script is served from. Default
	// "/athar.js". Renaming it is the standard way to survive a blocklist that
	// matches on script filename.
	TrackerPath string `json:"tracker_path,omitempty"`

	// CollectPath is the URL beacons are POSTed to. Default "/api/send".
	CollectPath string `json:"collect_path,omitempty"`

	// SessionWindow is how long a visitor can be idle before their next
	// pageview starts a new session. Default 30m, the industry convention.
	SessionWindow Duration `json:"session_window,omitempty"`

	// SessionTTL is the idle lifetime of a *dashboard login* session (not a
	// visitor session). Default 24h.
	SessionTTL Duration `json:"session_ttl,omitempty"`

	// RetentionDays deletes collected data older than N days. 0 (default)
	// keeps data forever. The sweep runs hourly (and once at boot) and deletes
	// whole visitor sessions, so no orphaned events are left behind.
	RetentionDays int `json:"retention_days,omitempty"`

	// TrustProxyHeaders makes Athar read the client IP from X-Forwarded-For /
	// X-Real-IP instead of the socket peer.
	//
	// Off by default, and that default is a security property: with it on,
	// anyone who can reach Athar directly can forge their apparent country by
	// setting a header. Turn it on only when Athar is genuinely behind a proxy
	// that overwrites those headers.
	TrustProxyHeaders bool `json:"trust_proxy_headers,omitempty"`

	// FrameAncestors controls which origins may embed the dashboard in an
	// iframe. Empty (default) blocks all cross-origin framing. Set to a
	// space-separated origin list (e.g. "https://vulos.org") to allow a host
	// shell to embed Athar.
	FrameAncestors string `json:"frame_ancestors,omitempty"`

	// ServeLanding hosts the marketing site at / and /site/*. Cloud-only:
	// a self-hosted instance should serve the dashboard, not a landing page.
	ServeLanding bool `json:"serve_landing,omitempty"`

	// DisableSignup blocks the first-run admin bootstrap. It has no effect once
	// an admin exists — bootstrap is only ever available on an empty instance.
	DisableSignup bool `json:"disable_signup,omitempty"`
}

// Duration is a time.Duration that unmarshals from a JSON string like "30m".
// Durations in a config file should be readable; an integer nanosecond count is
// not.
type Duration time.Duration

func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		// Tolerate a bare number, interpreted as seconds.
		var n int64
		if err2 := json.Unmarshal(b, &n); err2 == nil {
			*d = Duration(time.Duration(n) * time.Second)
			return nil
		}
		return fmt.Errorf("duration must be a string like \"30m\": %w", err)
	}
	parsed, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", s, err)
	}
	*d = Duration(parsed)
	return nil
}

func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(d).String())
}

// D returns the value as a time.Duration.
func (d Duration) D() time.Duration { return time.Duration(d) }

// ConfigName is the file Load looks for.
const ConfigName = "athar.config.json"

// Default returns a Config with every default applied. Athar must be runnable
// with exactly this and no file.
func Default() *Config {
	return &Config{
		Host:          "127.0.0.1",
		Port:          "3100",
		Database:      "athar.db",
		TrackerPath:   "/athar.js",
		CollectPath:   "/api/send",
		SessionWindow: Duration(30 * time.Minute),
		SessionTTL:    Duration(24 * time.Hour),
	}
}

// Load resolves configuration from file and environment.
//
// Unlike some sibling Vulos apps, a missing config file is not fatal here: an
// analytics collector that refuses to boot without a config is hostile to the
// "just run it on your box" path this project exists for.
func Load() (*Config, error) {
	cfg := Default()

	if data, path := findConfigFile(); data != nil {
		if err := cfg.applyJSON(data); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
	}
	cfg.applyEnv()

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// findConfigFile searches, in order: up from the working directory, then
// ~/.config/athar/, then next to the executable. Returns nil when none exists.
func findConfigFile() ([]byte, string) {
	if cwd, err := os.Getwd(); err == nil {
		for dir := cwd; ; {
			p := filepath.Join(dir, ConfigName)
			if data, err := os.ReadFile(p); err == nil {
				return data, p
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(home, ".config", "athar", ConfigName)
		if data, err := os.ReadFile(p); err == nil {
			return data, p
		}
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), ConfigName)
		if data, err := os.ReadFile(p); err == nil {
			return data, p
		}
	}
	return nil, ""
}

// applyJSON decodes over the defaults. Unknown fields are rejected so a typo in
// a security-relevant key (trust_proxy_headers, frame_ancestors) fails loudly
// instead of being silently ignored.
func (c *Config) applyJSON(data []byte) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(c); err != nil {
		return fmt.Errorf("invalid config: %w", err)
	}
	return nil
}

// applyEnv overlays ATHAR_* environment variables.
func (c *Config) applyEnv() {
	str := func(key string, dst *string) {
		if v, ok := os.LookupEnv(key); ok {
			*dst = v
		}
	}
	str("ATHAR_HOST", &c.Host)
	str("ATHAR_PORT", &c.Port)
	str("ATHAR_DATABASE", &c.Database)
	str("ATHAR_GEOIP_PATH", &c.GeoIPPath)
	str("ATHAR_TRACKER_PATH", &c.TrackerPath)
	str("ATHAR_COLLECT_PATH", &c.CollectPath)
	str("ATHAR_FRAME_ANCESTORS", &c.FrameAncestors)

	if v, ok := os.LookupEnv("ATHAR_RETENTION_DAYS"); ok {
		if n, err := strconv.Atoi(v); err == nil {
			c.RetentionDays = n
		}
	}
	if v, ok := os.LookupEnv("ATHAR_SESSION_WINDOW"); ok {
		if d, err := time.ParseDuration(v); err == nil {
			c.SessionWindow = Duration(d)
		}
	}
	if v, ok := os.LookupEnv("ATHAR_SESSION_TTL"); ok {
		if d, err := time.ParseDuration(v); err == nil {
			c.SessionTTL = Duration(d)
		}
	}
	boolEnv("ATHAR_TRUST_PROXY_HEADERS", &c.TrustProxyHeaders)
	boolEnv("ATHAR_SERVE_LANDING", &c.ServeLanding)
	boolEnv("ATHAR_DISABLE_SIGNUP", &c.DisableSignup)
}

// boolEnv sets dst from an environment variable using Go's bool syntax
// ("1", "true", "TRUE", "0", "false"). An unparseable value is ignored rather
// than silently read as false, so `TRUST_PROXY_HEADERS=yes` does not quietly
// disable a setting the operator believes is on.
func boolEnv(key string, dst *bool) {
	v, ok := os.LookupEnv(key)
	if !ok {
		return
	}
	if b, err := strconv.ParseBool(v); err == nil {
		*dst = b
	}
}

// Validate checks the resolved configuration and normalises path fields.
func (c *Config) Validate() error {
	if c.Port == "" {
		return fmt.Errorf("config: port must not be empty")
	}
	if _, err := strconv.Atoi(c.Port); err != nil {
		return fmt.Errorf("config: port %q is not a number", c.Port)
	}
	if c.Database == "" {
		c.Database = "athar.db"
	}

	// Both paths are mounted on the router, so they must be rooted and must not
	// collide with each other.
	c.TrackerPath = ensureLeadingSlash(c.TrackerPath, "/athar.js")
	c.CollectPath = ensureLeadingSlash(c.CollectPath, "/api/send")
	if c.TrackerPath == c.CollectPath {
		return fmt.Errorf("config: tracker_path and collect_path must differ (both are %q)", c.TrackerPath)
	}

	if c.SessionWindow <= 0 {
		c.SessionWindow = Duration(30 * time.Minute)
	}
	if c.SessionTTL <= 0 {
		c.SessionTTL = Duration(24 * time.Hour)
	}
	if c.RetentionDays < 0 {
		return fmt.Errorf("config: retention_days must not be negative")
	}
	if c.GeoIPPath != "" {
		if _, err := os.Stat(c.GeoIPPath); err != nil {
			// Fail at boot rather than silently collecting geo-less data for a
			// month before anyone notices the country column is empty.
			return fmt.Errorf("config: geoip_path %q is not readable: %w", c.GeoIPPath, err)
		}
	}
	return nil
}

func ensureLeadingSlash(p, fallback string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return fallback
	}
	if !strings.HasPrefix(p, "/") {
		return "/" + p
	}
	return p
}

// Addr returns the host:port to listen on.
func (c *Config) Addr() string { return c.Host + ":" + c.Port }
