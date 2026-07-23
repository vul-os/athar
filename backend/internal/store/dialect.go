package store

import (
	"fmt"
	"strconv"
	"strings"
)

// Dialect captures the only things that genuinely differ between the engines
// Athar supports: how placeholders are spelled, and which driver to open.
// Everything else — every query in sql.go, and the whole schema in
// migrations.go — is written once in the subset of SQL both engines accept.
//
// Keeping this surface tiny is the point. If a Dialect ever needs a method like
// "rewrite this SELECT", the query has drifted out of the portable subset and
// should be rewritten instead of accommodated here.
type Dialect interface {
	// Name is the engine identifier ("sqlite" or "postgres").
	Name() string
	// Driver is the database/sql driver name to open with.
	Driver() string
	// Rebind converts `?` placeholders to the engine's own style.
	Rebind(query string) string
	// TimeBucket returns a SQL expression flooring an epoch-millis column to the
	// start of its hour or day, as epoch millis.
	TimeBucket(col string, iv Interval) string
}

// bucketMillis is the width of one time-series bucket.
func bucketMillis(iv Interval) int64 {
	if iv == IntervalDay {
		return 86_400_000
	}
	return 3_600_000
}

// rebindDollar rewrites `?` placeholders to $1, $2, … for Postgres. It skips
// question marks inside single-quoted string literals; Athar's queries never
// contain one, but a rebinder that silently corrupts literals is a nasty trap
// to leave for whoever writes the next query.
func rebindDollar(query string) string {
	var b strings.Builder
	b.Grow(len(query) + 16)
	n := 0
	inString := false
	for i := 0; i < len(query); i++ {
		c := query[i]
		switch {
		case c == '\'':
			// '' inside a string is an escaped quote, not a terminator.
			if inString && i+1 < len(query) && query[i+1] == '\'' {
				b.WriteString("''")
				i++
				continue
			}
			inString = !inString
			b.WriteByte(c)
		case c == '?' && !inString:
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// ── SQLite ────────────────────────────────────────────────────────────────────

type sqliteDialect struct{}

func (sqliteDialect) Name() string   { return "sqlite" }
func (sqliteDialect) Driver() string { return "sqlite" }

// Rebind is the identity: queries are already written in `?` style.
func (sqliteDialect) Rebind(q string) string { return q }

// TimeBucket floors an epoch-millis column with integer division. SQLite does
// have date functions, but they operate on text/julian values — arithmetic on
// the stored integer is faster and exactly equivalent.
func (sqliteDialect) TimeBucket(col string, iv Interval) string {
	ms := bucketMillis(iv)
	return fmt.Sprintf("((%s / %d) * %d)", col, ms, ms)
}

// ── Postgres ──────────────────────────────────────────────────────────────────

type postgresDialect struct{}

func (postgresDialect) Name() string   { return "postgres" }
func (postgresDialect) Driver() string { return "pgx" }

func (postgresDialect) Rebind(q string) string { return rebindDollar(q) }

// TimeBucket uses the same integer arithmetic as SQLite rather than
// date_trunc(). Identical arithmetic on both engines means a series query can
// never disagree about which bucket a borderline event lands in.
func (postgresDialect) TimeBucket(col string, iv Interval) string {
	ms := bucketMillis(iv)
	return fmt.Sprintf("((%s / %d) * %d)", col, ms, ms)
}
