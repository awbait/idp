package provisioning_test

import (
	"context"
	"errors"
	"testing"

	"console/internal/argocd"
	"console/internal/cache"
	"console/internal/catalog"
	"console/internal/events"
	"console/internal/gitlab"
	"console/internal/harbor"
	"console/internal/provisioning"
	"console/internal/store"
	"console/pkg/models"
)

type stack struct {
	prov   *provisioning.Service
	gl     *gitlab.Fake
	argo   *argocd.Fake
	st     store.Store
	gitops *provisioning.GitOps
}

func newStack(t *testing.T) *stack {
	t.Helper()
	st := store.NewMemory()
	c := cache.NewMemory()
	hb := harbor.NewFake()
	gl := gitlab.NewFake("managed-services", []string{"team-core"}, false) // manual merge
	argo := argocd.NewFake(gl)
	cat := catalog.New(hb, c)
	gitops, err := provisioning.NewGitOps("managed-services", "team-{{.Team}}",
		"{{.Team}}-{{.ServiceName}}", "portal-managed", "main")
	if err != nil {
		t.Fatal(err)
	}
	prov := provisioning.New(st, gl, argo, cat, gitops, events.New(), "in-cluster", "main", false)
	return &stack{prov, gl, argo, st, gitops}
}

func (s *stack) tick(ctx context.Context) {
	_ = s.argo.Reconcile(ctx)
	_ = s.prov.Reconcile(ctx)
}

func (s *stack) mergeLatestMR(ctx context.Context, t *testing.T, reqID string) {
	t.Helper()
	mrs, err := s.st.ListMRs(ctx, reqID)
	if err != nil || len(mrs) == 0 {
		t.Fatalf("no MRs for %s: %v", reqID, err)
	}
	latest := mrs[len(mrs)-1]
	if err := s.gl.MergeMR(ctx, latest.GitLabProjectID, latest.MRIID); err != nil {
		t.Fatalf("merge: %v", err)
	}
}

func member(teams ...string) *models.User {
	return &models.User{Subject: "u1", Name: "User One", Teams: teams, Role: models.RoleMember}
}

func validValues() map[string]any {
	return map[string]any{"auth": map[string]any{"database": "app"}}
}

func TestOrderLifecycle(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")

	req, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: validValues(),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if req.Status != models.StatusMRCreated {
		t.Fatalf("want MR_CREATED, got %s", req.Status)
	}
	if req.ArgoCDAppName != "core-pg1" {
		t.Fatalf("unexpected app name: %s", req.ArgoCDAppName)
	}

	// merge the create MR, then reconcile to HEALTHY
	s.mergeLatestMR(ctx, t, req.ID)
	s.tick(ctx) // MR_CREATED -> MR_MERGED -> DEPLOYING
	if got := mustStatus(ctx, t, s.st, req.ID); got != models.StatusDeploying {
		t.Fatalf("after tick1 want DEPLOYING, got %s", got)
	}
	s.tick(ctx) // DEPLOYING -> HEALTHY
	if got := mustStatus(ctx, t, s.st, req.ID); got != models.StatusHealthy {
		t.Fatalf("after tick2 want HEALTHY, got %s", got)
	}

	if app, err := s.argo.GetApplication(ctx, "core-pg1"); err != nil || app.Health != argocd.HealthHealthy {
		t.Fatalf("app not healthy: %+v err=%v", app, err)
	}

	// delete -> DELETE_REQUESTED -> (merge) -> DELETED
	if _, err := s.prov.Delete(ctx, u, req.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if got := mustStatus(ctx, t, s.st, req.ID); got != models.StatusDeleteRequested {
		t.Fatalf("want DELETE_REQUESTED, got %s", got)
	}
	s.mergeLatestMR(ctx, t, req.ID)
	s.tick(ctx) // DELETE_REQUESTED -> DELETE_MR_MERGED -> DELETED
	final, _ := s.st.GetRequest(ctx, req.ID)
	if final.Status != models.StatusDeleted {
		t.Fatalf("want DELETED, got %s", final.Status)
	}
	if final.DeletedAt == nil {
		t.Fatalf("deleted_at not set")
	}
}

func TestCreateDisplayName(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")

	// empty display name defaults to service_name
	req, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: validValues(),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if req.DisplayName != "pg1" {
		t.Fatalf("display name default = %q, want pg1", req.DisplayName)
	}

	// explicit display name is kept; it does not touch the deploy identity
	req2, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg2", DisplayName: "Payments DB", Values: validValues(),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if req2.DisplayName != "Payments DB" || req2.ServiceName != "pg2" {
		t.Fatalf("got display=%q service=%q", req2.DisplayName, req2.ServiceName)
	}
}

func TestCreateNamespaceValidation(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")

	// purely numeric namespace is rejected
	var ve *provisioning.ValidationError
	if _, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Namespace: "12345", Values: validValues(),
	}); !errors.As(err, &ve) {
		t.Fatalf("numeric namespace: want validation error, got %v", err)
	}

	// an invalid k8s name too
	if _, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Namespace: "Bad_NS", Values: validValues(),
	}); !errors.As(err, &ve) {
		t.Fatalf("bad namespace: want validation error, got %v", err)
	}

	// a normal namespace passes
	req, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Namespace: "payments-prod", Values: validValues(),
	})
	if err != nil || req.Namespace != "payments-prod" {
		t.Fatalf("valid namespace: err=%v ns=%q", err, req.Namespace)
	}
}

func TestCreateConflict(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")
	in := provisioning.CreateInput{ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: validValues()}
	if _, err := s.prov.Create(ctx, u, in); err != nil {
		t.Fatalf("first create: %v", err)
	}
	if _, err := s.prov.Create(ctx, u, in); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
}

func TestCreateForbiddenOtherTeam(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("payments") // not core
	_, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: validValues(),
	})
	if !errors.Is(err, provisioning.ErrForbidden) {
		t.Fatalf("want forbidden, got %v", err)
	}
}

func TestCreateValidationFails(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")
	_, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: map[string]any{"auth": map[string]any{}}, // missing required database
	})
	var ve *provisioning.ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("want ValidationError, got %v", err)
	}
}

func TestUpdateBlockedByOpenMR(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")
	req, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: validValues(),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// create MR still open -> update must be rejected
	_, err = s.prov.Update(ctx, u, req.ID, provisioning.UpdateInput{Values: validValues()})
	if !errors.Is(err, provisioning.ErrOpenMR) {
		t.Fatalf("want ErrOpenMR, got %v", err)
	}
}

func TestDraftLifecycle(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")

	// A draft persists even with incomplete values (no required auth.database)
	// and does not open an MR.
	req, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", DisplayName: "Payments DB",
		Values: map[string]any{"auth": map[string]any{}}, Draft: true,
	})
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}
	if req.Status != models.StatusDraft {
		t.Fatalf("want DRAFT, got %s", req.Status)
	}
	if mrs, _ := s.st.ListMRs(ctx, req.ID); len(mrs) != 0 {
		t.Fatalf("draft must not open an MR, got %d", len(mrs))
	}

	// Submitting an incomplete draft fails schema validation and stays DRAFT.
	if _, err := s.prov.Submit(ctx, u, req.ID); err == nil {
		t.Fatalf("submit of incomplete draft should fail")
	} else {
		var ve *provisioning.ValidationError
		if !errors.As(err, &ve) {
			t.Fatalf("want ValidationError, got %v", err)
		}
	}
	if got := mustStatus(ctx, t, s.st, req.ID); got != models.StatusDraft {
		t.Fatalf("failed submit should keep DRAFT, got %s", got)
	}

	// Editing the draft (fill required values, keep editing display name) does
	// not open an MR and keeps it a DRAFT.
	upd, err := s.prov.Update(ctx, u, req.ID, provisioning.UpdateInput{
		DisplayName: "Payments Primary", Values: validValues(),
	})
	if err != nil {
		t.Fatalf("update draft: %v", err)
	}
	if upd.Status != models.StatusDraft || upd.DisplayName != "Payments Primary" {
		t.Fatalf("got status=%s display=%q", upd.Status, upd.DisplayName)
	}
	if mrs, _ := s.st.ListMRs(ctx, req.ID); len(mrs) != 0 {
		t.Fatalf("draft edit must not open an MR, got %d", len(mrs))
	}

	// Submitting the now-valid draft opens the create MR and advances the order.
	sub, err := s.prov.Submit(ctx, u, req.ID)
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if sub.Status != models.StatusMRCreated {
		t.Fatalf("want MR_CREATED, got %s", sub.Status)
	}
	if mrs, _ := s.st.ListMRs(ctx, req.ID); len(mrs) != 1 {
		t.Fatalf("submit should open exactly one MR, got %d", len(mrs))
	}

	// A submitted order is no longer a draft, so it can't be submitted again.
	if _, err := s.prov.Submit(ctx, u, req.ID); err == nil {
		t.Fatalf("re-submit should fail")
	}

	// And it drives to HEALTHY like any other order.
	s.mergeLatestMR(ctx, t, req.ID)
	s.tick(ctx)
	s.tick(ctx)
	if got := mustStatus(ctx, t, s.st, req.ID); got != models.StatusHealthy {
		t.Fatalf("want HEALTHY, got %s", got)
	}
}

func TestDraftIdentityChange(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")

	// An existing active order occupies the identity "pg1".
	if _, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: validValues(),
	}); err != nil {
		t.Fatalf("create live: %v", err)
	}

	draft, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg2", Values: validValues(), Draft: true,
	})
	if err != nil {
		t.Fatalf("create draft: %v", err)
	}

	// Renaming the draft to a free identity works and recomputes the app name.
	upd, err := s.prov.Update(ctx, u, draft.ID, provisioning.UpdateInput{
		ServiceName: "pg3", Values: validValues(),
	})
	if err != nil {
		t.Fatalf("rename draft: %v", err)
	}
	if upd.ServiceName != "pg3" || upd.ArgoCDAppName != "core-pg3" {
		t.Fatalf("got service=%q app=%q", upd.ServiceName, upd.ArgoCDAppName)
	}

	// Renaming onto a taken identity conflicts.
	if _, err := s.prov.Update(ctx, u, draft.ID, provisioning.UpdateInput{
		ServiceName: "pg1", Values: validValues(),
	}); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
}

func TestPollerAutoMerge(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	c := cache.NewMemory()
	hb := harbor.NewFake()
	gl := gitlab.NewFake("managed-services", []string{"team-core"}, false) // no merge-on-create
	argo := argocd.NewFake(gl)
	cat := catalog.New(hb, c)
	gitops, err := provisioning.NewGitOps("managed-services", "team-{{.Team}}",
		"{{.Team}}-{{.ServiceName}}", "portal-managed", "main")
	if err != nil {
		t.Fatal(err)
	}
	prov := provisioning.New(st, gl, argo, cat, gitops, events.New(), "in-cluster", "main", true /* autoMerge */)
	s := &stack{prov, gl, argo, st, gitops}

	req, err := s.prov.Create(ctx, member("core"), provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: validValues(),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if req.Status != models.StatusMRCreated {
		t.Fatalf("want MR_CREATED, got %s", req.Status)
	}

	// No manual merge: the poller auto-merges the open MR and drives to HEALTHY.
	for i := 0; i < 6 && mustStatus(ctx, t, s.st, req.ID) != models.StatusHealthy; i++ {
		s.tick(ctx)
	}
	if got := mustStatus(ctx, t, s.st, req.ID); got != models.StatusHealthy {
		t.Fatalf("want HEALTHY via auto-merge, got %s", got)
	}
}

func mustStatus(ctx context.Context, t *testing.T, st store.Store, id string) models.RequestStatus {
	t.Helper()
	r, err := st.GetRequest(ctx, id)
	if err != nil {
		t.Fatalf("get request: %v", err)
	}
	return r.Status
}
