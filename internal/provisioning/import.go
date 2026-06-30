package provisioning

import (
	"context"
	"errors"
	"path"
	"strings"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
	"console/internal/gitlab"
	"console/internal/store"
	"console/pkg/models"
)

// ImportFromGit discovers application.yaml manifests committed under the GitOps
// group and adopts any that the portal doesn't already track as IMPORTED orders.
// This makes services created directly in Git (bypassing the portal) visible in
// the catalog. Idempotent: an order whose ArgoCD app name is already known (a
// portal order or a previously imported one) is skipped. Read-only w.r.t. Git.
func (s *Service) ImportFromGit(ctx context.Context) error {
	discovered, err := s.gl.DiscoverApplications(ctx)
	if err != nil {
		return err
	}
	// Known identities = the ArgoCD app name of every NON-deleted order. We
	// deliberately exclude fully-deleted orders: a normal delete removes the
	// manifest from Git (so it won't be rediscovered), but if a manifest with the
	// same identity reappears in Git later it's a genuinely new instance and should
	// be re-adopted rather than blocked forever by the old deleted row. In-progress
	// deletes (DELETE_REQUESTED/DELETE_MR_MERGED) are still non-deleted, so they
	// stay in the set and aren't re-imported mid-flight.
	existing, err := s.store.ListRequests(ctx, store.RequestFilter{Admin: true})
	if err != nil {
		return err
	}
	known := make(map[string]struct{}, len(existing))
	for _, r := range existing {
		if r.ArgoCDAppName != "" {
			known[r.ArgoCDAppName] = struct{}{}
		}
	}

	for _, d := range discovered {
		r := s.parseDiscovered(d)
		if r == nil {
			continue // couldn't determine the essential identity - skip
		}
		if _, ok := known[r.ArgoCDAppName]; ok {
			continue
		}
		// Only adopt VALID, conforming instances:
		//  1) the adjacent values.yaml must exist (a complete instance folder), and
		//  2) the application.yaml must be exactly what the portal would generate for
		//     this order (re-render and compare) - i.e. it follows our GitOps
		//     convention, not some foreign Application we shouldn't manage.
		valuesPath := path.Dir(d.FilePath) + "/values.yaml"
		vb, verr := s.gl.GetFile(ctx, d.ProjectID, valuesPath, d.Branch)
		if verr != nil {
			continue // no values.yaml (or unreadable) - incomplete instance
		}
		expected, rerr := s.gitops.RenderApplication(r, d.ProjectWebURL)
		if rerr != nil || !yamlEqual([]byte(expected), d.Content) {
			continue // application.yaml is not identical to ours - skip
		}
		// values.yaml must satisfy the chart schema - otherwise the adopted order
		// would be un-editable (every edit re-validates the whole values). Skip
		// instances whose values don't validate.
		var vmap map[string]any
		if yaml.Unmarshal(vb, &vmap) != nil {
			continue
		}
		if _, verr := s.validateAndMarshal(ctx, r.ChartProject, r.ChartName, r.ChartVersion, r.Namespace, vmap, true); verr != nil {
			continue
		}
		r.ValuesYAML = string(vb)
		// Attribute the order to whoever authored the manifest in Git (best-effort;
		// falls back to the generic "imported" identity set in parseDiscovered).
		if name, email, aerr := s.gl.LastCommitAuthor(ctx, d.ProjectID, d.FilePath, d.Branch); aerr == nil && name != "" {
			r.CreatedByName = name
			if email != "" {
				r.CreatedBy = email
			}
		}
		// Seed the status from current ArgoCD health so the lifecycle reconciler
		// takes over normally; default to DEPLOYING when the app isn't visible yet.
		r.Status = models.StatusDeploying
		if app, aerr := s.argo.GetApplication(ctx, r.ArgoCDAppName); aerr == nil {
			if st := mapHealth(app.Health); st != "" {
				r.Status = st
			}
		}
		if err := s.store.CreateRequest(ctx, r); err != nil {
			// ErrConflict => an active order already owns this identity; treat as known.
			if errors.Is(err, models.ErrConflict) {
				known[r.ArgoCDAppName] = struct{}{}
			}
			continue
		}
		known[r.ArgoCDAppName] = struct{}{}
		s.event(ctx, r, "system", "imported", "", r.Status)
		s.publishStatus(r.ID, string(r.Status))
	}
	return nil
}

// appManifest is the subset of an application.yaml the importer reads.
type appManifest struct {
	Metadata struct {
		Name   string            `yaml:"name"`
		Labels map[string]string `yaml:"labels"`
	} `yaml:"metadata"`
	Spec struct {
		Destination struct {
			Name      string `yaml:"name"`
			Namespace string `yaml:"namespace"`
		} `yaml:"destination"`
		Sources []appSource `yaml:"sources"`
		Source  appSource   `yaml:"source"`
	} `yaml:"spec"`
}

type appSource struct {
	RepoURL        string `yaml:"repoURL"`
	Chart          string `yaml:"chart"`
	TargetRevision string `yaml:"targetRevision"`
}

// parseDiscovered reconstructs an order from a discovered application.yaml. It
// prefers the portal's idp.* labels, falling back to the repo path / sources so a
// hand-written manifest is still importable. Returns nil if the essential
// identity (team, chart, service) can't be determined.
func (s *Service) parseDiscovered(d gitlab.DiscoveredApp) *models.Request {
	var m appManifest
	if err := yaml.Unmarshal(d.Content, &m); err != nil {
		return nil
	}

	// The chart source is the one carrying a chart (multi-source); fall back to a
	// single source.
	chartSrc := m.Spec.Source
	for _, src := range m.Spec.Sources {
		if src.Chart != "" {
			chartSrc = src
			break
		}
	}

	lbl := m.Metadata.Labels
	team := lbl["idp.team"]
	chart := firstNonEmpty(lbl["idp.chart"], chartSrc.Chart)
	service := lbl["idp.service"]

	// Path fallbacks. ProjectPath: {group}/{subgroup}/{repo}; FilePath: {cluster}/{service}/application.yaml.
	projSegs := strings.Split(strings.Trim(d.ProjectPath, "/"), "/")
	if team == "" && len(projSegs) >= 2 {
		team = s.gitops.TeamFromSubgroup(projSegs[len(projSegs)-2])
	}
	if chart == "" && len(projSegs) >= 1 {
		chart = projSegs[len(projSegs)-1]
	}
	if service == "" {
		service = path.Base(path.Dir(d.FilePath)) // {cluster}/{service}/application.yaml -> service
	}

	team, chart, service = strings.TrimSpace(team), strings.TrimSpace(chart), strings.TrimSpace(service)
	if team == "" || chart == "" || service == "" || service == "." {
		return nil
	}

	cluster := firstNonEmpty(m.Spec.Destination.Name, s.defaultCluster)
	appName := firstNonEmpty(m.Metadata.Name, s.gitops.AppName(team, chart, service))

	return &models.Request{
		ID:            uuid.NewString(),
		CreatedBy:     "git",
		CreatedByName: "Импортировано из Git",
		Team:          team,
		ChartProject:  projectFromRepoURL(chartSrc.RepoURL),
		ChartName:     chart,
		ChartVersion:  chartSrc.TargetRevision,
		ServiceName:   service,
		DisplayName:   service,
		Cluster:       cluster,
		Namespace:     m.Spec.Destination.Namespace,
		ArgoCDAppName: appName,
		// Imported orders adopt existing Git state rather than rendering values, so
		// fall back to service_name (unique per Git folder) for the namespace key.
		ResourceIdentity: service,
		Imported:         true,
	}
}

// projectFromRepoURL extracts the Harbor project from a chart source repoURL like
// "host.docker.internal:8084/platform" -> "platform".
func projectFromRepoURL(repoURL string) string {
	repoURL = strings.TrimRight(repoURL, "/")
	if i := strings.LastIndex(repoURL, "/"); i >= 0 {
		return repoURL[i+1:]
	}
	return ""
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
