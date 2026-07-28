package store

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// migration is one ordered DDL step. Version numbers are dense and must never be
// reused or reordered once released: applied versions are recorded in
// athar_migrations and skipped on subsequent boots.
type migration struct {
	Version int
	Name    string
	SQL     string
}

// migrate applies every unapplied migration, one transaction per step. A failed
// step rolls back cleanly, so a half-applied migration is not a state the
// process can end up in.
func (s *sqlStore) migrate(ctx context.Context) error {
	// The ledger is created outside the versioned set (chicken and egg).
	const ledger = `CREATE TABLE IF NOT EXISTS athar_migrations (
		version    INTEGER NOT NULL PRIMARY KEY,
		name       TEXT    NOT NULL,
		applied_at BIGINT  NOT NULL
	)`
	if _, err := s.db.ExecContext(ctx, ledger); err != nil {
		return fmt.Errorf("store: create migration ledger: %w", err)
	}

	applied, err := s.appliedVersions(ctx)
	if err != nil {
		return err
	}

	for _, m := range migrations {
		if applied[m.Version] {
			continue
		}
		if err := s.applyMigration(ctx, m); err != nil {
			return err
		}
	}
	return nil
}

func (s *sqlStore) appliedVersions(ctx context.Context) (map[int]bool, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT version FROM athar_migrations`)
	if err != nil {
		return nil, fmt.Errorf("store: read migration ledger: %w", err)
	}
	defer rows.Close()

	applied := map[int]bool{}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("store: scan migration ledger: %w", err)
		}
		applied[v] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: iterate migration ledger: %w", err)
	}
	return applied, nil
}

func (s *sqlStore) applyMigration(ctx context.Context, m migration) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin migration %d: %w", m.Version, err)
	}
	defer func() { _ = tx.Rollback() }() // no-op after a successful Commit

	for _, stmt := range splitStatements(m.SQL) {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("store: migration %d (%s): %w\nstatement: %s", m.Version, m.Name, err, stmt)
		}
	}
	ins := s.dialect.Rebind(`INSERT INTO athar_migrations (version, name, applied_at) VALUES (?, ?, ?)`)
	if _, err := tx.ExecContext(ctx, ins, m.Version, m.Name, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("store: record migration %d: %w", m.Version, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit migration %d: %w", m.Version, err)
	}
	return nil
}

// splitStatements breaks a migration body into individual statements on `;`,
// ignoring semicolons that appear inside `--` line comments or single-quoted
// string literals. Both occur in the schema — the comments explain the design,
// and DEFAULT ” appears on most columns — so a plain strings.Split would cut
// statements in half.
//
// This is a lexer, not a parser: it only needs to know where a statement ends,
// which keeps the migration runner dependency-free.
func splitStatements(body string) []string {
	var out []string
	var cur strings.Builder

	flush := func() {
		if stmt := strings.TrimSpace(cur.String()); stmt != "" {
			out = append(out, stmt)
		}
		cur.Reset()
	}

	inString, inComment := false, false
	for i := 0; i < len(body); i++ {
		c := body[i]
		switch {
		case inComment:
			if c == '\n' {
				inComment = false
				cur.WriteByte(c)
			}
			// Comment bodies are dropped, so their semicolons never split.
		case inString:
			cur.WriteByte(c)
			if c == '\'' {
				if i+1 < len(body) && body[i+1] == '\'' { // '' escape
					cur.WriteByte('\'')
					i++
					continue
				}
				inString = false
			}
		case c == '-' && i+1 < len(body) && body[i+1] == '-':
			inComment = true
			i++
		case c == '\'':
			inString = true
			cur.WriteByte(c)
		case c == ';':
			flush()
		default:
			cur.WriteByte(c)
		}
	}
	flush()
	return out
}
