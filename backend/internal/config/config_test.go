package config

import (
	"testing"
	"time"
)

// Athar must be runnable with no configuration at all. If this test needs
// updating, the zero-setup self-host path has regressed.
func TestDefaultsAreUsable(t *testing.T) {
	cfg := Default()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("the default configuration does not validate: %v", err)
	}

	if cfg.Host != "127.0.0.1" {
		t.Errorf("Host = %q, want loopback — binding publicly must be opt-in", cfg.Host)
	}
	if cfg.Addr() != "127.0.0.1:3100" {
		t.Errorf("Addr() = %q", cfg.Addr())
	}
	if cfg.Database != "athar.db" {
		t.Errorf("Database = %q, want a local SQLite file", cfg.Database)
	}
	if cfg.SessionWindow.D() != 30*time.Minute {
		t.Errorf("SessionWindow = %v, want 30m", cfg.SessionWindow.D())
	}

	// Three defaults are security properties, not preferences.
	if cfg.TrustProxyHeaders {
		t.Error("TrustProxyHeaders defaults to true — a directly-reachable instance would let visitors forge their country")
	}
	if cfg.RetentionDays != 0 {
		t.Error("RetentionDays defaults to non-zero — data would be deleted without anyone asking")
	}
	if cfg.FrameAncestors != "" {
		t.Error("FrameAncestors defaults to non-empty — cross-origin framing would be allowed by default")
	}
}

func TestDurationParsing(t *testing.T) {
	cfg := Default()
	err := cfg.applyJSON([]byte(`{"session_window":"45m","session_ttl":"72h"}`))
	if err != nil {
		t.Fatalf("applyJSON: %v", err)
	}
	if cfg.SessionWindow.D() != 45*time.Minute {
		t.Errorf("SessionWindow = %v, want 45m", cfg.SessionWindow.D())
	}
	if cfg.SessionTTL.D() != 72*time.Hour {
		t.Errorf("SessionTTL = %v, want 72h", cfg.SessionTTL.D())
	}

	// A bare number is tolerated as seconds.
	cfg = Default()
	if err := cfg.applyJSON([]byte(`{"session_window":600}`)); err != nil {
		t.Fatalf("numeric duration: %v", err)
	}
	if cfg.SessionWindow.D() != 10*time.Minute {
		t.Errorf("numeric SessionWindow = %v, want 10m", cfg.SessionWindow.D())
	}

	if err := Default().applyJSON([]byte(`{"session_window":"forever"}`)); err == nil {
		t.Error("an unparseable duration was accepted")
	}
}

// A typo in a security-relevant key must fail loudly rather than being ignored —
// silently defaulting trust_proxy_headers because someone wrote
// "trust_proxy_header" would be the worst kind of quiet failure.
func TestUnknownKeysAreRejected(t *testing.T) {
	err := Default().applyJSON([]byte(`{"trust_proxy_header": true}`))
	if err == nil {
		t.Fatal("a misspelled config key was silently ignored")
	}
}

func TestValidateNormalisesPaths(t *testing.T) {
	cfg := Default()
	cfg.TrackerPath = "custom.js" // no leading slash
	cfg.CollectPath = "collect"   // no leading slash
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if cfg.TrackerPath != "/custom.js" || cfg.CollectPath != "/collect" {
		t.Fatalf("paths not rooted: %q %q", cfg.TrackerPath, cfg.CollectPath)
	}

	// Both are mounted on the same router, so a collision must be caught at
	// boot rather than producing a confusing duplicate-route panic.
	cfg = Default()
	cfg.TrackerPath = "/same"
	cfg.CollectPath = "/same"
	if err := cfg.Validate(); err == nil {
		t.Error("identical tracker_path and collect_path were accepted")
	}
}

func TestValidateRejectsBadValues(t *testing.T) {
	cases := map[string]func(*Config){
		"empty port":         func(c *Config) { c.Port = "" },
		"non-numeric port":   func(c *Config) { c.Port = "http" },
		"negative retention": func(c *Config) { c.RetentionDays = -1 },
		"missing geoip file": func(c *Config) { c.GeoIPPath = "/nonexistent/athar-test.mmdb" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := Default()
			mutate(cfg)
			if err := cfg.Validate(); err == nil {
				t.Error("invalid configuration was accepted")
			}
		})
	}
}

func TestBoolEnvIgnoresGarbage(t *testing.T) {
	// An unparseable value must leave the setting alone rather than reading as
	// false — an operator who wrote "yes" should not silently lose a setting
	// they believe is on.
	on := true
	t.Setenv("ATHAR_TEST_BOOL", "yes")
	boolEnv("ATHAR_TEST_BOOL", &on)
	if !on {
		t.Error("an unparseable bool silently disabled the setting")
	}

	t.Setenv("ATHAR_TEST_BOOL", "false")
	boolEnv("ATHAR_TEST_BOOL", &on)
	if on {
		t.Error("a valid bool was not applied")
	}
}
