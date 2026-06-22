// Package catalog serves the chart catalog from Harbor with Redis caching.
package catalog

import (
	"context"
	"errors"
	"fmt"
	"time"

	"console/internal/cache"
	"console/internal/changelog"
	"console/internal/harbor"
	"console/pkg/models"
)

// Service is the catalog domain.
type Service struct {
	hb    harbor.Port
	cache cache.Cache
}

// New builds a catalog service.
func New(hb harbor.Port, c cache.Cache) *Service {
	return &Service{hb: hb, cache: c}
}

// VisibleTo reports whether a chart is allowed for the user (allowlist + admin).
func VisibleTo(c *models.Chart, u *models.User) bool {
	if u != nil && u.IsAdmin() {
		return true
	}
	if len(c.AllowedTeams) == 0 {
		return true
	}
	if u == nil {
		return false
	}
	for _, t := range c.AllowedTeams {
		if u.InTeam(t) {
			return true
		}
	}
	return false
}

// ListCharts returns charts visible to the user.
func (s *Service) ListCharts(ctx context.Context, u *models.User) ([]models.Chart, error) {
	all, err := s.hb.ListCharts(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]models.Chart, 0, len(all))
	for i := range all {
		if VisibleTo(&all[i], u) {
			out = append(out, all[i])
		}
	}
	return out, nil
}

// Authorize loads a chart and enforces the visibility allowlist for the user,
// returning the chart so callers can reuse it. A chart hidden from the user is
// reported as ErrNotFound (a 404), not ErrForbidden, so the endpoint does not
// disclose that a restricted chart exists.
//
// The per-chart read methods below (GetChart/GetVersion/GetValues/...) do NOT
// check visibility themselves - they are also used by system flows (provisioning
// render, the global publication catalog). HTTP handlers that expose a chart by
// its path must call Authorize first; otherwise a user could read a chart hidden
// from the listing by guessing its URL (allowlist bypass).
func (s *Service) Authorize(ctx context.Context, u *models.User, project, name string) (*models.Chart, error) {
	chart, err := s.hb.GetChart(ctx, project, name)
	if err != nil {
		return nil, err
	}
	if !VisibleTo(chart, u) {
		return nil, models.ErrNotFound
	}
	return chart, nil
}

// GetChart returns a chart's details (with version list).
func (s *Service) GetChart(ctx context.Context, project, name string) (*models.Chart, error) {
	return s.hb.GetChart(ctx, project, name)
}

// ListVersions returns the versions of a chart.
func (s *Service) ListVersions(ctx context.Context, project, name string) ([]models.ChartVersion, error) {
	return s.hb.ListVersions(ctx, project, name)
}

// GetVersion returns one version's details.
func (s *Service) GetVersion(ctx context.Context, project, name, version string) (*models.ChartVersion, error) {
	return s.hb.GetVersion(ctx, project, name, version)
}

// blob fetches a per-version file body, cached by content digest for 30 days.
func (s *Service) blob(ctx context.Context, kind, project, name, version string,
	fetch func(ctx context.Context, p, n, v string) ([]byte, error)) ([]byte, error) {

	ver, err := s.hb.GetVersion(ctx, project, name, version)
	if err != nil {
		return nil, err
	}
	key := kind + ":" + ver.Digest
	if b, ok, _ := s.cache.Get(ctx, key); ok {
		return b, nil
	}
	b, err := fetch(ctx, project, name, version)
	if err != nil {
		return nil, err
	}
	_ = s.cache.Set(ctx, key, b, 30*24*time.Hour)
	return b, nil
}

// GetValues returns the chart's values.yaml.
func (s *Service) GetValues(ctx context.Context, project, name, version string) ([]byte, error) {
	return s.blob(ctx, "values", project, name, version, s.hb.GetValues)
}

// GetReadme returns the chart's README.md.
func (s *Service) GetReadme(ctx context.Context, project, name, version string) ([]byte, error) {
	return s.blob(ctx, "readme", project, name, version, s.hb.GetReadme)
}

// GetSchema returns the chart's values.schema.json.
func (s *Service) GetSchema(ctx context.Context, project, name, version string) ([]byte, error) {
	return s.blob(ctx, "schema", project, name, version, s.hb.GetSchema)
}

// LatestSchema returns the values.schema.json of the chart's latest version
// (used to cross-validate publication view documents).
func (s *Service) LatestSchema(ctx context.Context, project, name string) ([]byte, error) {
	chart, err := s.hb.GetChart(ctx, project, name)
	if err != nil {
		return nil, err
	}
	if chart.LatestVersion == "" {
		return nil, models.ErrNotFound
	}
	return s.GetSchema(ctx, project, name, chart.LatestVersion)
}

// LatestVersion returns the chart's latest version string (used to stamp the
// version a publication view was approved against).
func (s *Service) LatestVersion(ctx context.Context, project, name string) (string, error) {
	chart, err := s.hb.GetChart(ctx, project, name)
	if err != nil {
		return "", err
	}
	if chart.LatestVersion == "" {
		return "", models.ErrNotFound
	}
	return chart.LatestVersion, nil
}

// LatestDescription returns the chart's current description (snapshotted into a
// publication at approve time so the catalog shows approved, not live, data).
func (s *Service) LatestDescription(ctx context.Context, project, name string) (string, error) {
	chart, err := s.hb.GetChart(ctx, project, name)
	if err != nil {
		return "", err
	}
	return chart.Description, nil
}

// LatestIcon returns the chart's current icon (Chart.yaml icon: URL/data URI),
// snapshotted into a publication at approve time so the catalog/chart profile
// show the approved icon, not the live one from a newer Harbor version.
func (s *Service) LatestIcon(ctx context.Context, project, name string) (string, error) {
	chart, err := s.hb.GetChart(ctx, project, name)
	if err != nil {
		return "", err
	}
	return chart.IconURL, nil
}

// GetChangelog returns the parsed changelog entry for the given version.
func (s *Service) GetChangelog(ctx context.Context, project, name, version string) (*models.ChangelogEntry, error) {
	raw, err := s.blob(ctx, "changelog", project, name, version, s.hb.GetChangelog)
	if err != nil {
		return nil, err
	}
	if e := changelog.ParseVersion(raw, version); e != nil {
		return e, nil
	}
	return nil, models.ErrNotFound
}

// FileCheck reports presence of one file in a chart's bundle (checked when adding).
type FileCheck struct {
	Name     string `json:"name"`
	Required bool   `json:"required"`
	Found    bool   `json:"found"`
}

// CheckResult is the report of checking a chart by Harbor path: whether it
// exists and has the required files. OK=false with Error is a normal check
// outcome (not an HTTP error).
type CheckResult struct {
	OK    bool          `json:"ok"`
	Error string        `json:"error,omitempty"`
	Chart *models.Chart `json:"chart,omitempty"`
	Files []FileCheck   `json:"files,omitempty"`
}

// requiredChartFiles is the bundle we check on the chart's latest version.
// values.yaml and values.schema.json are required (the schema is the only source
// for the order form); README and CHANGELOG are desired but not blocking.
var requiredChartFiles = []struct {
	name     string
	required bool
	fetch    func(s *Service, ctx context.Context, p, n, v string) ([]byte, error)
}{
	{"values.yaml", true, (*Service).GetValues},
	{"values.schema.json", true, (*Service).GetSchema},
	{"README.md", false, (*Service).GetReadme},
	{"CHANGELOG.md", false, func(s *Service, ctx context.Context, p, n, v string) ([]byte, error) {
		return s.blob(ctx, "changelog", p, n, v, s.hb.GetChangelog)
	}},
}

// CheckChart checks a chart by an arbitrary path (project/name): existence in
// Harbor and completeness of the latest version's files. Returns a report; only
// Harbor being unreachable returns an error.
func (s *Service) CheckChart(ctx context.Context, project, name string) (*CheckResult, error) {
	chart, err := s.hb.GetChart(ctx, project, name)
	if err != nil {
		if errors.Is(err, models.ErrNotFound) {
			return &CheckResult{Error: fmt.Sprintf("чарт %s/%s не найден в Harbor", project, name)}, nil
		}
		if harbor.IsAccessDenied(err) {
			return &CheckResult{Error: fmt.Sprintf(
				"нет доступа к %s/%s: проект приватный, а у портала нет прав на него. "+
					"Сделайте проект публичным или выдайте доступ роботу портала (HARBOR_ROBOT_USER)",
				project, name)}, nil
		}
		return nil, err
	}
	if chart.LatestVersion == "" {
		return &CheckResult{Chart: chart, Error: "у чарта нет ни одной версии"}, nil
	}
	res := &CheckResult{OK: true, Chart: chart}
	for _, f := range requiredChartFiles {
		_, ferr := f.fetch(s, ctx, project, name, chart.LatestVersion)
		found := ferr == nil
		if ferr != nil && !errors.Is(ferr, models.ErrNotFound) {
			// Broken/unreachable artifact (not "file missing" but "could not read") -
			// a report, not a 502.
			if harbor.IsAccessDenied(ferr) {
				res.Error = "нет доступа к артефакту чарта: проект приватный. Сделайте его публичным или выдайте доступ роботу портала"
			} else {
				res.Error = fmt.Sprintf("не удалось прочитать артефакт: %v", ferr)
			}
			res.OK = false
		}
		res.Files = append(res.Files, FileCheck{Name: f.name, Required: f.required, Found: found})
		if f.required && !found {
			res.OK = false
		}
	}
	if !res.OK && res.Error == "" {
		res.Error = "в чарте нет обязательных файлов"
	}
	return res, nil
}

// GetAggregatedChangelog parses the whole CHANGELOG.md (from the latest version's
// artifact) and returns up to limit entries.
func (s *Service) GetAggregatedChangelog(ctx context.Context, project, name string, limit int) ([]models.ChangelogEntry, error) {
	chart, err := s.hb.GetChart(ctx, project, name)
	if err != nil {
		return nil, err
	}
	if chart.LatestVersion == "" {
		return nil, models.ErrNotFound
	}
	raw, err := s.blob(ctx, "changelog", project, name, chart.LatestVersion, s.hb.GetChangelog)
	if err != nil {
		return nil, err
	}
	entries := changelog.Parse(raw)
	if limit > 0 && len(entries) > limit {
		entries = entries[:limit]
	}
	return entries, nil
}
