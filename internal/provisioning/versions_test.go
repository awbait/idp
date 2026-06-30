package provisioning_test

import (
	"context"
	"errors"
	"testing"

	"console/internal/provisioning"
	"console/pkg/models"
)

// seedVersionedPub registers a version-managed publication (no legacy approved
// view) with a single orderable+APPROVED version carrying the given view.
func seedVersionedPub(t *testing.T, s *stack, project, name, orderableVersion string, view []byte) {
	t.Helper()
	ctx := context.Background()
	_ = s.st.CreateCategory(ctx, &models.Category{ID: "db", Label: "db"})
	pub := &models.ChartPublication{
		ID: "pub-" + name, ChartProject: project, ChartName: name,
		CategoryID: "db", OwnerTeam: "core", CreatedBy: "seed", Status: models.PubApproved,
	}
	if err := s.st.CreatePublication(ctx, pub); err != nil {
		t.Fatalf("create pub: %v", err)
	}
	v := &models.PublicationVersion{
		ID: "ver-" + orderableVersion, PublicationID: pub.ID, ChartVersion: orderableVersion,
		ApprovedViewJSON: view, Status: models.PubApproved, Orderable: true,
	}
	if err := s.st.UpsertVersion(ctx, v); err != nil {
		t.Fatalf("upsert version: %v", err)
	}
}

func TestOrderGuardRejectsNonOrderableVersion(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")
	view := []byte(`{"views":{"order":{"identity":"/auth/database","include":["auth"]}}}`)
	// Only 15.4.2 is orderable; 15.4.1 exists in Harbor but is not allowlisted.
	seedVersionedPub(t, s, "platform", "postgres", "15.4.2", view)

	_, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.1",
		Team: "core", ServiceName: "pg1", Values: validValues(), Draft: true,
	})
	var ve *provisioning.ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("non-orderable version: want ValidationError, got %v", err)
	}
}

func TestOrderUsesSelectedVersionView(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	u := member("core")
	// The order view's identity pointer resolves against the order values.
	view := []byte(`{"views":{"order":{"identity":"/auth/database","include":["auth"]}}}`)
	seedVersionedPub(t, s, "platform", "postgres", "15.4.2", view)

	req, err := s.prov.Create(ctx, u, provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: validValues(), Draft: true,
	})
	if err != nil {
		t.Fatalf("create orderable version: %v", err)
	}
	// resourceIdentity must come from the selected version's view (auth.database).
	if req.ResourceIdentity != "app" {
		t.Fatalf("resource identity from version view: want \"app\", got %q", req.ResourceIdentity)
	}
}
