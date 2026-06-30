package publications_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"console/internal/publications"
	"console/pkg/models"
)

// newPub creates an approved-less publication owned by team "core".
func newPub(t *testing.T, svc *publications.Service, owner *models.User, name string) *models.ChartPublication {
	t.Helper()
	p, err := svc.Create(context.Background(), owner, publications.CreateInput{
		ChartProject: "platform", ChartName: name, CategoryID: "network", OwnerTeam: "core",
	})
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	return p
}

// publishVersion drives a version through DRAFT -> APPROVED -> orderable.
func publishVersion(t *testing.T, svc *publications.Service, owner *models.User, pubID, cv string, view json.RawMessage) {
	t.Helper()
	ctx := context.Background()
	if _, err := svc.SaveVersionView(ctx, owner, pubID, cv, view); err != nil {
		t.Fatalf("save %s: %v", cv, err)
	}
	if _, err := svc.SubmitVersion(ctx, owner, pubID, cv); err != nil {
		t.Fatalf("submit %s: %v", cv, err)
	}
	if _, err := svc.ApproveVersion(ctx, admin(), pubID, cv); err != nil {
		t.Fatalf("approve %s: %v", cv, err)
	}
	if _, err := svc.SetVersionOrderable(ctx, owner, pubID, cv, true); err != nil {
		t.Fatalf("orderable %s: %v", cv, err)
	}
}

func TestVersionLifecycle(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	owner := member("core")
	p := newPub(t, svc, owner, "ingress-gateway")

	v, err := svc.SaveVersionView(ctx, owner, p.ID, "1.0.0", viewV1)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if v.Status != models.PubDraft {
		t.Fatalf("want DRAFT, got %s", v.Status)
	}

	if _, err := svc.SubmitVersion(ctx, owner, p.ID, "1.0.0"); err != nil {
		t.Fatalf("submit: %v", err)
	}
	// A pending version is locked for edits.
	if _, err := svc.SaveVersionView(ctx, owner, p.ID, "1.0.0", viewV2); !errors.Is(err, publications.ErrPendingLocked) {
		t.Fatalf("edit pending: want ErrPendingLocked, got %v", err)
	}

	v, err = svc.ApproveVersion(ctx, admin(), p.ID, "1.0.0")
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if v.Status != models.PubApproved || len(v.ApprovedViewJSON) == 0 {
		t.Fatalf("approve must set approved view: %+v", v)
	}
	// Approved but not yet allowlisted: not orderable.
	if v.Orderable || v.Published() {
		t.Fatalf("freshly approved version must not be orderable")
	}

	v, err = svc.SetVersionOrderable(ctx, owner, p.ID, "1.0.0", true)
	if err != nil {
		t.Fatalf("orderable: %v", err)
	}
	if !v.Published() {
		t.Fatalf("orderable+approved version must be published")
	}
}

func TestVersionOrderableGuard(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	owner := member("core")
	p := newPub(t, svc, owner, "ingress-gateway")

	if _, err := svc.SaveVersionView(ctx, owner, p.ID, "1.0.0", viewV1); err != nil {
		t.Fatal(err)
	}
	// A draft (non-approved) version can't be allowlisted.
	if _, err := svc.SetVersionOrderable(ctx, owner, p.ID, "1.0.0", true); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("orderable on draft: want conflict, got %v", err)
	}
}

func TestVersionReworkAfterReject(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	owner := member("core")
	p := newPub(t, svc, owner, "ingress-gateway")

	if _, err := svc.SaveVersionView(ctx, owner, p.ID, "1.0.0", viewV1); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitVersion(ctx, owner, p.ID, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	v, err := svc.RejectVersion(ctx, admin(), p.ID, "1.0.0", "fix identity")
	if err != nil {
		t.Fatalf("reject: %v", err)
	}
	if v.Status != models.PubRejected || v.ReviewComment != "fix identity" {
		t.Fatalf("unexpected rejected version: %+v", v)
	}
	// Editing a rejected version returns it to DRAFT.
	v, err = svc.SaveVersionView(ctx, owner, p.ID, "1.0.0", viewV2)
	if err != nil {
		t.Fatalf("rework: %v", err)
	}
	if v.Status != models.PubDraft {
		t.Fatalf("rework must return to DRAFT, got %s", v.Status)
	}
}

func TestVersionsAreIndependent(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	owner := member("core")
	p := newPub(t, svc, owner, "ingress-gateway")

	publishVersion(t, svc, owner, p.ID, "1.0.0", viewV1)
	// Approving a second version must not touch the first one's approved view.
	publishVersion(t, svc, owner, p.ID, "2.0.0", viewV2)

	v1, err := svc.ActiveViewVersion(ctx, "platform", "ingress-gateway", "1.0.0")
	if err != nil {
		t.Fatalf("active v1: %v", err)
	}
	if string(v1) != string(viewV1) {
		t.Fatalf("v1 view changed: %s", v1)
	}
	v2, err := svc.ActiveViewVersion(ctx, "platform", "ingress-gateway", "2.0.0")
	if err != nil {
		t.Fatalf("active v2: %v", err)
	}
	if string(v2) != string(viewV2) {
		t.Fatalf("v2 view wrong: %s", v2)
	}

	list, err := svc.ListVersions(ctx, p.ID)
	if err != nil || len(list) != 2 {
		t.Fatalf("want 2 versions, got %d (%v)", len(list), err)
	}
}

func TestRecommendedAndFallback(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	owner := member("core")
	p := newPub(t, svc, owner, "ingress-gateway")

	publishVersion(t, svc, owner, p.ID, "1.0.0", viewV1)
	publishVersion(t, svc, owner, p.ID, "1.5.0", viewV1)
	publishVersion(t, svc, owner, p.ID, "2.0.0", viewV2)

	// No recommended set: fall back to the highest orderable+APPROVED version.
	v, err := svc.ActiveViewVersion(ctx, "platform", "ingress-gateway", "")
	if err != nil {
		t.Fatalf("fallback: %v", err)
	}
	if string(v) != string(viewV2) {
		t.Fatalf("fallback must pick 2.0.0, got %s", v)
	}

	// Explicit recommended wins over the highest.
	if err := svc.SetRecommendedVersion(ctx, owner, p.ID, "1.5.0"); err != nil {
		t.Fatalf("set recommended: %v", err)
	}
	v, err = svc.ActiveViewVersion(ctx, "platform", "ingress-gateway", "")
	if err != nil {
		t.Fatalf("recommended: %v", err)
	}
	if string(v) != string(viewV1) {
		t.Fatalf("recommended 1.5.0 should serve viewV1, got %s", v)
	}
}

func TestRecommendedRequiresOrderable(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	owner := member("core")
	p := newPub(t, svc, owner, "ingress-gateway")

	// Approved but not orderable -> can't be recommended.
	if _, err := svc.SaveVersionView(ctx, owner, p.ID, "1.0.0", viewV1); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitVersion(ctx, owner, p.ID, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ApproveVersion(ctx, admin(), p.ID, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := svc.SetRecommendedVersion(ctx, owner, p.ID, "1.0.0"); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("recommend non-orderable: want conflict, got %v", err)
	}
}

func TestActiveViewVersionNotOrderable(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	owner := member("core")
	p := newPub(t, svc, owner, "ingress-gateway")

	// Approved, not allowlisted: order form must not resolve it.
	if _, err := svc.SaveVersionView(ctx, owner, p.ID, "1.0.0", viewV1); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitVersion(ctx, owner, p.ID, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ApproveVersion(ctx, admin(), p.ID, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ActiveViewVersion(ctx, "platform", "ingress-gateway", "1.0.0"); !errors.Is(err, models.ErrNotFound) {
		t.Fatalf("non-orderable view: want ErrNotFound, got %v", err)
	}
}

func TestVersionRBAC(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	owner := member("core")
	p := newPub(t, svc, owner, "ingress-gateway")
	other := member("other")

	if _, err := svc.SaveVersionView(ctx, other, p.ID, "1.0.0", viewV1); !errors.Is(err, publications.ErrForbidden) {
		t.Fatalf("foreign save: want forbidden, got %v", err)
	}
	if _, err := svc.SaveVersionView(ctx, owner, p.ID, "1.0.0", viewV1); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitVersion(ctx, owner, p.ID, "1.0.0"); err != nil {
		t.Fatal(err)
	}
	// Only an admin approves.
	if _, err := svc.ApproveVersion(ctx, owner, p.ID, "1.0.0"); !errors.Is(err, publications.ErrForbidden) {
		t.Fatalf("owner approve: want forbidden, got %v", err)
	}
}
