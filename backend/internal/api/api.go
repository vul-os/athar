// Package api serves Athar's dashboard REST API.
//
// Route groups, and what guards each:
//
//	/api/auth/*      public, rate-limited (login, first-run bootstrap)
//	/api/*           session cookie + CSRF on state-changing methods
//	/api/share/*     public, but only for a website with a minted share id
//
// The share group is the one that needs care: it serves real analytics with no
// login, so every handler in it resolves the website *from the share id* and
// never from a caller-supplied website id.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"athar/backend/internal/auth"
	"athar/backend/internal/config"
	"athar/backend/internal/geoip"
	"athar/backend/internal/ingest"
	"athar/backend/internal/store"
)

// API holds the dependencies every handler needs.
type API struct {
	store     store.Store
	sessions  *auth.Manager
	collector *ingest.Collector
	cfg       *config.Config
	version   string
}

// Options configures an API.
type Options struct {
	Store     store.Store
	Sessions  *auth.Manager
	Collector *ingest.Collector
	Config    *config.Config
	Version   string
}

// New builds an API.
func New(opt Options) *API {
	return &API{
		store:     opt.Store,
		sessions:  opt.Sessions,
		collector: opt.Collector,
		cfg:       opt.Config,
		version:   opt.Version,
	}
}

// Register mounts every API route on mux.
func (a *API) Register(mux *http.ServeMux) {
	// ── Public ────────────────────────────────────────────────────────────
	mux.HandleFunc("GET /api/health", a.handleHealth)
	mux.HandleFunc("POST /api/auth/login", a.handleLogin)
	mux.HandleFunc("GET /api/auth/status", a.handleAuthStatus)
	mux.HandleFunc("POST /api/auth/bootstrap", a.handleBootstrap)

	// Public share links. Read-only, and scoped by an unguessable share id.
	mux.HandleFunc("GET /api/share/{shareID}", a.handleShareSite)
	mux.HandleFunc("GET /api/share/{shareID}/stats", a.handleShareStats)

	// ── Authenticated ─────────────────────────────────────────────────────
	protected := http.NewServeMux()

	protected.HandleFunc("POST /api/auth/logout", a.handleLogout)
	protected.HandleFunc("GET /api/me", a.handleMe)
	protected.HandleFunc("POST /api/me/password", a.handleChangePassword)

	protected.HandleFunc("GET /api/websites", a.handleListWebsites)
	protected.HandleFunc("POST /api/websites", a.handleCreateWebsite)
	protected.HandleFunc("GET /api/websites/{id}", a.handleGetWebsite)
	protected.HandleFunc("PATCH /api/websites/{id}", a.handleUpdateWebsite)
	protected.HandleFunc("DELETE /api/websites/{id}", a.handleDeleteWebsite)
	protected.HandleFunc("POST /api/websites/{id}/share", a.handleSetShare)

	protected.HandleFunc("GET /api/websites/{id}/stats", a.handleStats)
	protected.HandleFunc("GET /api/websites/{id}/series", a.handleSeries)
	protected.HandleFunc("GET /api/websites/{id}/metrics", a.handleMetrics)
	protected.HandleFunc("GET /api/websites/{id}/active", a.handleActive)
	protected.HandleFunc("GET /api/websites/{id}/heatmap", a.handleHeatmap)
	protected.HandleFunc("GET /api/websites/{id}/revenue", a.handleRevenue)

	// Instance administration.
	admin := http.NewServeMux()
	admin.HandleFunc("GET /api/users", a.handleListUsers)
	admin.HandleFunc("POST /api/users", a.handleCreateUser)
	admin.HandleFunc("DELETE /api/users/{id}", a.handleDeleteUser)
	protected.Handle("/api/users", auth.RequireAdmin(admin))
	protected.Handle("/api/users/{id}", auth.RequireAdmin(admin))

	// Everything not matched by a public route above falls through to the
	// authenticated mux. Mounting it on the /api/ prefix means a route added to
	// `protected` is authenticated by construction.
	mux.Handle("/api/", a.sessions.Middleware(protected))
}

// ── Health & auth ─────────────────────────────────────────────────────────────

func (a *API) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := a.store.Ping(r.Context()); err != nil {
		auth.WriteJSON(w, http.StatusServiceUnavailable, map[string]any{
			"ok": false, "error": "database unreachable",
		})
		return
	}
	auth.WriteJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"version": a.version,
		"store":   a.store.Dialect(),
	})
}

// handleAuthStatus tells the dashboard whether to show a login form or a
// first-run setup form. It reports only whether *any* user exists — never a
// username, and never whether a specific one does.
func (a *API) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	n, err := a.store.CountUsers(r.Context())
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not read users")
		return
	}
	user, _ := a.sessions.Authenticate(r.Context(), r)

	auth.WriteJSON(w, http.StatusOK, map[string]any{
		"needs_setup":    n == 0 && !a.cfg.DisableSignup,
		"authenticated":  user != nil,
		"signup_blocked": a.cfg.DisableSignup,
	})
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (a *API) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	user, err := a.sessions.Login(r.Context(), w, req.Username, req.Password, geoip.ClientIP(r, a.cfg.TrustProxyHeaders))
	switch {
	case errors.Is(err, auth.ErrRateLimited):
		auth.WriteError(w, http.StatusTooManyRequests, "too many attempts — try again later")
		return
	case errors.Is(err, auth.ErrInvalidLogin):
		// One message for both "no such user" and "wrong password": telling
		// them apart is a username oracle.
		auth.WriteError(w, http.StatusUnauthorized, "invalid username or password")
		return
	case err != nil:
		auth.WriteError(w, http.StatusInternalServerError, "login failed")
		return
	}
	auth.WriteJSON(w, http.StatusOK, publicUser(user))
}

func (a *API) handleLogout(w http.ResponseWriter, r *http.Request) {
	_ = a.sessions.Logout(r.Context(), w, r)
	auth.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleBootstrap creates the first admin on an empty instance.
//
// It is only reachable while zero users exist, so it cannot be used to add an
// account later — the check is inside the handler, on the live count, not on a
// flag decided at boot.
func (a *API) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if a.cfg.DisableSignup {
		auth.WriteError(w, http.StatusForbidden, "signup is disabled")
		return
	}
	n, err := a.store.CountUsers(r.Context())
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not read users")
		return
	}
	if n > 0 {
		auth.WriteError(w, http.StatusForbidden, "this instance already has an account")
		return
	}

	var req loginRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := validateCredentials(req.Username, req.Password); err != nil {
		auth.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not hash password")
		return
	}
	user := &store.User{Username: req.Username, PasswordHash: hash, Role: store.RoleAdmin}
	if err := a.store.CreateUser(r.Context(), user); err != nil {
		if errors.Is(err, store.ErrConflict) {
			auth.WriteError(w, http.StatusConflict, "username already taken")
			return
		}
		auth.WriteError(w, http.StatusInternalServerError, "could not create account")
		return
	}

	if _, err := a.sessions.Login(r.Context(), w, req.Username, req.Password, geoip.ClientIP(r, a.cfg.TrustProxyHeaders)); err != nil {
		// The account exists; the operator can simply log in.
		auth.WriteJSON(w, http.StatusCreated, publicUser(user))
		return
	}
	auth.WriteJSON(w, http.StatusCreated, publicUser(user))
}

// validateCredentials enforces the minimum a password must clear.
//
// The floor is length, not composition. Character-class rules push people toward
// "Passw0rd!" and are worth less than eight more characters of anything.
func validateCredentials(username, password string) error {
	username = strings.TrimSpace(username)
	if len(username) < 2 || len(username) > 64 {
		return errors.New("username must be 2–64 characters")
	}
	if strings.ContainsAny(username, " \t\n\r") {
		return errors.New("username must not contain whitespace")
	}
	if len(password) < 12 {
		return errors.New("password must be at least 12 characters")
	}
	if len(password) > 512 {
		// Bounded so a huge input cannot turn argon2 into a CPU exhaustion vector.
		return errors.New("password must be at most 512 characters")
	}
	return nil
}

func (a *API) handleMe(w http.ResponseWriter, r *http.Request) {
	auth.WriteJSON(w, http.StatusOK, publicUser(auth.UserFrom(r)))
}

type changePasswordRequest struct {
	Current string `json:"current"`
	New     string `json:"new"`
}

func (a *API) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFrom(r)
	var req changePasswordRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	ok, _, err := auth.VerifyPassword(req.Current, user.PasswordHash)
	if err != nil || !ok {
		auth.WriteError(w, http.StatusUnauthorized, "current password is incorrect")
		return
	}
	if err := validateCredentials(user.Username, req.New); err != nil {
		auth.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	hash, err := auth.HashPassword(req.New)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not hash password")
		return
	}
	if err := a.store.UpdateUserPassword(r.Context(), user.ID, hash); err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not update password")
		return
	}
	// Changing a password must invalidate every other session — otherwise a
	// password change does not actually evict whoever prompted it.
	_ = a.store.DeleteAuthSessionsForUser(r.Context(), user.ID)
	auth.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ── Users (admin) ─────────────────────────────────────────────────────────────

func (a *API) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := a.store.ListUsers(r.Context())
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not list users")
		return
	}
	out := make([]map[string]any, 0, len(users))
	for i := range users {
		out = append(out, publicUser(&users[i]))
	}
	auth.WriteJSON(w, http.StatusOK, out)
}

type createUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

func (a *API) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req createUserRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := validateCredentials(req.Username, req.Password); err != nil {
		auth.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	role := store.RoleUser
	if req.Role == string(store.RoleAdmin) {
		role = store.RoleAdmin
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not hash password")
		return
	}

	user := &store.User{Username: strings.TrimSpace(req.Username), PasswordHash: hash, Role: role}
	if err := a.store.CreateUser(r.Context(), user); err != nil {
		if errors.Is(err, store.ErrConflict) {
			auth.WriteError(w, http.StatusConflict, "username already taken")
			return
		}
		auth.WriteError(w, http.StatusInternalServerError, "could not create user")
		return
	}
	auth.WriteJSON(w, http.StatusCreated, publicUser(user))
}

func (a *API) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if me := auth.UserFrom(r); me != nil && me.ID == id {
		// Deleting yourself would leave an instance with no admin and no way to
		// make one, since bootstrap only works on an empty instance.
		auth.WriteError(w, http.StatusBadRequest, "you cannot delete your own account")
		return
	}
	if err := a.store.DeleteUser(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			auth.WriteError(w, http.StatusNotFound, "no such user")
			return
		}
		auth.WriteError(w, http.StatusInternalServerError, "could not delete user")
		return
	}
	auth.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// publicUser is the user shape sent to clients. The password hash and TOTP
// secret are omitted by construction rather than by a json:"-" tag, so adding a
// field to store.User cannot accidentally leak it.
func publicUser(u *store.User) map[string]any {
	if u == nil {
		return nil
	}
	return map[string]any{
		"id":         u.ID,
		"username":   u.Username,
		"role":       string(u.Role),
		"totp":       u.TOTPSecret != "",
		"created_at": u.CreatedAt,
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// maxJSONBody bounds an API request body.
const maxJSONBody = 1 << 20 // 1 MiB

// decodeJSON reads a JSON body, writing a 400 and returning false on failure.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		auth.WriteError(w, http.StatusBadRequest, "invalid request body")
		return false
	}
	return true
}

// parseRange reads the ?from= / ?to= query parameters as Unix milliseconds,
// defaulting to the last 24 hours.
//
// The window is clamped to two years. An unbounded range on a large instance is
// a table scan that any unauthenticated share-link visitor could trigger.
func parseRange(r *http.Request) (store.Range, error) {
	now := time.Now().UTC()
	rg := store.Range{From: now.Add(-24 * time.Hour), To: now}

	if v := r.URL.Query().Get("from"); v != "" {
		ms, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return rg, fmt.Errorf("from must be Unix milliseconds")
		}
		rg.From = time.UnixMilli(ms).UTC()
	}
	if v := r.URL.Query().Get("to"); v != "" {
		ms, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return rg, fmt.Errorf("to must be Unix milliseconds")
		}
		rg.To = time.UnixMilli(ms).UTC()
	}
	if !rg.To.After(rg.From) {
		return rg, fmt.Errorf("to must be after from")
	}
	if rg.To.Sub(rg.From) > 2*365*24*time.Hour {
		return rg, fmt.Errorf("range must not exceed two years")
	}
	return rg, nil
}

func parseInterval(r *http.Request, rg store.Range) store.Interval {
	switch r.URL.Query().Get("interval") {
	case "day":
		return store.IntervalDay
	case "hour":
		return store.IntervalHour
	}
	// Auto: hourly buckets are unreadable past a couple of days.
	if rg.To.Sub(rg.From) > 48*time.Hour {
		return store.IntervalDay
	}
	return store.IntervalHour
}

func parseLimit(r *http.Request, def, max int) int {
	v := r.URL.Query().Get("limit")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}
