package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"idp/internal/auth"
)

// SystemInfo carries the configured backend modes + external UI URLs for the
// status page. It is set once at wiring time (main.go) and is purely descriptive.
type SystemInfo struct {
	HarborMode   string // fake|real
	GitLabMode   string // fake|real
	ArgoCDMode   string // fake|real
	StoreBackend string // memory|postgres
	CacheBackend string // memory|redis
	HarborURL    string // external UI link (empty in fake mode)
	GitLabURL    string
	ArgoCDURL    string
	AuthMode     string // oidc|dev
	OIDCIssuer   string // Keycloak issuer (empty in dev mode)
}

// ComponentStatus is one row on the system status page.
type ComponentStatus struct {
	Name   string `json:"name"`             // harbor|gitlab|argocd|store|cache
	Kind   string `json:"kind"`             // "integration" | "storage"
	Mode   string `json:"mode"`             // integration: fake|real; storage: backend
	Status string `json:"status"`           // "ok" | "error"
	Detail string `json:"detail,omitempty"` // error message when status != ok
	URL    string `json:"url,omitempty"`    // external UI link (integrations only)
}

// SystemStatus is the aggregate health payload returned by GET /api/v1/status.
type SystemStatus struct {
	Healthy    bool              `json:"healthy"`
	Components []ComponentStatus `json:"components"`
}

// checkTimeout bounds each individual probe so one stuck upstream can't hang the
// whole status response.
const checkTimeout = 5 * time.Second

// componentCheck describes one probe on the status page: its identity plus the
// function that reports whether the component is reachable.
type componentCheck struct {
	name, kind, mode, url string
	probe                 func(context.Context) error
}

// statusChecks builds the probe set for every integration (Harbor/GitLab/ArgoCD
// via Healthz, Keycloak via its discovery doc) and storage backend (store/cache
// via Ping). Shared by the status endpoint and the metrics refresher so both
// report on exactly the same components.
func (s *Server) statusChecks() []componentCheck {
	// Keycloak: in oidc mode hit the issuer's discovery doc (validates reachability);
	// in dev mode there is no external IdP, so report ok with mode "dev".
	authProbe := func(ctx context.Context) error {
		if s.System.AuthMode != "oidc" {
			return nil
		}
		url := strings.TrimRight(s.System.OIDCIssuer, "/") + "/.well-known/openid-configuration"
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("keycloak discovery %s: HTTP %d", url, resp.StatusCode)
		}
		return nil
	}
	return []componentCheck{
		{"keycloak", "integration", s.System.AuthMode, issuerBase(s.System.OIDCIssuer), authProbe},
		{"harbor", "integration", s.System.HarborMode, s.System.HarborURL, s.Harbor.Healthz},
		{"gitlab", "integration", s.System.GitLabMode, s.System.GitLabURL, s.GitLab.Healthz},
		{"argocd", "integration", s.System.ArgoCDMode, s.System.ArgoCDURL, s.ArgoCD.Healthz},
		{"store", "storage", s.System.StoreBackend, "", s.Store.Ping},
		{"cache", "storage", s.System.CacheBackend, "", s.Cache.Ping},
	}
}

// handleSystemStatus probes every integration (Harbor/GitLab/ArgoCD via Healthz)
// and storage backend (store/cache via Ping) in parallel and reports their
// health. Always returns 200 - the body's `healthy` flag carries the verdict so
// the page can render partial failures rather than erroring out.
func (s *Server) handleSystemStatus(w http.ResponseWriter, r *http.Request) {
	// System status is a platform-admin tool (integration health, storage backends).
	if u := auth.UserFrom(r.Context()); u == nil || !u.IsAdmin() {
		writeErr(w, http.StatusForbidden, "forbidden", "system status is restricted to platform admins")
		return
	}
	checks := s.statusChecks()

	comps := make([]ComponentStatus, len(checks))
	var wg sync.WaitGroup
	for i, c := range checks {
		wg.Add(1)
		go func(i int, c componentCheck) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(r.Context(), checkTimeout)
			defer cancel()
			comp := ComponentStatus{Name: c.name, Kind: c.kind, Mode: c.mode, URL: c.url, Status: "ok"}
			if err := c.probe(ctx); err != nil {
				comp.Status = "error"
				comp.Detail = err.Error()
			}
			comps[i] = comp
		}(i, c)
	}
	wg.Wait()

	healthy := true
	for _, c := range comps {
		if c.Status != "ok" {
			healthy = false
			break
		}
	}
	writeJSON(w, http.StatusOK, SystemStatus{Healthy: healthy, Components: comps})
}

// issuerBase strips the Keycloak realm suffix ("…/realms/<name>") from the OIDC
// issuer so the status page links to the IdP root, not the realm endpoint.
func issuerBase(issuer string) string {
	base, _, _ := strings.Cut(issuer, "/realms/")
	return base
}
