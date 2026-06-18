package provisioning_test

import (
	"context"
	"testing"

	"console/internal/gitlab"
	"console/pkg/models"
)

// When an order's manifests are already gone from Git (e.g. an imported order
// whose files were removed externally), Delete must close it out directly instead
// of opening a delete MR for files that don't exist (which GitLab 400s on).
func TestDeleteWhenGitFilesMissing(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	req := healthyOrder(ctx, t, s)
	u := member("core")

	proj, err := s.gl.GetProject(ctx, "managed-services/team-core/postgres")
	if err != nil {
		t.Fatalf("GetProject: %v", err)
	}
	// Wipe the instance's files directly in Git (simulate external removal).
	if err := s.gl.CommitFiles(ctx, proj.ID, "main", "remove", []gitlab.FileAction{
		{Action: "delete", FilePath: "in-cluster/pg1/application.yaml"},
		{Action: "delete", FilePath: "in-cluster/pg1/values.yaml"},
	}); err != nil {
		t.Fatalf("wipe files: %v", err)
	}

	mrsBefore, _ := s.st.ListMRs(ctx, req.ID)

	out, err := s.prov.Delete(ctx, u, req.ID)
	if err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if out.Status != models.StatusDeleted || out.DeletedAt == nil {
		t.Fatalf("want DELETED with deleted_at, got status=%s deletedAt=%v", out.Status, out.DeletedAt)
	}
	// No delete MR should have been opened (nothing to remove in Git).
	mrsAfter, _ := s.st.ListMRs(ctx, req.ID)
	if len(mrsAfter) != len(mrsBefore) {
		t.Fatalf("expected no new MR, had %d now %d", len(mrsBefore), len(mrsAfter))
	}
}
