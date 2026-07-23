package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"athar/backend/internal/store"
)

type contextKey int

const userCtxKey contextKey = iota

// UserFrom returns the authenticated user Middleware attached to the request.
// A nil result means the request is unauthenticated — handlers behind
// Middleware can rely on it being non-nil.
func UserFrom(r *http.Request) *store.User {
	if u, ok := r.Context().Value(userCtxKey).(*store.User); ok {
		return u
	}
	return nil
}

// WithUser returns a request carrying u. Exported for tests and for the public
// share-link path, which builds a restricted context without a login.
func WithUser(r *http.Request, u *store.User) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), userCtxKey, u))
}

// Middleware rejects unauthenticated requests and enforces CSRF on every
// state-changing method.
//
// CSRF is checked here rather than per-handler so that adding a route cannot
// accidentally omit it: a new POST route is protected by virtue of being mounted
// behind this middleware. The safe methods (GET, HEAD, OPTIONS) are exempt
// because they must not change state — a handler that mutates on GET is a bug
// this middleware deliberately will not paper over.
func (m *Manager) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := m.Authenticate(r.Context(), r)
		if err != nil {
			if errors.Is(err, ErrNoSession) {
				WriteError(w, http.StatusUnauthorized, "not signed in")
				return
			}
			WriteError(w, http.StatusInternalServerError, "session lookup failed")
			return
		}

		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			// Safe methods: no CSRF check.
		default:
			if !CheckCSRF(r) {
				WriteError(w, http.StatusForbidden, "missing or invalid CSRF token")
				return
			}
		}

		next.ServeHTTP(w, WithUser(r, user))
	})
}

// RequireAdmin wraps a handler so only instance admins reach it.
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user := UserFrom(r)
		if user == nil || user.Role != store.RoleAdmin {
			WriteError(w, http.StatusForbidden, "admin role required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ── Website authorisation ─────────────────────────────────────────────────────

// AccessLevel is the access a request has to one website.
type AccessLevel int

const (
	AccessNone AccessLevel = iota
	AccessRead
	AccessWrite // edit settings, mint share links
	AccessOwn   // delete the website
)

// WebsiteAccess resolves what a user may do with a website.
//
// Instance admins get full access to every site — an admin can already create
// users and read the database, so withholding it would be theatre rather than a
// boundary.
func WebsiteAccess(ctx context.Context, st store.Store, user *store.User, websiteID string) (AccessLevel, error) {
	if user == nil {
		return AccessNone, nil
	}
	if user.Role == store.RoleAdmin {
		return AccessOwn, nil
	}

	role, err := st.GetWebsiteRole(ctx, websiteID, user.ID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return AccessNone, nil
		}
		return AccessNone, err
	}
	switch role {
	case store.WebsiteRoleOwner:
		return AccessOwn, nil
	case store.WebsiteRoleEditor:
		return AccessWrite, nil
	case store.WebsiteRoleViewer:
		return AccessRead, nil
	default:
		return AccessNone, nil
	}
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

// WriteJSON writes a JSON response.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// Dashboard responses are per-user data; never let a proxy cache them.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

// WriteError writes a JSON error body.
//
// Messages here are written for the operator looking at their own dashboard, but
// they still say as little as possible about *why* a credential failed: the
// login handler answers "invalid username or password" for both cases.
func WriteError(w http.ResponseWriter, status int, msg string) {
	WriteJSON(w, status, map[string]string{"error": msg})
}
