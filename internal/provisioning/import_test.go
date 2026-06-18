package provisioning_test

import (
	"context"
	"testing"

	"console/internal/gitlab"
	"console/internal/store"
	"console/pkg/models"
)

// makeRepoByID creates a chart repo under team-core and commits the given files
// on "main" (the first commit establishes the default branch in the fake).
// Returns the project's web URL (the git source baked into application.yaml).
func makeRepoByID(ctx context.Context, t *testing.T, gl *gitlab.Fake, repo string, files map[string]string) string {
	t.Helper()
	sg, err := gl.GetGroup(ctx, "managed-services/team-core")
	if err != nil {
		t.Fatalf("get subgroup: %v", err)
	}
	p, err := gl.CreateProject(ctx, sg.ID, repo)
	if err != nil {
		t.Fatalf("create repo %s: %v", repo, err)
	}
	var actions []gitlab.FileAction
	for path, content := range files {
		actions = append(actions, gitlab.FileAction{Action: "create", FilePath: path, Content: content})
	}
	if err := gl.CommitFiles(ctx, p.ID, "main", "seed", actions); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return p.WebURL
}

func TestImportFromGit(t *testing.T) {
	ctx := context.Background()
	s := newStack(t)

	// A valid, conforming instance: the application.yaml is exactly what the portal
	// would render (we render it the same way), plus an adjacent values.yaml.
	webURL := webURLFor("managed-services/team-core/postgres")
	want := &models.Request{
		Team: "core", ChartProject: "platform", ChartName: "postgres", ChartVersion: "15.4.2",
		ServiceName: "pg9", Cluster: "in-cluster", Namespace: "pg9-ns",
		ArgoCDAppName: "core-pg9",
	}
	appYAML, err := s.gitops.RenderApplication(want, webURL)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	makeRepoByID(ctx, t, s.gl, "postgres", map[string]string{
		"in-cluster/pg9/application.yaml": appYAML,
		"in-cluster/pg9/values.yaml":      "auth:\n  database: app\n",
	})

	// Invalid #1: conforming application.yaml but NO values.yaml -> not imported.
	noValues := mustRender(t, s, "managed-services/team-core/redis",
		&models.Request{Team: "core", ChartProject: "platform", ChartName: "redis", ChartVersion: "1.0.0",
			ServiceName: "cache1", Cluster: "in-cluster", Namespace: "cache1", ArgoCDAppName: "core-cache1"})
	makeRepoByID(ctx, t, s.gl, "redis", map[string]string{
		"in-cluster/cache1/application.yaml": noValues,
	})

	// Invalid #2: a foreign manifest (not what the portal renders) -> not imported,
	// even though it has both files.
	foreign := `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: core-foreign
spec:
  destination: { name: in-cluster, namespace: foreign }
  sources:
    - repoURL: some-other-registry/platform
      chart: postgres
      targetRevision: 9.9.9
`
	makeRepoByID(ctx, t, s.gl, "mongo", map[string]string{
		"in-cluster/foreign/application.yaml": foreign,
		"in-cluster/foreign/values.yaml":      "x: 1\n",
	})

	if err := s.prov.ImportFromGit(ctx); err != nil {
		t.Fatalf("ImportFromGit: %v", err)
	}

	all, _ := s.st.ListRequests(ctx, store.RequestFilter{Admin: true, IncludeDeleted: true})
	if len(all) != 1 {
		t.Fatalf("want exactly 1 imported (the valid one), got %d: %+v", len(all), all)
	}
	pg := all[0]
	if !pg.Imported || pg.ArgoCDAppName != "core-pg9" || pg.ChartName != "postgres" ||
		pg.ChartVersion != "15.4.2" || pg.ServiceName != "pg9" || pg.ChartProject != "platform" ||
		pg.Namespace != "pg9-ns" || pg.ValuesYAML == "" {
		t.Fatalf("imported order wrong: %+v", pg)
	}

	// Idempotent: re-import adopts nothing new.
	if err := s.prov.ImportFromGit(ctx); err != nil {
		t.Fatalf("ImportFromGit (2nd): %v", err)
	}
	all2, _ := s.st.ListRequests(ctx, store.RequestFilter{Admin: true, IncludeDeleted: true})
	if len(all2) != 1 {
		t.Fatalf("re-import created duplicates: now %d", len(all2))
	}
}

// webURLFor mirrors the fake's project web URL scheme so the test renders the
// application.yaml with the same git source the importer will compare against.
func webURLFor(fullPath string) string { return "https://gitlab.local/" + fullPath }

func mustRender(t *testing.T, s *stack, repoFullPath string, r *models.Request) string {
	t.Helper()
	out, err := s.gitops.RenderApplication(r, webURLFor(repoFullPath))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	return out
}
