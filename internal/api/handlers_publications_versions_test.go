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
