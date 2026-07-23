// Package auth provides dashboard authentication: password hashing, server-side
// sessions, CSRF protection, and role checks.
//
// The stance throughout is fail-closed. A request with no valid session is
// rejected, an unparseable password hash is a verification failure rather than a
// pass, and a state-changing request without a matching CSRF token is refused.
// Where a choice exists between "reject and possibly inconvenience an operator"
// and "allow and possibly admit an attacker", this package rejects.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"runtime"
	"strings"

	"golang.org/x/crypto/argon2"
)

// argon2id parameters.
//
// These follow the OWASP Password Storage Cheat Sheet's argon2id recommendation
// (19 MiB memory, 2 iterations, 1 degree of parallelism) as the floor, with
// memory raised to 64 MiB — Athar authenticates humans at a login form a handful
// of times a day, so the cost of a slower hash is invisible to users and
// significant to anyone brute-forcing a stolen database.
//
// The parameters are stored in every hash, so raising them later does not
// invalidate existing passwords: old hashes keep verifying with the values they
// were made with, and are upgraded on the next successful login.
const (
	argonTime    = 2
	argonMemory  = 64 * 1024 // KiB
	argonKeyLen  = 32
	argonSaltLen = 16
)

// argonThreads is the parallelism degree. Capped at 4 so a hash made on a
// 64-core server still verifies at a sensible cost on a Raspberry Pi — the same
// database must work on both.
func argonThreads() uint8 {
	n := runtime.NumCPU()
	if n > 4 {
		n = 4
	}
	if n < 1 {
		n = 1
	}
	return uint8(n)
}

// ErrInvalidHash is returned when a stored hash cannot be parsed. Callers must
// treat it as a failed verification, never as a reason to skip the check.
var ErrInvalidHash = errors.New("auth: malformed password hash")

// HashPassword returns a PHC-format argon2id string:
//
//	$argon2id$v=19$m=65536,t=2,p=4$<salt>$<hash>
//
// The format carries its own parameters, which is what makes them upgradable.
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: read salt: %w", err)
	}
	threads := argonThreads()
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, threads, argonKeyLen)

	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, threads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks a password against a stored PHC hash.
//
// It reports whether the password matches and whether the hash should be
// rehashed because it was made with weaker parameters than the current ones.
// A malformed hash returns (false, false, ErrInvalidHash) — never (true, …).
func VerifyPassword(password, encoded string) (ok bool, needsRehash bool, err error) {
	params, salt, want, err := decodeHash(encoded)
	if err != nil {
		return false, false, err
	}

	got := argon2.IDKey([]byte(password), salt, params.time, params.memory, params.threads, uint32(len(want)))
	// Constant-time compare: a byte-by-byte comparison leaks how much of the
	// hash matched, which is enough to attack it offline given an oracle.
	if subtle.ConstantTimeCompare(got, want) != 1 {
		return false, false, nil
	}

	needsRehash = params.memory < argonMemory || params.time < argonTime
	return true, needsRehash, nil
}

type argonParams struct {
	memory  uint32
	time    uint32
	threads uint8
}

// decodeHash parses a PHC argon2id string.
func decodeHash(encoded string) (argonParams, []byte, []byte, error) {
	var p argonParams

	parts := strings.Split(encoded, "$")
	// "", "argon2id", "v=19", "m=…,t=…,p=…", salt, hash
	if len(parts) != 6 || parts[0] != "" {
		return p, nil, nil, ErrInvalidHash
	}
	if parts[1] != "argon2id" {
		// argon2i and argon2d are deliberately not accepted: silently verifying
		// a weaker variant would let an attacker who can write the hash column
		// downgrade the algorithm.
		return p, nil, nil, fmt.Errorf("%w: unsupported variant %q", ErrInvalidHash, parts[1])
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return p, nil, nil, ErrInvalidHash
	}
	if version != argon2.Version {
		return p, nil, nil, fmt.Errorf("%w: unsupported version %d", ErrInvalidHash, version)
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.memory, &p.time, &p.threads); err != nil {
		return p, nil, nil, ErrInvalidHash
	}
	if p.memory == 0 || p.time == 0 || p.threads == 0 {
		return p, nil, nil, fmt.Errorf("%w: zero cost parameter", ErrInvalidHash)
	}

	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	if err != nil {
		return p, nil, nil, ErrInvalidHash
	}
	hash, err := base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if err != nil || len(hash) == 0 {
		return p, nil, nil, ErrInvalidHash
	}
	return p, salt, hash, nil
}
