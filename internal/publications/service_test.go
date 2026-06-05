package publications_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"idp/internal/publications"
	"idp/internal/store"
	"idp/pkg/models"
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
	return publications.New(st), st
}

var viewV1 = json.RawMessage(`{"views":{"order":{"include":["gateways"]}}}`)
var viewV2 = json.RawMessage(`{"views":{"order":{"include":["gateways","naming"]}}}`)

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

	// дубль чарта запрещён
	if _, err := svc.Create(ctx, owner, publications.CreateInput{
		ChartProject: "platform", ChartName: "ingress-gateway",
		CategoryID: "network", OwnerTeam: "core",
	}); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("dup create: want conflict, got %v", err)
	}

	// черновик view
	if _, err := svc.Update(ctx, owner, p.ID, publications.UpdateInput{View: viewV1}); err != nil {
		t.Fatalf("update view: %v", err)
	}

	// submit → PENDING; правки заморожены
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

	// approve — только админ
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

	// активная view доступна
	view, err := svc.ActiveView(ctx, "platform", "ingress-gateway")
	if err != nil || string(view) != string(viewV1) {
		t.Fatalf("active view: %v %s", err, view)
	}

	// новый черновик поверх approved → submit → reject: approved живёт
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

	// правка после reject возвращает в DRAFT
	p, err = svc.Update(ctx, owner, p.ID, publications.UpdateInput{View: viewV2})
	if err != nil {
		t.Fatalf("update after reject: %v", err)
	}
	if p.Status != models.PubDraft {
		t.Fatalf("want DRAFT after edit, got %s", p.Status)
	}

	// аудит накопился
	evs, err := svc.ListEvents(ctx, p.ID)
	if err != nil || len(evs) < 6 {
		t.Fatalf("events: %v n=%d", err, len(evs))
	}
}

func TestCreateRBACAndValidation(t *testing.T) {
	ctx := context.Background()
	svc, _ := setup(t)

	// чужая команда
	if _, err := svc.Create(ctx, member("dbaas"), publications.CreateInput{
		ChartProject: "platform", ChartName: "x", CategoryID: "network", OwnerTeam: "core",
	}); !errors.Is(err, publications.ErrForbidden) {
		t.Fatalf("foreign team: want forbidden, got %v", err)
	}

	// несуществующая категория
	var ve *publications.ValidationError
	if _, err := svc.Create(ctx, member("core"), publications.CreateInput{
		ChartProject: "platform", ChartName: "x", CategoryID: "nope", OwnerTeam: "core",
	}); !errors.As(err, &ve) {
		t.Fatalf("unknown category: want validation error, got %v", err)
	}

	// submit без view
	p, err := svc.Create(ctx, member("core"), publications.CreateInput{
		ChartProject: "platform", ChartName: "x", CategoryID: "network", OwnerTeam: "core",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Submit(ctx, member("core"), p.ID); !errors.As(err, &ve) {
		t.Fatalf("submit empty view: want validation error, got %v", err)
	}

	// невалидный JSON в черновике
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

	// в свою вторую команду — можно
	to := "dbaas"
	if _, err := svc.Update(ctx, member("core", "dbaas"), p.ID, publications.UpdateInput{OwnerTeam: &to}); err != nil {
		t.Fatalf("handoff to own team: %v", err)
	}

	// участник новой команды управляет, старой — нет
	back := "payments"
	if _, err := svc.Update(ctx, member("dbaas"), p.ID, publications.UpdateInput{OwnerTeam: &back}); !errors.Is(err, publications.ErrForbidden) {
		t.Fatalf("handoff to foreign team: want forbidden, got %v", err)
	}
	if _, err := svc.Update(ctx, admin(), p.ID, publications.UpdateInput{OwnerTeam: &back}); err != nil {
		t.Fatalf("admin handoff anywhere: %v", err)
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

	// занятая категория не удаляется
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

	// повторный сид не перетирает правки
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
