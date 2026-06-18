package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"console/internal/api"
	"console/internal/argocd"
	"console/internal/auth"
	"console/internal/cache"
	"console/internal/catalog"
	"console/internal/events"
	"console/internal/gitlab"
	"console/internal/harbor"
	"console/internal/observability"
	"console/internal/provisioning"
	"console/internal/publications"
	"console/internal/status"
	"console/internal/store"
	"console/pkg/models"
)

func newServer(t *testing.T) (*api.Server, *argocd.Fake, *provisioning.Service) {
	t.Helper()
	st := store.NewMemory()
	c := cache.NewMemory()
	hb := harbor.NewFake()
	gl := gitlab.NewFake("managed-services", []string{"team-core"}, true) // auto-merge
	argo := argocd.NewFake(gl)
	cat := catalog.New(hb, c)
	gitops, _ := provisioning.NewGitOps("managed-services", "team-{{.Team}}", "{{.Team}}-{{.ServiceName}}", "portal-managed", "main")
	prov := provisioning.New(st, gl, argo, cat, gitops, events.New(), "in-cluster", "main", false)
	srv := &api.Server{
		Auth: auth.NewDev(), Catalog: cat, Prov: prov, Pubs: publications.New(st, cat), Status: status.New(argo),
		Store: st, Cache: c, Bus: events.New(), Log: observability.NewLogger("error", "text"),
	}
	return srv, argo, prov
}

// devReq builds a request authenticated as a dev member of the given team.
func devReq(method, path, team string, body any) *http.Request {
	var r *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		r = httptest.NewRequest(method, path, bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	r.Header.Set("X-Dev-Teams", team)
	r.Header.Set("X-Dev-Role", string(models.RoleMember))
	return r
}

func TestHTTPHealthAndMe(t *testing.T) {
	srv, _, _ := newServer(t)
	h := srv.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health: %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, devReq("GET", "/api/v1/auth/me", "core", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("me: %d body=%s", rec.Code, rec.Body.String())
	}
	var u models.User
	_ = json.Unmarshal(rec.Body.Bytes(), &u)
	if !u.InTeam("core") {
		t.Fatalf("me missing team: %+v", u)
	}
}

func TestHTTPUnauthorizedNothing(t *testing.T) {
	// dev auth always authenticates, so charts should succeed without headers too.
	srv, _, _ := newServer(t)
	h := srv.Router()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/charts", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("charts: %d", rec.Code)
	}
}

func TestHTTPCreateAndReconcile(t *testing.T) {
	srv, argo, prov := newServer(t)
	h := srv.Router()
	ctx := context.Background()

	body := map[string]any{
		"chart": "platform/postgres", "version": "15.4.2", "team": "core",
		"service_name": "pg1", "values": map[string]any{"auth": map[string]any{"database": "app"}},
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, devReq("POST", "/api/v1/requests", "core", body))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d body=%s", rec.Code, rec.Body.String())
	}
	var req models.Request
	_ = json.Unmarshal(rec.Body.Bytes(), &req)
	if req.Status != models.StatusMRCreated {
		t.Fatalf("want MR_CREATED, got %s", req.Status)
	}

	// reconcile to HEALTHY (auto-merge already merged the MR)
	for i := 0; i < 3; i++ {
		_ = argo.Reconcile(ctx)
		_ = prov.Reconcile(ctx)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, devReq("GET", "/api/v1/requests/"+req.ID, "core", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d", rec.Code)
	}
	var detail struct {
		Request models.Request `json:"request"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &detail)
	if detail.Request.Status != models.StatusHealthy {
		t.Fatalf("want HEALTHY, got %s", detail.Request.Status)
	}

	// applications endpoint shows the app for the team
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, devReq("GET", "/api/v1/applications", "core", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("apps: %d", rec.Code)
	}
	var apps []argocd.Application
	_ = json.Unmarshal(rec.Body.Bytes(), &apps)
	if len(apps) != 1 || apps[0].Name != "core-pg1" {
		t.Fatalf("unexpected apps: %+v", apps)
	}

	// a different team must not see it
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, devReq("GET", "/api/v1/applications", "payments", nil))
	_ = json.Unmarshal(rec.Body.Bytes(), &apps)
	if len(apps) != 0 {
		t.Fatalf("payments should see no apps, got %+v", apps)
	}
}
