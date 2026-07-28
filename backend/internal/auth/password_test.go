package auth

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"

	"golang.org/x/crypto/argon2"
)

func TestHashAndVerify(t *testing.T) {
	const password = "correct horse battery staple"

	hash, err := HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$") {
		t.Fatalf("hash is not PHC argon2id: %q", hash)
	}

	ok, rehash, err := VerifyPassword(password, hash)
	if err != nil || !ok {
		t.Fatalf("correct password rejected: ok=%v err=%v", ok, err)
	}
	if rehash {
		t.Error("a hash made with current parameters should not need rehashing")
	}

	ok, _, err = VerifyPassword("wrong password", hash)
	if err != nil || ok {
		t.Fatalf("wrong password accepted: ok=%v err=%v", ok, err)
	}
}

// The same password must never produce the same hash twice: a per-hash random
// salt is what stops one rainbow table from covering every user on the instance.
func TestHashesAreSalted(t *testing.T) {
	a, err := HashPassword("same password")
	if err != nil {
		t.Fatal(err)
	}
	b, err := HashPassword("same password")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("two hashes of the same password are identical — the salt is not random")
	}
}

// Every malformed hash must fail closed. A parser that errored *open* would turn
// a corrupt database column into an authentication bypass.
func TestMalformedHashesFailClosed(t *testing.T) {
	cases := map[string]string{
		"empty":           "",
		"not PHC":         "hunter2",
		"too few fields":  "$argon2id$v=19$m=65536,t=2,p=4$c2FsdA",
		"wrong variant":   "$argon2i$v=19$m=65536,t=2,p=4$c2FsdA$aGFzaA",
		"unknown version": "$argon2id$v=13$m=65536,t=2,p=4$c2FsdA$aGFzaA",
		"zero memory":     "$argon2id$v=19$m=0,t=2,p=4$c2FsdA$aGFzaA",
		"bad base64 salt": "$argon2id$v=19$m=65536,t=2,p=4$!!!!$aGFzaA",
		"bad base64 hash": "$argon2id$v=19$m=65536,t=2,p=4$c2FsdA$!!!!",
		"empty hash":      "$argon2id$v=19$m=65536,t=2,p=4$c2FsdA$",
		"garbage params":  "$argon2id$v=19$nonsense$c2FsdA$aGFzaA",
	}

	for name, hash := range cases {
		t.Run(name, func(t *testing.T) {
			ok, _, err := VerifyPassword("anything", hash)
			if ok {
				t.Fatal("malformed hash verified successfully — this is an auth bypass")
			}
			if !errors.Is(err, ErrInvalidHash) {
				t.Fatalf("got err %v, want ErrInvalidHash", err)
			}
		})
	}
}

// A hash made with weaker parameters must still verify, and must be reported as
// needing an upgrade — otherwise raising the cost floor would lock out every
// existing account instead of transparently upgrading it on next login.
//
// The fixture is derived here rather than pasted in: a hardcoded digest would be
// a value nobody could regenerate or check, and getting one byte wrong would
// silently turn this into a test of the failure path.
func TestWeakParametersVerifyAndRequestRehash(t *testing.T) {
	const password = "athar-test-password"
	salt := []byte("athar-test-salt0")

	// m=8192, t=1, p=1 — below the current floor, but a legitimate older hash.
	const (
		weakMemory  = 8192
		weakTime    = 1
		weakThreads = 1
	)
	key := argon2.IDKey([]byte(password), salt, weakTime, weakMemory, weakThreads, argonKeyLen)
	weak := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, weakMemory, weakTime, weakThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key))

	ok, rehash, err := VerifyPassword(password, weak)
	if err != nil {
		t.Fatalf("weak-parameter hash failed to parse: %v", err)
	}
	if !ok {
		t.Fatal("weak-parameter hash did not verify")
	}
	if !rehash {
		t.Error("a hash below the current cost floor should be flagged for rehashing")
	}
}

// The unknown-user login path hashes this constant so its timing matches a real
// verification. If it stopped parsing, that path would return early and the
// timing difference would enumerate valid usernames.
func TestDummyHashIsWellFormed(t *testing.T) {
	ok, _, err := VerifyPassword("whatever", dummyHash)
	if err != nil {
		t.Fatalf("dummyHash does not parse (%v) — the login timing defence is broken", err)
	}
	if ok {
		t.Fatal("dummyHash matched a password; it must never verify")
	}
}

func TestSubtleCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"abc", "abc", true},
		{"abc", "abd", false},
		{"abc", "ab", false},
		{"", "", true},
		{"", "a", false},
	}
	for _, c := range cases {
		if got := subtleCompare(c.a, c.b); got != c.want {
			t.Errorf("subtleCompare(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
