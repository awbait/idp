package provisioning_test

import (
	"context"
	"strings"
	"testing"

	"console/pkg/models"
)

func TestPullFromGit(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)
	req := healthyOrder(ctx, t, s)
	u := member("core")

	proj, err := s.gl.GetProject(ctx, "managed-services/team-core/postgres")
	if err != nil {
		t.Fatalf("GetProject: %v", err)
	}

	// Someone edits values.yaml directly in Git, then the portal pulls it in.
	commit(ctx, t, s.gl, proj.ID, "in-cluster/pg1/values.yaml", "auth:\n  database: changed_in_git\n")
	if err := s.prov.CheckDrift(ctx); err != nil {
		t.Fatalf("CheckDrift: %v", err)
	}
	if r, _ := s.st.GetRequest(ctx, req.ID); !r.Drifted {
		t.Fatalf("expected drift before pull")
	}

	pulled, err := s.prov.PullFromGit(ctx, u, req.ID)
	if err != nil {
		t.Fatalf("PullFromGit: %v", err)
	}
	if pulled.Drifted {
		t.Fatalf("drift should clear after pull")
	}
	if !strings.Contains(pulled.ValuesYAML, "changed_in_git") {
		t.Fatalf("portal values not adopted from git: %q", pulled.ValuesYAML)
	}

	// Persisted + drift cleared + a git_pulled event recorded.
	r, _ := s.st.GetRequest(ctx, req.ID)
	if r.Drifted || !strings.Contains(r.ValuesYAML, "changed_in_git") {
		t.Fatalf("pull not persisted: drifted=%v values=%q", r.Drifted, r.ValuesYAML)
	}
	events, _ := s.st.ListEvents(ctx, req.ID)
	if !hasEvent(events, "git_pulled") {
		t.Fatalf("git_pulled event not recorded: %+v", events)
	}
}

func hasEvent(events []*models.RequestEvent, typ string) bool {
	for _, e := range events {
		if e.EventType == typ {
			return true
		}
	}
	return false
}
