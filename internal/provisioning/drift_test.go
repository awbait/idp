package provisioning_test

import (
	"context"
	"strings"
	"testing"

	"console/internal/gitlab"
	"console/internal/provisioning"
	"console/pkg/models"
)

// drives a fresh order (core/pg1) to HEALTHY so its manifests live on the
// default branch and drift checks are meaningful.
func healthyOrder(ctx context.Context, t *testing.T, s *stack) *models.Request {
	t.Helper()
	req, err := s.prov.Create(ctx, member("core"), provisioning.CreateInput{
		ChartProject: "platform", ChartName: "postgres", Version: "15.4.2",
		Team: "core", ServiceName: "pg1", Values: validValues(),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	s.mergeLatestMR(ctx, t, req.ID)
	s.tick(ctx) // -> DEPLOYING
	s.tick(ctx) // -> HEALTHY
	if got := mustStatus(ctx, t, s.st, req.ID); got != models.StatusHealthy {
		t.Fatalf("want HEALTHY, got %s", got)
	}
	return req
}

func TestCheckDrift(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	req := healthyOrder(ctx, t, s)

	// 1) freshly provisioned by the portal => no drift.
	if err := s.prov.CheckDrift(ctx); err != nil {
		t.Fatalf("CheckDrift: %v", err)
	}
	if r, _ := s.st.GetRequest(ctx, req.ID); r.Drifted {
		t.Fatalf("expected no drift right after provisioning, got %q", r.DriftDetail)
	}

	// Resolve the repo + instance paths the portal committed to.
	proj, err := s.gl.GetProject(ctx, "managed-services/team-core/postgres")
	if err != nil {
		t.Fatalf("GetProject: %v", err)
	}
	const valuesPath = "in-cluster/pg1/values.yaml"
	const appPath = "in-cluster/pg1/application.yaml"

	// 2) someone edits values.yaml directly in Git => drift detected.
	commit(ctx, t, s.gl, proj.ID, valuesPath, "auth:\n  database: HACKED\n")
	if err := s.prov.CheckDrift(ctx); err != nil {
		t.Fatalf("CheckDrift: %v", err)
	}
	r, _ := s.st.GetRequest(ctx, req.ID)
	if !r.Drifted || !strings.Contains(r.DriftDetail, "values.yaml") {
		t.Fatalf("expected values drift, got drifted=%v detail=%q", r.Drifted, r.DriftDetail)
	}

	// 3) revert values to a YAML-equal form (reformatted) => drift clears, proving
	// the compare is semantic, not byte-for-byte.
	commit(ctx, t, s.gl, proj.ID, valuesPath, "auth: {database: app}\n")
	if err := s.prov.CheckDrift(ctx); err != nil {
		t.Fatalf("CheckDrift: %v", err)
	}
	if r, _ := s.st.GetRequest(ctx, req.ID); r.Drifted {
		t.Fatalf("expected drift cleared after semantic-equal revert, got %q", r.DriftDetail)
	}

	// 4) bump the chart version in application.yaml => version drift detected.
	app, err := s.gl.GetFile(ctx, proj.ID, appPath, "main")
	if err != nil {
		t.Fatalf("read app: %v", err)
	}
	commit(ctx, t, s.gl, proj.ID, appPath, strings.ReplaceAll(string(app), "15.4.2", "99.9.9"))
	if err := s.prov.CheckDrift(ctx); err != nil {
		t.Fatalf("CheckDrift: %v", err)
	}
	if r, _ := s.st.GetRequest(ctx, req.ID); !r.Drifted || !strings.Contains(r.DriftDetail, "99.9.9") {
		t.Fatalf("expected version drift, got drifted=%v detail=%q", r.Drifted, r.DriftDetail)
	}
}

func commit(ctx context.Context, t *testing.T, gl *gitlab.Fake, projectID int, path, content string) {
	t.Helper()
	if err := gl.CommitFiles(ctx, projectID, "main", "edit", []gitlab.FileAction{
		{Action: "update", FilePath: path, Content: content},
	}); err != nil {
		t.Fatalf("commit %s: %v", path, err)
	}
}
