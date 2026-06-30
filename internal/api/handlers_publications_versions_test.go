package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"console/internal/publications"
	"console/pkg/models"
)

// TestVersionManagementAPI drives the per-version view + approval FSM over HTTP.
func TestVersionManagementAPI(t *testing.T) {
	srv, _, _ := newServer(t)
	h := srv.Router()
	ctx := context.Background()
	view := json.RawMessage(`{"views":{"order":{"identity":"/gateways/0/name","include":["gateways"]}}}`)

	// Set up a category + publication via the service (owner is team core).
	owner := &models.User{Subject: "owner", Teams: []string{"core"}, Role: models.RoleMember}
	if err := srv.Pubs.CreateCategory(ctx, &models.User{Role: models.RoleAdmin}, &models.Category{ID: "network", Label: "net"}); err != nil {
		t.Fatal(err)
	}
	pub, err := srv.Pubs.Create(ctx, owner, publications.CreateInput{
		ChartProject: "platform", ChartName: "myservice", CategoryID: "network", OwnerTeam: "core",
	})
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/publications/" + pub.ID

	do := func(req *http.Request) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// Save a draft view for version 1.0.0.
	if rec := do(devReq("PUT", base+"/versions/1.0.0", "core", map[string]any{"view": view})); rec.Code != http.StatusOK {
		t.Fatalf("save view: %d body=%s", rec.Code, rec.Body.String())
	}
	// Submit, approve (admin), allowlist, recommend.
	if rec := do(devReq("POST", base+"/versions/1.0.0/submit", "core", nil)); rec.Code != http.StatusOK {
		t.Fatalf("submit: %d body=%s", rec.Code, rec.Body.String())
	}
	// Pending-versions queue: admin sees it, a member is forbidden.
	if rec := do(devReq("GET", "/api/v1/publications/pending-versions", "core", nil)); rec.Code != http.StatusForbidden {
		t.Fatalf("member pending-versions: want 403, got %d", rec.Code)
	}
	{
		rec := do(adminReq("GET", "/api/v1/publications/pending-versions", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("pending-versions: %d body=%s", rec.Code, rec.Body.String())
		}
		var pending []struct {
			Version models.PublicationVersion `json:"version"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &pending); err != nil {
			t.Fatal(err)
		}
		if len(pending) != 1 || pending[0].Version.ChartVersion != "1.0.0" {
			t.Fatalf("unexpected pending versions: %+v", pending)
		}
	}
	// A member cannot approve.
	if rec := do(devReq("POST", base+"/versions/1.0.0/approve", "core", nil)); rec.Code != http.StatusForbidden {
		t.Fatalf("member approve: want 403, got %d", rec.Code)
	}
	if rec := do(adminReq("POST", base+"/versions/1.0.0/approve", nil)); rec.Code != http.StatusOK {
		t.Fatalf("approve: %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := do(devReq("POST", base+"/versions/1.0.0/orderable", "core", map[string]any{"orderable": true})); rec.Code != http.StatusOK {
		t.Fatalf("orderable: %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := do(devReq("POST", base+"/recommended", "core", map[string]any{"version": "1.0.0"})); rec.Code != http.StatusNoContent {
		t.Fatalf("recommend: %d body=%s", rec.Code, rec.Body.String())
	}

	// List versions reflects the approved+orderable state.
	rec := do(devReq("GET", base+"/versions", "core", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d", rec.Code)
	}
	var versions []models.PublicationVersion
	if err := json.Unmarshal(rec.Body.Bytes(), &versions); err != nil {
		t.Fatal(err)
	}
	if len(versions) != 1 || versions[0].Status != models.PubApproved || !versions[0].Orderable {
		t.Fatalf("unexpected versions: %+v", versions)
	}
}

// publishes two orderable versions of a synthetic chart and checks that the
// catalog summary and the version-aware view endpoint reflect them.
func TestCatalogAndViewExposeVersions(t *testing.T) {
	srv, _, _ := newServer(t)
	h := srv.Router()
	ctx := context.Background()

	owner := &models.User{Subject: "owner", Name: "Owner", Teams: []string{"core"}, Role: models.RoleMember}
	adminU := &models.User{Subject: "admin", Name: "Admin", Role: models.RoleAdmin}
	view := json.RawMessage(`{"views":{"order":{"identity":"/gateways/0/name","include":["gateways"]}}}`)

	if err := srv.Pubs.CreateCategory(ctx, adminU, &models.Category{ID: "network", Label: "net"}); err != nil {
		t.Fatal(err)
	}
	p, err := srv.Pubs.Create(ctx, owner, publications.CreateInput{
		ChartProject: "platform", ChartName: "myservice", CategoryID: "network", OwnerTeam: "core",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, cv := range []string{"1.0.0", "2.0.0"} {
		if _, err := srv.Pubs.SaveVersionView(ctx, owner, p.ID, cv, view); err != nil {
			t.Fatalf("save %s: %v", cv, err)
		}
		if _, err := srv.Pubs.SubmitVersion(ctx, owner, p.ID, cv); err != nil {
			t.Fatalf("submit %s: %v", cv, err)
		}
		if _, err := srv.Pubs.ApproveVersion(ctx, adminU, p.ID, cv); err != nil {
			t.Fatalf("approve %s: %v", cv, err)
		}
		if _, err := srv.Pubs.SetVersionOrderable(ctx, owner, p.ID, cv, true); err != nil {
			t.Fatalf("orderable %s: %v", cv, err)
		}
	}
	if err := srv.Pubs.SetRecommendedVersion(ctx, owner, p.ID, "1.0.0"); err != nil {
		t.Fatal(err)
	}

	// Catalog summary carries recommended + orderable versions.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, devReq("GET", "/api/v1/catalog", "core", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("catalog: %d body=%s", rec.Code, rec.Body.String())
	}
	var cat struct {
		Charts []struct {
			Project     string `json:"project"`
			Name        string `json:"name"`
			Publication *struct {
				Published          bool     `json:"published"`
				RecommendedVersion string   `json:"recommended_version"`
				OrderableVersions  []string `json:"orderable_versions"`
			} `json:"publication"`
		} `json:"charts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, c := range cat.Charts {
		if c.Project == "platform" && c.Name == "myservice" {
			found = true
			if c.Publication == nil || !c.Publication.Published {
				t.Fatalf("publication not published: %+v", c.Publication)
			}
			if c.Publication.RecommendedVersion != "1.0.0" {
				t.Fatalf("recommended want 1.0.0, got %q", c.Publication.RecommendedVersion)
			}
			// Highest first.
			got := c.Publication.OrderableVersions
			if len(got) != 2 || got[0] != "2.0.0" || got[1] != "1.0.0" {
				t.Fatalf("orderable versions want [2.0.0 1.0.0], got %v", got)
			}
		}
	}
	if !found {
		t.Fatal("myservice not in catalog")
	}

	// Version-aware view endpoint.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, devReq("GET", "/api/v1/charts/platform/myservice/view?version=2.0.0", "core", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("view v2: %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != string(view) {
		t.Fatalf("view body mismatch: %s", rec.Body.String())
	}

	// A non-orderable / unknown version is 404.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, devReq("GET", "/api/v1/charts/platform/myservice/view?version=9.9.9", "core", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("view unknown version: want 404, got %d", rec.Code)
	}
}
