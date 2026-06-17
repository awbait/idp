package provisioning

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"gopkg.in/yaml.v3"
	"idp/pkg/models"
)

// CheckDrift compares each deployed order's committed Git state (values.yaml +
// chart version in application.yaml) against what the portal has on record, and
// flags orders that were changed directly in Git (not through the portal). It is
// read-only - it never overwrites Git - and idempotent, so the poller can call it
// every tick. Implemented as a separate pass (not folded into Reconcile) so it
// can later move to its own, slower cadence.
func (s *Service) CheckDrift(ctx context.Context) error {
	active, err := s.store.ListActive(ctx)
	if err != nil {
		return err
	}
	for _, r := range active {
		if !driftCheckable(r.Status) {
			continue
		}
		s.checkDriftOne(ctx, r)
	}
	return nil
}

// driftCheckable reports whether an order's manifests are expected to live on the
// default branch (i.e. the create/update MR has merged), so reading them back is
// meaningful. Drafts and not-yet-merged orders are skipped.
func driftCheckable(st models.RequestStatus) bool {
	switch st {
	case models.StatusMRMerged, models.StatusDeploying, models.StatusHealthy, models.StatusDegraded:
		return true
	default:
		return false
	}
}

func (s *Service) checkDriftOne(ctx context.Context, r *models.Request) {
	proj, err := s.gl.GetProject(ctx, s.gitops.RepoPath(r.Team, r.ChartName))
	if err != nil {
		return // can't resolve the repo (transient/absent) - skip this tick
	}
	branch := proj.DefaultBranch
	if branch == "" {
		branch = s.defaultBranch
	}

	var reasons []string

	// values.yaml: compare semantically (YAML-equal) so formatting/key-order
	// differences from re-marshaling don't show up as false drift.
	switch git, verr := s.gl.GetFile(ctx, proj.ID, s.gitops.ValuesPath(r.Cluster, r.ServiceName), branch); {
	case errors.Is(verr, models.ErrNotFound):
		reasons = append(reasons, "values.yaml отсутствует в Git")
	case verr == nil:
		if !yamlEqual(git, []byte(r.ValuesYAML)) {
			reasons = append(reasons, "values.yaml изменён в Git")
		}
		// other errors: transient - ignore this tick
	}

	// application.yaml: compare the chart version (targetRevision).
	switch git, aerr := s.gl.GetFile(ctx, proj.ID, s.gitops.AppPath(r.Cluster, r.ServiceName), branch); {
	case errors.Is(aerr, models.ErrNotFound):
		reasons = append(reasons, "application.yaml отсутствует в Git")
	case aerr == nil:
		if v := chartVersionFromApp(git); v != "" && v != r.ChartVersion {
			reasons = append(reasons, fmt.Sprintf("версия чарта в Git: %s (в портале: %s)", v, r.ChartVersion))
		}
	}

	drifted := len(reasons) > 0
	detail := strings.Join(reasons, "; ")
	if r.Drifted == drifted && r.DriftDetail == detail {
		return // no change
	}
	if err := s.store.SetDrift(ctx, r.ID, drifted, detail); err != nil {
		return
	}
	r.Drifted, r.DriftDetail = drifted, detail
	typ := "drift_cleared"
	if drifted {
		typ = "drift_detected"
	}
	s.event(ctx, r, "system", typ, r.Status, r.Status)
	s.publishStatus(r.ID, string(r.Status))
}

// yamlEqual reports whether two YAML documents are semantically equal (ignoring
// formatting and key order). Falls back to a trimmed byte compare if either side
// isn't valid YAML.
func yamlEqual(a, b []byte) bool {
	var av, bv any
	if err := yaml.Unmarshal(a, &av); err != nil {
		return strings.TrimSpace(string(a)) == strings.TrimSpace(string(b))
	}
	if err := yaml.Unmarshal(b, &bv); err != nil {
		return false
	}
	return reflect.DeepEqual(av, bv)
}

// chartVersionFromApp extracts the chart source's targetRevision from a rendered
// application.yaml (multi-source: the source carrying a chart; single-source as a
// fallback). Returns "" if it can't be determined.
func chartVersionFromApp(b []byte) string {
	var m struct {
		Spec struct {
			Sources []struct {
				Chart          string `yaml:"chart"`
				TargetRevision string `yaml:"targetRevision"`
			} `yaml:"sources"`
			Source struct {
				Chart          string `yaml:"chart"`
				TargetRevision string `yaml:"targetRevision"`
			} `yaml:"source"`
		} `yaml:"spec"`
	}
	if err := yaml.Unmarshal(b, &m); err != nil {
		return ""
	}
	for _, src := range m.Spec.Sources {
		if src.Chart != "" {
			return src.TargetRevision
		}
	}
	return m.Spec.Source.TargetRevision
}
