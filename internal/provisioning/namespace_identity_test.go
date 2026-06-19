package provisioning_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"console/internal/provisioning"
	"console/pkg/models"
)

// seedView registers an approved order view for platform/<chart> so the
// provisioning layer can resolve the resource identity from order values.
func seedView(ctx context.Context, t *testing.T, s *stack, chart, identityPtr string) {
	t.Helper()
	view := json.RawMessage(`{"views":{"order":{"identity":"` + identityPtr + `"}}}`)
	p := &models.ChartPublication{
		ID:               "pub-" + chart,
		ChartProject:     "platform",
		ChartName:        chart,
		Status:           models.PubApproved,
		ApprovedViewJSON: view,
	}
	if err := s.st.CreatePublication(ctx, p); err != nil {
		t.Fatalf("seed publication: %v", err)
	}
}

func draft(db string) map[string]any {
	return map[string]any{"auth": map[string]any{"database": db}}
}

// TestNamespaceIdentityCollision: two orders of one chart that resolve to the
// same identity in the same namespace must conflict, even with distinct
// service_names (their rendered resources would collide). A different identity
// or a different namespace is allowed.
func TestNamespaceIdentityCollision(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")
	// identity = the auth.database value (a stand-in for gateways[0].name).
	seedView(ctx, t, s, "postgres", "/auth/database")

	mk := func(service, ns, db string) (*models.Request, error) {
		return s.prov.Create(ctx, u, provisioning.CreateInput{
			ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
			Team: "core", ServiceName: service, Namespace: ns, Values: draft(db), Draft: true,
		})
	}

	a, err := mk("alpha", "shared", "app")
	if err != nil {
		t.Fatalf("create alpha: %v", err)
	}
	if a.ResourceIdentity != "app" {
		t.Fatalf("resource identity = %q, want %q", a.ResourceIdentity, "app")
	}

	// Same identity ("app") in the same namespace -> conflict, despite a distinct service.
	if _, err := mk("bravo", "shared", "app"); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("want conflict for duplicate identity, got %v", err)
	}

	// Different identity in the same namespace -> allowed.
	if _, err := mk("charlie", "shared", "other"); err != nil {
		t.Fatalf("different identity must be allowed, got %v", err)
	}

	// Same identity in a different namespace -> allowed.
	if _, err := mk("delta", "elsewhere", "app"); err != nil {
		t.Fatalf("same identity in another namespace must be allowed, got %v", err)
	}
}

// TestNamespaceIdentityFallback: with no published view the identity falls back
// to service_name, so distinct services in one namespace do not falsely collide.
func TestNamespaceIdentityFallback(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")

	mk := func(service string) error {
		_, err := s.prov.Create(ctx, u, provisioning.CreateInput{
			ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
			Team: "core", ServiceName: service, Namespace: "shared", Values: draft("app"), Draft: true,
		})
		return err
	}
	if err := mk("alpha"); err != nil {
		t.Fatalf("create alpha: %v", err)
	}
	if err := mk("bravo"); err != nil {
		t.Fatalf("distinct service must not collide on fallback identity, got %v", err)
	}
}
