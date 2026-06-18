package argocd_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"console/internal/argocd"
	"console/pkg/models"
)

// newServer spins up a stub argocd-server and a Client pointed at it.
func newServer(t *testing.T, h http.HandlerFunc) *argocd.Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return argocd.NewClient(srv.URL, "tok", 0)
}

func TestClientListApplications(t *testing.T) {
	ctx := context.Background()
	c := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			t.Errorf("missing bearer token, got %q", got)
		}
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/applications" {
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
			return
		}
		// selector keys must be sorted and equality-joined.
		if got := r.URL.Query().Get("selector"); got != "idp.team=core,managed-by=portal" {
			t.Errorf("selector = %q", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{
					"metadata": map[string]any{"name": "core-pg1", "labels": map[string]string{"idp.team": "core"}},
					"spec":     map[string]any{"project": "portal-managed", "destination": map[string]any{"name": "in-cluster"}},
					"status": map[string]any{
						"sync":   map[string]any{"status": "Synced"},
						"health": map[string]any{"status": "Healthy"},
					},
				},
			},
		})
	})

	apps, err := c.ListApplications(ctx, map[string]string{"managed-by": "portal", "idp.team": "core"})
	if err != nil {
		t.Fatalf("ListApplications err=%v", err)
	}
	if len(apps) != 1 {
		t.Fatalf("want 1 app, got %d", len(apps))
	}
	a := apps[0]
	if a.Name != "core-pg1" || a.Project != "portal-managed" || a.Cluster != "in-cluster" ||
		a.Sync != argocd.SyncSynced || a.Health != argocd.HealthHealthy || a.Labels["idp.team"] != "core" {
		t.Fatalf("unexpected app: %+v", a)
	}
}

func TestClientGetApplicationDefaultsUnknown(t *testing.T) {
	ctx := context.Background()
	c := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/applications/core-pg1" {
			http.Error(w, "unexpected path "+r.URL.Path, http.StatusInternalServerError)
			return
		}
		// No sync/health status yet - client must default to Unknown, and fall
		// back to destination.server when destination.name is empty.
		_ = json.NewEncoder(w).Encode(map[string]any{
			"metadata": map[string]any{"name": "core-pg1"},
			"spec":     map[string]any{"destination": map[string]any{"server": "https://kubernetes.default.svc"}},
		})
	})

	a, err := c.GetApplication(ctx, "core-pg1")
	if err != nil {
		t.Fatalf("GetApplication err=%v", err)
	}
	if a.Sync != argocd.SyncUnknown || a.Health != argocd.HealthUnknown {
		t.Fatalf("want Unknown defaults, got sync=%q health=%q", a.Sync, a.Health)
	}
	if a.Cluster != "https://kubernetes.default.svc" {
		t.Fatalf("cluster fallback failed: %q", a.Cluster)
	}
}

func TestClientGetApplicationNotFound(t *testing.T) {
	c := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
	})
	_, err := c.GetApplication(context.Background(), "missing")
	if !errors.Is(err, models.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

// ArgoCD returns 403 (not 404) for a missing application; GetApplication must
// map it to ErrNotFound so the delete flow can detect a pruned app.
func TestClientGetApplicationForbiddenIsNotFound(t *testing.T) {
	c := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"permission denied","code":7}`, http.StatusForbidden)
	})
	_, err := c.GetApplication(context.Background(), "gone")
	if !errors.Is(err, models.ErrNotFound) {
		t.Fatalf("want ErrNotFound for 403, got %v", err)
	}
}

func TestClientSync(t *testing.T) {
	c := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/applications/core-pg1/sync" {
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{}`))
	})
	if err := c.Sync(context.Background(), "core-pg1"); err != nil {
		t.Fatalf("Sync err=%v", err)
	}
}
