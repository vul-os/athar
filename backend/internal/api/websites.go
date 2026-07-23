package api

import (
	"errors"
	"net/http"
	"strings"

	"athar/backend/internal/auth"
	"athar/backend/internal/store"
)

// websiteView is the website shape sent to clients.
type websiteView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Domain    string `json:"domain"`
	ShareID   string `json:"share_id,omitempty"`
	OwnerID   string `json:"owner_id"`
	CreatedAt int64  `json:"created_at"`
	Access    string `json:"access,omitempty"`
}

func toWebsiteView(w *store.Website, access auth.AccessLevel) websiteView {
	v := websiteView{
		ID:        w.ID,
		Name:      w.Name,
		Domain:    w.Domain,
		ShareID:   w.ShareID,
		OwnerID:   w.OwnerID,
		CreatedAt: w.CreatedAt.UnixMilli(),
	}
	switch access {
	case auth.AccessOwn:
		v.Access = "owner"
	case auth.AccessWrite:
		v.Access = "editor"
	case auth.AccessRead:
		v.Access = "viewer"
	}
	return v
}

func (a *API) handleListWebsites(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFrom(r)
	sites, err := a.store.ListWebsitesForUser(r.Context(), user.ID, user.Role == store.RoleAdmin)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not list websites")
		return
	}

	out := make([]websiteView, 0, len(sites))
	for i := range sites {
		access, err := auth.WebsiteAccess(r.Context(), a.store, user, sites[i].ID)
		if err != nil {
			auth.WriteError(w, http.StatusInternalServerError, "could not resolve access")
			return
		}
		out = append(out, toWebsiteView(&sites[i], access))
	}
	auth.WriteJSON(w, http.StatusOK, out)
}

type websiteRequest struct {
	Name   string `json:"name"`
	Domain string `json:"domain"`
}

func (a *API) handleCreateWebsite(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFrom(r)
	var req websiteRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	name := strings.TrimSpace(req.Name)
	domain := normalizeDomain(req.Domain)
	if name == "" {
		auth.WriteError(w, http.StatusBadRequest, "name is required")
		return
	}
	if domain == "" {
		auth.WriteError(w, http.StatusBadRequest, "domain is required")
		return
	}

	site := &store.Website{Name: name, Domain: domain, OwnerID: user.ID}
	if err := a.store.CreateWebsite(r.Context(), site); err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not create website")
		return
	}
	auth.WriteJSON(w, http.StatusCreated, toWebsiteView(site, auth.AccessOwn))
}

// requireWebsite resolves the {id} path value and checks the caller has at least
// `need` access. It writes the error response itself and returns nil when the
// request should stop.
//
// A caller without access gets 404, not 403: a 403 confirms the website exists,
// which turns the id space into something worth probing.
func (a *API) requireWebsite(w http.ResponseWriter, r *http.Request, need auth.AccessLevel) (*store.Website, auth.AccessLevel) {
	id := r.PathValue("id")
	user := auth.UserFrom(r)

	access, err := auth.WebsiteAccess(r.Context(), a.store, user, id)
	if err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not resolve access")
		return nil, auth.AccessNone
	}
	if access < need {
		auth.WriteError(w, http.StatusNotFound, "no such website")
		return nil, auth.AccessNone
	}

	site, err := a.store.GetWebsite(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			auth.WriteError(w, http.StatusNotFound, "no such website")
			return nil, auth.AccessNone
		}
		auth.WriteError(w, http.StatusInternalServerError, "could not load website")
		return nil, auth.AccessNone
	}
	return site, access
}

func (a *API) handleGetWebsite(w http.ResponseWriter, r *http.Request) {
	site, access := a.requireWebsite(w, r, auth.AccessRead)
	if site == nil {
		return
	}
	auth.WriteJSON(w, http.StatusOK, toWebsiteView(site, access))
}

func (a *API) handleUpdateWebsite(w http.ResponseWriter, r *http.Request) {
	site, access := a.requireWebsite(w, r, auth.AccessWrite)
	if site == nil {
		return
	}
	var req websiteRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if name := strings.TrimSpace(req.Name); name != "" {
		site.Name = name
	}
	if domain := normalizeDomain(req.Domain); domain != "" {
		site.Domain = domain
	}
	if err := a.store.UpdateWebsite(r.Context(), site); err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not update website")
		return
	}
	a.collector.InvalidateSite(site.ID)
	auth.WriteJSON(w, http.StatusOK, toWebsiteView(site, access))
}

func (a *API) handleDeleteWebsite(w http.ResponseWriter, r *http.Request) {
	site, _ := a.requireWebsite(w, r, auth.AccessOwn)
	if site == nil {
		return
	}
	// Deleting a website cascades to every visit, event, heatmap sample and
	// revenue row it owns. That is the intent: "delete this site" must actually
	// remove the data, not orphan it.
	if err := a.store.DeleteWebsite(r.Context(), site.ID); err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not delete website")
		return
	}
	a.collector.InvalidateSite(site.ID)
	auth.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type shareRequest struct {
	Enabled bool `json:"enabled"`
}

// handleSetShare mints or revokes the public dashboard link.
//
// Enabling always mints a *fresh* id rather than reusing the previous one, so
// disabling sharing is a real revocation: an old link cannot be resurrected by
// turning sharing back on.
func (a *API) handleSetShare(w http.ResponseWriter, r *http.Request) {
	site, access := a.requireWebsite(w, r, auth.AccessWrite)
	if site == nil {
		return
	}
	var req shareRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	if req.Enabled {
		site.ShareID = store.NewID()
	} else {
		site.ShareID = ""
	}
	if err := a.store.UpdateWebsite(r.Context(), site); err != nil {
		auth.WriteError(w, http.StatusInternalServerError, "could not update sharing")
		return
	}
	auth.WriteJSON(w, http.StatusOK, toWebsiteView(site, access))
}

// normalizeDomain strips scheme, path, port and a leading "www.".
func normalizeDomain(raw string) string {
	d := strings.TrimSpace(strings.ToLower(raw))
	if d == "" {
		return ""
	}
	d = strings.TrimPrefix(strings.TrimPrefix(d, "https://"), "http://")
	if i := strings.IndexAny(d, "/?#"); i >= 0 {
		d = d[:i]
	}
	if i := strings.IndexByte(d, ':'); i >= 0 {
		d = d[:i]
	}
	return strings.TrimPrefix(d, "www.")
}

// ── Public share links ────────────────────────────────────────────────────────

// resolveShare looks up a website by share id. Every share handler goes through
// this and never touches a caller-supplied website id, so a share link cannot be
// pivoted into reading a different site.
func (a *API) resolveShare(w http.ResponseWriter, r *http.Request) *store.Website {
	shareID := r.PathValue("shareID")
	site, err := a.store.GetWebsiteByShareID(r.Context(), shareID)
	if err != nil {
		auth.WriteError(w, http.StatusNotFound, "no such shared dashboard")
		return nil
	}
	return site
}

func (a *API) handleShareSite(w http.ResponseWriter, r *http.Request) {
	site := a.resolveShare(w, r)
	if site == nil {
		return
	}
	// A shared dashboard reveals the site's name and domain — which is the
	// point of sharing it — but never its internal id or owner, so a link
	// cannot be turned into an authenticated-API identifier.
	auth.WriteJSON(w, http.StatusOK, map[string]any{
		"name":       site.Name,
		"domain":     site.Domain,
		"share_id":   site.ShareID,
		"created_at": site.CreatedAt.UnixMilli(),
	})
}

// handleShareStats serves the same summary as the authenticated endpoint, for a
// shared website.
func (a *API) handleShareStats(w http.ResponseWriter, r *http.Request) {
	site := a.resolveShare(w, r)
	if site == nil {
		return
	}
	a.writeSummary(r.Context(), w, r, site.ID)
}
