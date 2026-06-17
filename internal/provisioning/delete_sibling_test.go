package provisioning_test

import (
	"context"
	"testing"

	"idp/internal/argocd"
	"idp/internal/cache"
	"idp/internal/catalog"
	"idp/internal/events"
	"idp/internal/gitlab"
	"idp/internal/harbor"
	"idp/internal/provisioning"
	"idp/internal/store"
	"idp/pkg/models"
)

// newAutoStack mirrors the local/demo wiring: GitLab fake auto-merges MRs on
// creation and the poller auto-merges too.
func newAutoStack(t *testing.T) *stack {
	t.Helper()
	st := store.NewMemory()
	c := cache.NewMemory()
	hb := harbor.NewFake()
	gl := gitlab.NewFake("managed-services", []string{"team-core"}, true) // auto-merge on create
	argo := argocd.NewFake(gl)
	cat := catalog.New(hb, c)
	gitops, err := provisioning.NewGitOps("managed-services", "team-{{.Team}}",
		"{{.Team}}-{{.ServiceName}}", "portal-managed", "main")
	if err != nil {
		t.Fatal(err)
	}
	prov := provisioning.New(st, gl, argo, cat, gitops, events.New(), "in-cluster", "main", true /* autoMerge */)
	return &stack{prov, gl, argo, st, gitops}
}

func createHealthy(ctx context.Context, t *testing.T, s *stack, u *models.User, name string) *models.Request {
	t.Helper()
	r, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: name, Values: validValues(),
	})
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	for range 6 {
		s.tick(ctx)
		if mustStatus(ctx, t, s.st, r.ID) == models.StatusHealthy {
			break
		}
	}
	if got := mustStatus(ctx, t, s.st, r.ID); got != models.StatusHealthy {
		t.Fatalf("%s want HEALTHY, got %s", name, got)
	}
	return r
}

// TestSiblingResyncDoesNotDemoteHealthy reproduces the reported bug: when one
// product is deleted (or changed), the shared Git branch advances and ArgoCD
// briefly marks an *untouched* sibling OutOfSync while it re-syncs. That must NOT
// demote the healthy sibling to DEPLOYING - its own manifests didn't change.
func TestSiblingResyncDoesNotDemoteHealthy(t *testing.T) {
	ctx := context.Background()
	s := newAutoStack(t)
	u := member("core")

	r := createHealthy(ctx, t, s, u, "pg1")

	// Simulate the re-sync ArgoCD triggers when a sibling's MR moves the shared
	// branch: the app is still Healthy but momentarily OutOfSync.
	app, err := s.argo.GetApplication(ctx, r.ArgoCDAppName)
	if err != nil {
		t.Fatalf("get app: %v", err)
	}
	app.Sync = argocd.SyncOutOfSync
	s.argo.Upsert(*app)

	// Reconcile (no fake-ArgoCD advance) must keep the product HEALTHY.
	if err := s.prov.Reconcile(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if got := mustStatus(ctx, t, s.st, r.ID); got != models.StatusHealthy {
		t.Fatalf("untouched product demoted on sibling re-sync: want HEALTHY, got %s", got)
	}
}

// TestDeleteOneKeepsOtherHealthy drives two orders to HEALTHY, deletes one and
// asserts the survivor stays HEALTHY through the full delete lifecycle.
func TestDeleteOneKeepsOtherHealthy(t *testing.T) {
	ctx := context.Background()
	s := newAutoStack(t)
	u := member("core")

	pg1 := createHealthy(ctx, t, s, u, "pg1")
	pg2 := createHealthy(ctx, t, s, u, "pg2")

	if _, err := s.prov.Delete(ctx, u, pg1.ID); err != nil {
		t.Fatalf("delete pg1: %v", err)
	}

	for i := range 6 {
		s.tick(ctx)
		if got := mustStatus(ctx, t, s.st, pg2.ID); got != models.StatusHealthy {
			t.Fatalf("after delete tick %d: pg2 want HEALTHY, got %s", i, got)
		}
	}

	if got := mustStatus(ctx, t, s.st, pg1.ID); got != models.StatusDeleted {
		t.Fatalf("pg1 want DELETED, got %s", got)
	}
}
