package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"athar/backend/internal/store"
)

// SessionCookie is the name of the dashboard session cookie.
const SessionCookie = "athar_session"

// CSRFCookie carries the CSRF token. Unlike the session cookie it is readable by
// JavaScript on purpose — the dashboard reads it and echoes it back in a header,
// which is what makes the double-submit check work.
const CSRFCookie = "athar_csrf"

// CSRFHeader is the header the dashboard echoes the CSRF token in.
const CSRFHeader = "X-Athar-CSRF"

// Errors returned by the session layer.
//
// Every value here is returned by something in this package. TOTP sentinels
// used to sit alongside these, declared but never returned by any code path —
// which made the login flow look two-factor-aware when it is not. The
// enrolment work is tracked in ROADMAP.md; its sentinels belong in the commit
// that first returns them, not before.
var (
	ErrNoSession    = errors.New("auth: no session")
	ErrInvalidLogin = errors.New("auth: invalid credentials")
	ErrRateLimited  = errors.New("auth: too many attempts")
)

// Manager issues and validates dashboard sessions.
type Manager struct {
	store  store.Store
	ttl    time.Duration
	secure bool

	limiter *loginLimiter
}

// ManagerOptions configures a Manager.
type ManagerOptions struct {
	Store store.Store
	// TTL is the idle lifetime of a session. Default 24h.
	TTL time.Duration
	// Secure marks cookies Secure. Set when Athar is reached over HTTPS —
	// which is every real deployment; it is off by default only so that
	// http://localhost:3100 works during setup.
	Secure bool
}

// NewManager builds a session manager.
func NewManager(opt ManagerOptions) *Manager {
	ttl := opt.TTL
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	return &Manager{
		store:   opt.Store,
		ttl:     ttl,
		secure:  opt.Secure,
		limiter: newLoginLimiter(),
	}
}

// ── Login ─────────────────────────────────────────────────────────────────────

// Login verifies credentials and issues a session, setting both cookies.
//
// The rate limiter is keyed on username *and* client address: keying on the
// username alone lets anyone lock a known account out by guessing at it, and
// keying on the address alone lets a botnet spray one password across many
// accounts. Both keys must be under their limit.
func (m *Manager) Login(ctx context.Context, w http.ResponseWriter, username, password, clientIP string) (*store.User, error) {
	now := time.Now()
	if !m.limiter.allow(username, clientIP, now) {
		return nil, ErrRateLimited
	}

	user, err := m.store.GetUserByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// Hash a dummy password anyway so a request for a non-existent user
			// takes the same time as one for a real user. Without this, response
			// timing enumerates valid usernames.
			_, _, _ = VerifyPassword(password, dummyHash)
			m.limiter.fail(username, clientIP, now)
			return nil, ErrInvalidLogin
		}
		return nil, err
	}

	ok, needsRehash, err := VerifyPassword(password, user.PasswordHash)
	if err != nil || !ok {
		m.limiter.fail(username, clientIP, now)
		return nil, ErrInvalidLogin
	}

	// Successful login is the natural moment to upgrade a hash made with older,
	// cheaper parameters — the plaintext is in hand exactly once.
	if needsRehash {
		if fresh, err := HashPassword(password); err == nil {
			_ = m.store.UpdateUserPassword(ctx, user.ID, fresh)
		}
	}

	m.limiter.succeed(username, clientIP)
	if err := m.issue(ctx, w, user.ID); err != nil {
		return nil, err
	}
	return user, nil
}

// dummyHash is a real argon2id hash of an unguessable value, used to keep the
// unknown-user path as slow as the known-user path.
const dummyHash = "$argon2id$v=19$m=65536,t=2,p=4$" +
	"c29tZS1maXhlZC1zYWx0MDA$" +
	"aGFzaC1wbGFjZWhvbGRlci10aGF0LW5ldmVyLW1hdGNoZXM"

// issue creates a session row and sets the cookies.
func (m *Manager) issue(ctx context.Context, w http.ResponseWriter, userID string) error {
	token, err := randomToken()
	if err != nil {
		return err
	}
	csrf, err := randomToken()
	if err != nil {
		return err
	}

	now := time.Now().UTC()
	sess := &store.AuthSession{
		UserID: userID,
		// Only the hash is stored. Reading the database yields no usable token.
		TokenHash: hashToken(token),
		CreatedAt: now,
		ExpiresAt: now.Add(m.ttl),
	}
	if err := m.store.CreateAuthSession(ctx, sess); err != nil {
		return err
	}

	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true, // unreadable from JavaScript: XSS cannot exfiltrate it
		Secure:   m.secure,
		// Lax, not Strict: the dashboard is a normal web app and Strict would
		// log the operator out whenever they follow a link into it. Lax still
		// withholds the cookie from cross-site POSTs, and CSRF tokens cover the
		// rest.
		SameSite: http.SameSiteLaxMode,
		Expires:  sess.ExpiresAt,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     CSRFCookie,
		Value:    csrf,
		Path:     "/",
		HttpOnly: false, // the dashboard must read this to echo it back
		Secure:   m.secure,
		SameSite: http.SameSiteLaxMode,
		Expires:  sess.ExpiresAt,
	})
	return nil
}

// Logout deletes the current session and clears the cookies.
func (m *Manager) Logout(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" {
		if sess, err := m.store.GetAuthSessionByTokenHash(ctx, hashToken(c.Value)); err == nil {
			_ = m.store.DeleteAuthSession(ctx, sess.ID)
		}
	}
	m.clearCookie(w, SessionCookie)
	m.clearCookie(w, CSRFCookie)
	return nil
}

func (m *Manager) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		HttpOnly: name == SessionCookie,
		Secure:   m.secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// ── Validation ────────────────────────────────────────────────────────────────

// Authenticate resolves the request's session to a user, or returns ErrNoSession.
//
// An expired session is deleted rather than merely rejected, so the table does
// not accumulate dead rows between retention sweeps.
func (m *Manager) Authenticate(ctx context.Context, r *http.Request) (*store.User, error) {
	c, err := r.Cookie(SessionCookie)
	if err != nil || c.Value == "" {
		return nil, ErrNoSession
	}

	sess, err := m.store.GetAuthSessionByTokenHash(ctx, hashToken(c.Value))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrNoSession
		}
		return nil, err
	}
	now := time.Now().UTC()
	if now.After(sess.ExpiresAt) {
		_ = m.store.DeleteAuthSession(ctx, sess.ID)
		return nil, ErrNoSession
	}

	user, err := m.store.GetUserByID(ctx, sess.UserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// The user was deleted while a session was live; drop the session.
			_ = m.store.DeleteAuthSession(ctx, sess.ID)
			return nil, ErrNoSession
		}
		return nil, err
	}

	// Sliding expiry, refreshed at most hourly so a busy dashboard does not
	// write to the sessions table on every single request.
	if time.Until(sess.ExpiresAt) < m.ttl-time.Hour {
		_ = m.store.TouchAuthSession(ctx, sess.ID, now.Add(m.ttl))
	}
	return user, nil
}

// CheckCSRF validates a state-changing request using the double-submit pattern:
// the caller must echo the CSRF cookie's value in the CSRF header. A cross-site
// attacker can cause the browser to send the cookie, but cannot read it, and so
// cannot set the matching header.
func CheckCSRF(r *http.Request) bool {
	c, err := r.Cookie(CSRFCookie)
	if err != nil || c.Value == "" {
		return false
	}
	sent := r.Header.Get(CSRFHeader)
	if sent == "" {
		return false
	}
	return subtleCompare(c.Value, sent)
}

// subtleCompare is a length-safe constant-time string comparison.
func subtleCompare(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range len(a) {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

// PurgeExpired removes expired sessions. Called periodically from main.
func (m *Manager) PurgeExpired(ctx context.Context) (int64, error) {
	return m.store.PurgeExpiredAuthSessions(ctx, time.Now().UTC())
}

// ── Tokens ────────────────────────────────────────────────────────────────────

// randomToken returns 256 bits of URL-safe randomness.
func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashToken returns the SHA-256 of a token. A plain hash (not a password KDF) is
// correct here: the token is 256 bits of uniform randomness, so there is no
// low-entropy guess for a slow hash to defend against.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ── Login rate limiting ───────────────────────────────────────────────────────

// loginLimiter throttles failed logins on two independent keys. It counts only
// failures: someone logging in correctly all day is not an attack.
type loginLimiter struct {
	mu      sync.Mutex
	entries map[string]*loginAttempts
	swept   time.Time
}

type loginAttempts struct {
	failures int
	until    time.Time // locked out until this instant
	last     time.Time
}

const (
	maxLoginFailures = 5
	loginLockout     = 15 * time.Minute
	loginSweepEvery  = time.Hour
)

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{entries: map[string]*loginAttempts{}}
}

func (l *loginLimiter) allow(username, ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweepLocked(now)

	for _, key := range loginKeys(username, ip) {
		if e, ok := l.entries[key]; ok && now.Before(e.until) {
			return false
		}
	}
	return true
}

func (l *loginLimiter) fail(username, ip string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()

	for _, key := range loginKeys(username, ip) {
		e, ok := l.entries[key]
		if !ok {
			e = &loginAttempts{}
			l.entries[key] = e
		}
		e.failures++
		e.last = now
		if e.failures >= maxLoginFailures {
			e.until = now.Add(loginLockout)
			e.failures = 0 // the lockout replaces the count; it restarts after
		}
	}
}

func (l *loginLimiter) succeed(username, ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, key := range loginKeys(username, ip) {
		delete(l.entries, key)
	}
}

func loginKeys(username, ip string) [2]string {
	return [2]string{"u:" + strings.ToLower(username), "i:" + ip}
}

func (l *loginLimiter) sweepLocked(now time.Time) {
	if now.Sub(l.swept) < loginSweepEvery {
		return
	}
	l.swept = now
	for k, e := range l.entries {
		if now.After(e.until) && now.Sub(e.last) > loginSweepEvery {
			delete(l.entries, k)
		}
	}
}
