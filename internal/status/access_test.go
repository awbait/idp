package status

import (
	"context"
	"errors"
	"testing"

	"idp/internal/argocd"
	"idp/pkg/models"
)

// seedApps returns a fake ArgoCD with one portal-managed app per team.
func seedApps() *argocd.Fake {
	f := argocd.NewFake(nil)
	f.Upsert(argocd.Application{Name: "core-pg1", Labels: map[string]string{"managed-by": "portal", "idp.team": "core"}})
	f.Upsert(argocd.Application{Name: "pay-gw", Labels: map[string]string{"managed-by": "portal", "idp.team": "payments"}})
	return f
}

func roleUser(role models.Role, teams ...string) *models.User {
	return &models.User{Subject: "u", Role: role, Teams: teams}
}

func TestListApplicationsScope(t *testing.T) {
	ctx := context.Background()
	svc := New(seedApps())

	cases := []struct {
		name string
		user *models.User
		want int
	}{
		{"admin sees all", roleUser(models.RoleAdmin), 2},
		{"support sees all", roleUser(models.RoleSupport), 2},
		{"member sees own team", roleUser(models.RoleMember, "core"), 1},
		{"security sees none", roleUser(models.RoleSecurity), 0},
		{"auditor sees none", roleUser(models.RoleAuditor), 0},
	}
	for _, c := range cases {
		apps, err := svc.ListApplications(ctx, c.user)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if len(apps) != c.want {
			t.Fatalf("%s: want %d apps, got %d", c.name, c.want, len(apps))
		}
	}
}

func TestGetApplicationScope(t *testing.T) {
	ctx := context.Background()
	svc := New(seedApps())

	// support fetches any team's app; a foreign member / security get 404.
	if _, err := svc.GetApplication(ctx, roleUser(models.RoleSupport), "pay-gw"); err != nil {
		t.Fatalf("support GetApplication should be allowed, got %v", err)
	}
	if _, err := svc.GetApplication(ctx, roleUser(models.RoleMember, "core"), "pay-gw"); !errors.Is(err, models.ErrNotFound) {
		t.Fatalf("foreign member want ErrNotFound, got %v", err)
	}
	if _, err := svc.GetApplication(ctx, roleUser(models.RoleSecurity), "pay-gw"); !errors.Is(err, models.ErrNotFound) {
		t.Fatalf("security want ErrNotFound, got %v", err)
	}
}
