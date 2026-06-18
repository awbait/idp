package provisioning_test

import (
	"testing"

	"console/internal/provisioning"
)

func newGitOps(t *testing.T) *provisioning.GitOps {
	t.Helper()
	g, err := provisioning.NewGitOps("managed-services", "team-{{.Team}}",
		"{{.Team}}-{{.ServiceName}}", "portal-managed", "main")
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// TestInstancePathsIncludeCluster locks in the repo layout: {cluster}/{service}/...
func TestInstancePathsIncludeCluster(t *testing.T) {
	g := newGitOps(t)

	if got, want := g.InstanceDir("prod", "pg1"), "prod/pg1"; got != want {
		t.Errorf("InstanceDir = %q, want %q", got, want)
	}
	if got, want := g.AppPath("prod", "pg1"), "prod/pg1/application.yaml"; got != want {
		t.Errorf("AppPath = %q, want %q", got, want)
	}
	if got, want := g.ValuesPath("prod", "pg1"), "prod/pg1/values.yaml"; got != want {
		t.Errorf("ValuesPath = %q, want %q", got, want)
	}

	// Same service in different clusters lives in separate folders.
	if g.InstanceDir("dev", "pg1") == g.InstanceDir("prod", "pg1") {
		t.Error("instances in different clusters must not collide")
	}

	// Empty cluster falls back to the flat legacy layout.
	if got, want := g.AppPath("", "pg1"), "pg1/application.yaml"; got != want {
		t.Errorf("AppPath(empty cluster) = %q, want %q", got, want)
	}
}
