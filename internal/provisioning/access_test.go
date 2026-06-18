package provisioning_test

import (
	"context"
	"errors"
	"testing"

	"console/internal/provisioning"
	"console/internal/store"
	"console/pkg/models"
)

func support() *models.User {
	return &models.User{Subject: "sup", Name: "Sam Support", Role: models.RoleSupport}
}
func security() *models.User {
	return &models.User{Subject: "sec", Name: "Ivy Security", Role: models.RoleSecurity}
}
func auditor() *models.User {
	return &models.User{Subject: "aud", Name: "Al Auditor", Role: models.RoleAuditor}
}

// seedOrder creates one live order owned by team "core".
func seedOrder(ctx context.Context, t *testing.T, s *stack) *models.Request {
	t.Helper()
	req, err := s.prov.Create(ctx, member("core"), provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: validValues(),
	})
	if err != nil {
		t.Fatalf("seed create: %v", err)
	}
	s.mergeLatestMR(ctx, t, req.ID)
	s.tick(ctx)
	s.tick(ctx)
	return req
}

// Support: views and edits orders of any team, but cannot create or delete.
func TestAccessSupport(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	req := seedOrder(ctx, t, s)
	sup := support()

	if _, err := s.prov.Get(ctx, sup, req.ID); err != nil {
		t.Fatalf("support Get should be allowed, got %v", err)
	}
	if _, err := s.prov.Update(ctx, sup, req.ID, provisioning.UpdateInput{Values: validValues()}); err != nil {
		t.Fatalf("support Update should be allowed, got %v", err)
	}
	if _, err := s.prov.Create(ctx, sup, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg2", Values: validValues(),
	}); !errors.Is(err, provisioning.ErrForbidden) {
		t.Fatalf("support Create want ErrForbidden, got %v", err)
	}
	if _, err := s.prov.Delete(ctx, sup, req.ID); !errors.Is(err, provisioning.ErrForbidden) {
		t.Fatalf("support Delete want ErrForbidden, got %v", err)
	}

	got, err := s.prov.List(ctx, sup, store.RequestFilter{})
	if err != nil {
		t.Fatalf("support List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("support should list all teams' orders, got %d", len(got))
	}
}

// Security and auditor have no team: no order access at all (Get denied, List empty).
func TestAccessNoScopeRoles(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	req := seedOrder(ctx, t, s)

	for _, u := range []*models.User{security(), auditor()} {
		if _, err := s.prov.Get(ctx, u, req.ID); !errors.Is(err, provisioning.ErrForbidden) {
			t.Fatalf("%s Get want ErrForbidden, got %v", u.Role, err)
		}
		got, err := s.prov.List(ctx, u, store.RequestFilter{})
		if err != nil {
			t.Fatalf("%s List: %v", u.Role, err)
		}
		if len(got) != 0 {
			t.Fatalf("%s List want empty, got %d", u.Role, len(got))
		}
	}
}

// A member of another team cannot see or change this team's order.
func TestAccessOtherTeamMember(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	req := seedOrder(ctx, t, s)
	other := member("payments")

	if _, err := s.prov.Get(ctx, other, req.ID); !errors.Is(err, provisioning.ErrForbidden) {
		t.Fatalf("other-team Get want ErrForbidden, got %v", err)
	}
	if _, err := s.prov.Update(ctx, other, req.ID, provisioning.UpdateInput{Values: validValues()}); !errors.Is(err, provisioning.ErrForbidden) {
		t.Fatalf("other-team Update want ErrForbidden, got %v", err)
	}
	if _, err := s.prov.Delete(ctx, other, req.ID); !errors.Is(err, provisioning.ErrForbidden) {
		t.Fatalf("other-team Delete want ErrForbidden, got %v", err)
	}
	got, err := s.prov.List(ctx, other, store.RequestFilter{})
	if err != nil {
		t.Fatalf("other-team List: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("other-team List want empty (no core orders), got %d", len(got))
	}
}
