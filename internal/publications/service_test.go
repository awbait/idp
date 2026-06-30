package publications_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"console/internal/publications"
	"console/internal/store"
	"console/pkg/models"
)

func member(teams ...string) *models.User {
	return &models.User{Subject: "u-member", Name: "Member", Teams: teams, Role: models.RoleMember}
}

func admin() *models.User {
	return &models.User{Subject: "u-admin", Name: "Admin", Role: models.RoleAdmin}
}

func setup(t *testing.T) (*publications.Service, *store.Memory) {
	t.Helper()
	st := store.NewMemory()
	if err := st.CreateCategory(context.Background(), &models.Category{ID: "network", Label: "Сеть"}); err != nil {
		t.Fatal(err)
	}
	return publications.New(st, nil), st
}

var viewV1 = json.RawMessage(`{"views":{"order":{"identity":"/gateways/0/name","include":["gateways"]}}}`)
var viewV2 = json.RawMessage(`{"views":{"order":{"identity":"/gateways/0/name","include":["gateways","naming"]}}}`)

func TestPublicationLifecycle(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	owner := member("core")

	p, err := svc.Create(ctx, owner, publications.CreateInput{
		ChartProject: "platform", ChartName: "ingress-gateway",
		CategoryID: "network", OwnerTeam: "core",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if p.Status != models.PubDraft {
		t.Fatalf("want DRAFT, got %s", p.Status)
	}

	// duplicate chart is forbidden
	if _, err := svc.Create(ctx, owner, publications.CreateInput{
		ChartProject: "platform", ChartName: "ingress-gateway",
		CategoryID: "network", OwnerTeam: "core",
	}); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("dup create: want conflict, got %v", err)
	}

	// view draft
	if _, err := svc.Update(ctx, owner, p.ID, publications.UpdateInput{View: viewV1}); err != nil {
		t.Fatalf("update view: %v", err)
	}

	// submit -> PENDING; edits frozen
	p, err = svc.Submit(ctx, owner, p.ID)
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if p.Status != models.PubPending {
		t.Fatalf("want PENDING, got %s", p.Status)
	}
	if _, err := svc.Update(ctx, owner, p.ID, publications.UpdateInput{View: viewV2}); !errors.Is(err, publications.ErrPendingLocked) {
		t.Fatalf("update while pending: want ErrPendingLocked, got %v", err)
	}
	if _, err := svc.Submit(ctx, owner, p.ID); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("double submit: want conflict, got %v", err)
	}

	// approve, admin only
	if _, err := svc.Approve(ctx, owner, p.ID); !errors.Is(err, publications.ErrForbidden) {
		t.Fatalf("member approve: want forbidden, got %v", err)
	}
	p, err = svc.Approve(ctx, admin(), p.ID)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if p.Status != models.PubApproved || !p.Published() {
		t.Fatalf("want APPROVED+published, got %s published=%v", p.Status, p.Published())
	}
	if string(p.ApprovedViewJSON) != string(viewV1) {
		t.Fatalf("approved view mismatch: %s", p.ApprovedViewJSON)
	}

	// active view is available
	view, err := svc.ActiveView(ctx, "platform", "ingress-gateway")
	if err != nil || string(view) != string(viewV1) {
		t.Fatalf("active view: %v %s", err, view)
	}

	// new draft on top of approved -> submit -> reject: approved survives
	if _, err := svc.Update(ctx, owner, p.ID, publications.UpdateInput{View: viewV2}); err != nil {
		t.Fatalf("update v2: %v", err)
	}
	if _, err := svc.Submit(ctx, owner, p.ID); err != nil {
		t.Fatalf("submit v2: %v", err)
	}
	p, err = svc.Reject(ctx, admin(), p.ID, "наполните include")
	if err != nil {
		t.Fatalf("reject: %v", err)
	}
	if p.Status != models.PubRejected || p.ReviewComment != "наполните include" {
		t.Fatalf("want REJECTED+comment, got %s %q", p.Status, p.ReviewComment)
	}
	if string(p.ApprovedViewJSON) != string(viewV1) {
		t.Fatalf("approved view must survive reject: %s", p.ApprovedViewJSON)
	}

	// edit after reject returns to DRAFT
	p, err = svc.Update(ctx, owner, p.ID, publications.UpdateInput{View: viewV2})
	if err != nil {
		t.Fatalf("update after reject: %v", err)
	}
	if p.Status != models.PubDraft {
		t.Fatalf("want DRAFT after edit, got %s", p.Status)
	}

	// audit accumulated
	evs, err := svc.ListEvents(ctx, p.ID)
	if err != nil || len(evs) < 6 {
		t.Fatalf("events: %v n=%d", err, len(evs))
	}
}

func TestWithdraw(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)
	owner := member("core")

	p, err := svc.Create(ctx, owner, publications.CreateInput{
		ChartProject: "platform", ChartName: "x", CategoryID: "network", OwnerTeam: "core",
	})
	if err != nil {
		t.Fatal(err)
	}

	// not from review, conflict
	if _, err := svc.Withdraw(ctx, owner, p.ID); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("withdraw from draft: want conflict, got %v", err)
	}

	if _, err := svc.Update(ctx, owner, p.ID, publications.UpdateInput{View: viewV1}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Submit(ctx, owner, p.ID); err != nil {
		t.Fatal(err)
	}

	// foreign, not allowed
	if _, err := svc.Withdraw(ctx, member("dbaas"), p.ID); !errors.Is(err, publications.ErrForbidden) {
		t.Fatalf("foreign withdraw: want forbidden, got %v", err)
	}

	// owner withdraws -> DRAFT, edits open again
	p, err = svc.Withdraw(ctx, owner, p.ID)
	if err != nil {
		t.Fatalf("withdraw: %v", err)
	}
	if p.Status != models.PubDraft {
		t.Fatalf("want DRAFT after withdraw, got %s", p.Status)
	}
	if _, err := svc.Update(ctx, owner, p.ID, publications.UpdateInput{View: viewV2}); err != nil {
		t.Fatalf("edit after withdraw: %v", err)
	}
}

func TestCreateRBACAndValidation(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)

	// foreign team
	if _, err := svc.Create(ctx, member("dbaas"), publications.CreateInput{
		ChartProject: "platform", ChartName: "x", CategoryID: "network", OwnerTeam: "core",
	}); !errors.Is(err, publications.ErrForbidden) {
		t.Fatalf("foreign team: want forbidden, got %v", err)
	}

	// nonexistent category
	var ve *publications.ValidationError
	if _, err := svc.Create(ctx, member("core"), publications.CreateInput{
		ChartProject: "platform", ChartName: "x", CategoryID: "nope", OwnerTeam: "core",
	}); !errors.As(err, &ve) {
		t.Fatalf("unknown category: want validation error, got %v", err)
	}

	// submit without view
	p, err := svc.Create(ctx, member("core"), publications.CreateInput{
		ChartProject: "platform", ChartName: "x", CategoryID: "network", OwnerTeam: "core",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Submit(ctx, member("core"), p.ID); !errors.As(err, &ve) {
		t.Fatalf("submit empty view: want validation error, got %v", err)
	}

	// invalid JSON in the draft
	if _, err := svc.Update(ctx, member("core"), p.ID, publications.UpdateInput{
		View: json.RawMessage(`{broken`),
	}); !errors.As(err, &ve) {
		t.Fatalf("broken view: want validation error, got %v", err)
	}
}

func TestOwnerTeamHandoff(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)

	p, err := svc.Create(ctx, member("core", "dbaas"), publications.CreateInput{
		ChartProject: "platform", ChartName: "x", CategoryID: "network", OwnerTeam: "core",
	})
	if err != nil {
		t.Fatal(err)
	}

	// a non-owner cannot even propose a transfer
	to := "dbaas"
	if _, err := svc.Update(ctx, member("dbaas"), p.ID, publications.UpdateInput{OwnerTeam: &to}); !errors.Is(err, publications.ErrForbidden) {
		t.Fatalf("non-owner propose: want forbidden, got %v", err)
	}

	// can propose only to your own team; an admin, to any
	payments := "payments"
	if _, err := svc.Update(ctx, member("core"), p.ID, publications.UpdateInput{OwnerTeam: &payments}); !errors.Is(err, publications.ErrForbidden) {
		t.Fatalf("propose to foreign team: want forbidden, got %v", err)
	}
	if _, err := svc.Update(ctx, admin(), p.ID, publications.UpdateInput{OwnerTeam: &payments}); err != nil {
		t.Fatalf("admin propose anywhere: %v", err)
	}

	// owner proposes a transfer to their second team: this is only a draft,
	// the live owner does not change until approval
	p, err = svc.Update(ctx, member("core", "dbaas"), p.ID, publications.UpdateInput{OwnerTeam: &to})
	if err != nil {
		t.Fatalf("propose handoff: %v", err)
	}
	if p.OwnerTeam != "core" || p.DraftOwnerTeam != "dbaas" {
		t.Fatalf("handoff must be pending: owner=%s draft=%q", p.OwnerTeam, p.DraftOwnerTeam)
	}

	// applied only after approval
	if _, err := svc.Submit(ctx, member("core"), p.ID); err != nil {
		t.Fatalf("submit: %v", err)
	}
	p, err = svc.Approve(ctx, admin(), p.ID)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if p.OwnerTeam != "dbaas" || p.DraftOwnerTeam != "" {
		t.Fatalf("handoff must apply on approve: owner=%s draft=%q", p.OwnerTeam, p.DraftOwnerTeam)
	}
}

// fakeSchemas - schema/version source for testing the ApprovedViewVersion stamp.
type fakeSchemas struct{ version string }

func (f fakeSchemas) GetSchema(context.Context, string, string, string) ([]byte, error) {
	return nil, nil
}
func (f fakeSchemas) LatestSchema(context.Context, string, string) ([]byte, error) { return nil, nil }
func (f fakeSchemas) LatestVersion(context.Context, string, string) (string, error) {
	return f.version, nil
}
func (f fakeSchemas) LatestDescription(context.Context, string, string) (string, error) {
	return "", nil
}
func (f fakeSchemas) LatestIcon(context.Context, string, string) (string, error) {
	return "", nil
}

func TestApproveStampsViewVersion(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()
	if err := st.CreateCategory(ctx, &models.Category{ID: "network", Label: "Сеть"}); err != nil {
		t.Fatal(err)
	}
	svc := publications.New(st, fakeSchemas{version: "2.0.0"})
	owner := member("core")

	p, err := svc.Create(ctx, owner, publications.CreateInput{
		ChartProject: "platform", ChartName: "ingress-gateway", CategoryID: "network", OwnerTeam: "core",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Update(ctx, owner, p.ID, publications.UpdateInput{View: viewV1}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Submit(ctx, owner, p.ID); err != nil {
		t.Fatal(err)
	}
	p, err = svc.Approve(ctx, admin(), p.ID)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if p.ApprovedViewVersion != "2.0.0" {
		t.Fatalf("approve must stamp view version: got %q", p.ApprovedViewVersion)
	}
}

func TestMetadataApproval(t *testing.T) {
	ctx := context.Background()
	svc, st := setup(t)
	if err := st.CreateCategory(ctx, &models.Category{ID: "databases", Label: "Базы"}); err != nil {
		t.Fatal(err)
	}
	owner := member("core")

	p, err := svc.Create(ctx, owner, publications.CreateInput{
		ChartProject: "platform", ChartName: "pg", CategoryID: "network", OwnerTeam: "core",
	})
	if err != nil {
		t.Fatal(err)
	}

	// a category change is not applied immediately: only a draft
	to := "databases"
	p, err = svc.Update(ctx, owner, p.ID, publications.UpdateInput{CategoryID: &to})
	if err != nil {
		t.Fatalf("propose category: %v", err)
	}
	if p.CategoryID != "network" || p.DraftCategoryID != "databases" {
		t.Fatalf("category must be pending: live=%s draft=%q", p.CategoryID, p.DraftCategoryID)
	}

	// reverting to the approved value clears the draft
	back := "network"
	p, err = svc.Update(ctx, owner, p.ID, publications.UpdateInput{CategoryID: &back})
	if err != nil {
		t.Fatalf("revert category: %v", err)
	}
	if p.DraftCategoryID != "" {
		t.Fatalf("revert must clear draft, got %q", p.DraftCategoryID)
	}

	// propose and approve again (without view: only metadata is approved)
	if _, err := svc.Update(ctx, owner, p.ID, publications.UpdateInput{CategoryID: &to}); err != nil {
		t.Fatalf("re-propose: %v", err)
	}
	if _, err := svc.Submit(ctx, owner, p.ID); err != nil {
		t.Fatalf("submit meta-only: %v", err)
	}
	p, err = svc.Approve(ctx, admin(), p.ID)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if p.CategoryID != "databases" || p.DraftCategoryID != "" {
		t.Fatalf("category must apply on approve: live=%s draft=%q", p.CategoryID, p.DraftCategoryID)
	}
}

func TestCategoriesRBAC(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)

	if err := svc.CreateCategory(ctx, member("core"), &models.Category{ID: "db", Label: "Базы"}); !errors.Is(err, publications.ErrForbidden) {
		t.Fatalf("member create category: want forbidden, got %v", err)
	}
	if err := svc.CreateCategory(ctx, admin(), &models.Category{ID: "db", Label: "Базы"}); err != nil {
		t.Fatalf("admin create category: %v", err)
	}

	// a referenced category is not deleted
	if _, err := svc.Create(ctx, member("core"), publications.CreateInput{
		ChartProject: "platform", ChartName: "pg", CategoryID: "db", OwnerTeam: "core",
	}); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteCategory(ctx, admin(), "db"); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("delete referenced category: want conflict, got %v", err)
	}
	if err := svc.DeleteCategory(ctx, admin(), "network"); err != nil {
		t.Fatalf("delete free category: %v", err)
	}
}

func TestSeedIdempotent(t *testing.T) {
	ctx := context.Background()
	st := store.NewMemory()

	if err := store.SeedPublications(ctx, st); err != nil {
		t.Fatalf("seed: %v", err)
	}
	p, err := st.GetPublicationByChart(ctx, "platform", "ingress-gateway")
	if err != nil {
		t.Fatalf("seeded pub: %v", err)
	}
	if p.Status != models.PubApproved || !p.Published() {
		t.Fatalf("seed must be approved+published, got %s", p.Status)
	}

	// a repeat seed does not overwrite edits
	p.CategoryID = "databases"
	if err := st.UpdatePublication(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := store.SeedPublications(ctx, st); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	p2, _ := st.GetPublicationByChart(ctx, "platform", "ingress-gateway")
	if p2.CategoryID != "databases" {
		t.Fatalf("re-seed overwrote user edit: %s", p2.CategoryID)
	}
}
