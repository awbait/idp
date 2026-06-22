package provisioning_test

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"console/internal/provisioning"
	"console/pkg/models"
)

func newGitOps(t *testing.T) *provisioning.GitOps {
	t.Helper()
	g, err := provisioning.NewGitOps("managed-services", "team-{{.Team}}",
		"{{.Team}}-{{.Chart}}-{{.ServiceName}}", "portal-managed", "main")
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

// TestRenderApplicationEscapesScalars: a field carrying a YAML-injection payload
// must not break the manifest structure (L12). Normal values stay bare.
func TestRenderApplicationEscapesScalars(t *testing.T) {
	g := newGitOps(t)

	// Malicious chart version trying to inject a sibling key + a destructive
	// syncPolicy. After escaping it must remain a plain string value.
	r := &models.Request{
		Team: "core", ChartName: "postgres", ServiceName: "pg1", ChartVersion: "1.0\ninjected: true",
		Cluster: "in-cluster", Namespace: "apps", ArgoCDAppName: "core-postgres-pg1",
	}
	out, err := g.RenderApplication(r, "https://gitlab/managed-services/team-core/postgres")
	if err != nil {
		t.Fatalf("RenderApplication: %v", err)
	}

	// Must still parse as a single valid YAML document with no injected top-level key.
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("rendered manifest is not valid YAML: %v\n%s", err, out)
	}
	if _, injected := doc["injected"]; injected {
		t.Fatalf("YAML injection succeeded:\n%s", out)
	}

	// A normal version is emitted bare (no churn / unnecessary quoting).
	r.ChartVersion = "3.1.0"
	out, _ = g.RenderApplication(r, "https://gitlab/x.git")
	if !strings.Contains(out, "targetRevision: 3.1.0") {
		t.Fatalf("normal version should be bare:\n%s", out)
	}
}
