// Package geoip resolves an IP address to a coarse location, in-process.
//
// The whole point is that this never touches the network. Athar reads a
// MaxMind-format .mmdb file (DB-IP Lite or GeoLite2, both freely
// redistributable) with a memory-mapped pure-Go reader, resolves the country /
// region / city at ingest, and stores only that. The raw IP is never persisted
// and never leaves the process — the alternative used by hosted analytics is a
// lookup API call, which is exactly the "your visitors' data goes somewhere
// else" property Athar exists to avoid.
//
// No database is bundled: the files are large (tens of MB) and carry their own
// licence and attribution requirements. When no path is configured, Athar
// collects everything else and simply leaves the location fields empty.
package geoip

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"

	"github.com/oschwald/maxminddb-golang"
)

// Location is a coarse, non-identifying place. Nothing finer than a city is
// resolved or stored — an analytics dashboard has no use for a lat/long, and
// storing one would turn aggregate data into a movement log.
type Location struct {
	Country string // ISO 3166-1 alpha-2, e.g. "KE"
	Region  string // first-level subdivision name
	City    string
}

// Resolver looks up locations. The zero value is usable and always returns an
// empty Location, so every caller can treat "no database configured" as the
// normal case rather than a special one.
type Resolver struct {
	mu sync.RWMutex
	db *maxminddb.Reader
}

// New opens a .mmdb file. An empty path returns a working no-op Resolver.
func New(path string) (*Resolver, error) {
	if strings.TrimSpace(path) == "" {
		return &Resolver{}, nil
	}
	db, err := maxminddb.Open(path)
	if err != nil {
		return nil, fmt.Errorf("geoip: open %s: %w", path, err)
	}
	return &Resolver{db: db}, nil
}

// Enabled reports whether a database is loaded.
func (r *Resolver) Enabled() bool {
	if r == nil {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.db != nil
}

// Close releases the database.
func (r *Resolver) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.db == nil {
		return nil
	}
	err := r.db.Close()
	r.db = nil
	return err
}

// mmdbRecord is the subset of the MaxMind City schema Athar reads. Declaring
// only these fields means the decoder skips everything else — including the
// coordinates, which are deliberately not read.
type mmdbRecord struct {
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
	City struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"city"`
	Subdivisions []struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"subdivisions"`
}

// Lookup resolves an IP. It returns a zero Location — never an error — when no
// database is loaded, the address is unparseable, or the address is private:
// ingest must not fail because geography could not be determined.
func (r *Resolver) Lookup(ip string) Location {
	if r == nil {
		return Location{}
	}
	r.mu.RLock()
	db := r.db
	r.mu.RUnlock()
	if db == nil {
		return Location{}
	}

	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		return Location{}
	}
	// A private or loopback address has no meaningful public location, and
	// looking one up wastes a lookup on every request during local development.
	if addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() || addr.IsUnspecified() {
		return Location{}
	}

	var rec mmdbRecord
	if err := db.Lookup(net.IP(addr.AsSlice()), &rec); err != nil {
		return Location{}
	}

	loc := Location{Country: rec.Country.ISOCode}
	loc.City = englishName(rec.City.Names)
	if len(rec.Subdivisions) > 0 {
		loc.Region = englishName(rec.Subdivisions[0].Names)
	}
	return loc
}

// englishName picks the English label, falling back to any available name so a
// database shipped without English localisation still yields something useful.
func englishName(names map[string]string) string {
	if len(names) == 0 {
		return ""
	}
	if n, ok := names["en"]; ok {
		return n
	}
	for _, n := range names {
		return n
	}
	return ""
}

// ClientIP extracts the caller's address from a request.
//
// trustProxy must reflect the actual deployment. When false, only the socket
// peer is used: a client can set X-Forwarded-For to anything it likes, so
// trusting it on a directly-reachable instance lets any visitor choose their own
// country. When true, the *leftmost* entry is taken — that is the original
// client in a correctly-configured proxy chain that overwrites the header.
func ClientIP(req *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
			if first, _, ok := strings.Cut(xff, ","); ok {
				return strings.TrimSpace(first)
			}
			return strings.TrimSpace(xff)
		}
		if xr := req.Header.Get("X-Real-IP"); xr != "" {
			return strings.TrimSpace(xr)
		}
	}
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		return req.RemoteAddr
	}
	return host
}
