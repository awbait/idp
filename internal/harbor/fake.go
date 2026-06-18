package harbor

import (
	"context"
	"sort"
	"time"

	"console/pkg/models"
)

// fakeVersion bundles a version's metadata and its file bodies.
type fakeVersion struct {
	v         models.ChartVersion
	values    string
	readme    string
	schema    string
	changelog string
}

type fakeChart struct {
	chart    models.Chart
	versions map[string]*fakeVersion // version -> data
}

// Fake is an in-memory Harbor used for local runs and tests.
type Fake struct {
	charts map[string]*fakeChart // key: project/name
}

var _ Port = (*Fake)(nil)

func key(project, name string) string { return project + "/" + name }

// NewFake returns a Fake seeded with a couple of sample charts.
func NewFake() *Fake {
	f := &Fake{charts: map[string]*fakeChart{}}
	f.seed()
	f.seedEmbeddedCharts()
	return f
}

func (f *Fake) seed() {
	now := time.Date(2026, 5, 20, 0, 0, 0, 0, time.UTC)

	pgSchema := `{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["auth"],
  "properties": {
    "auth": {
      "type": "object",
      "required": ["database"],
      "properties": {
        "database": {"type": "string", "title": "Database name"},
        "username": {"type": "string", "title": "Username", "default": "app"}
      }
    },
    "primary": {
      "type": "object",
      "properties": {
        "persistence": {
          "type": "object",
          "properties": {
            "size": {"type": "string", "title": "Volume size", "default": "8Gi"}
          }
        }
      }
    }
  }
}`
	pgValues := "auth:\n  database: app\n  username: app\nprimary:\n  persistence:\n    size: 8Gi\n"
	pgChangelog := `# Changelog

## [15.4.2] - 2026-05-20
### Added
- New ingress annotations support
### Fixed
- Memory leak in sidecar
### Security
- Bumped base image (CVE-2024-XXXX)

## [15.4.1] - 2026-05-15
### Fixed
- Crash on empty password
`

	f.add(&fakeChart{
		chart: models.Chart{
			Project: "platform", Name: "postgres",
			Description:  "PostgreSQL managed service",
			AllowedTeams: nil,
		},
		versions: map[string]*fakeVersion{
			"15.4.1": {
				v:         models.ChartVersion{Project: "platform", Name: "postgres", Version: "15.4.1", Digest: "sha256:pg1541", AppVersion: "15.4.1", Created: now.Add(-120 * time.Hour)},
				values:    pgValues,
				readme:    "# PostgreSQL\n\nManaged Postgres chart.\n",
				schema:    pgSchema,
				changelog: pgChangelog,
			},
			"15.4.2": {
				v:         models.ChartVersion{Project: "platform", Name: "postgres", Version: "15.4.2", Digest: "sha256:pg1542", AppVersion: "15.4.2", Created: now, Tags: []string{"stable"}},
				values:    pgValues,
				readme:    "# PostgreSQL\n\nManaged Postgres chart.\n",
				schema:    pgSchema,
				changelog: pgChangelog,
			},
		},
	})

	f.add(&fakeChart{
		chart: models.Chart{
			Project: "platform", Name: "redis",
			Description:  "Redis managed service",
			AllowedTeams: []string{"core"},
		},
		versions: map[string]*fakeVersion{
			"7.2.0": {
				v:      models.ChartVersion{Project: "platform", Name: "redis", Version: "7.2.0", Digest: "sha256:redis720", AppVersion: "7.2.0", Created: now.Add(-48 * time.Hour)},
				values: "architecture: standalone\nauth:\n  enabled: true\n",
				readme: "# Redis\n\nManaged Redis chart.\n",
				schema: `{"$schema":"https://json-schema.org/draft-07/schema#","type":"object","properties":{"architecture":{"type":"string","enum":["standalone","replication"],"default":"standalone"}}}`,
			},
		},
	})
}

func (f *Fake) add(c *fakeChart) {
	// fill version list + latest = last by Created
	vers := make([]models.ChartVersion, 0, len(c.versions))
	for _, fv := range c.versions {
		vers = append(vers, fv.v)
	}
	sort.Slice(vers, func(i, j int) bool { return vers[i].Created.Before(vers[j].Created) })
	c.chart.Versions = nil
	for _, v := range vers {
		c.chart.Versions = append(c.chart.Versions, v.Version)
	}
	if len(vers) > 0 {
		c.chart.LatestVersion = vers[len(vers)-1].Version // "last tag" per spec
	}
	f.charts[key(c.chart.Project, c.chart.Name)] = c
}

func (f *Fake) ListCharts(ctx context.Context) ([]models.Chart, error) {
	out := make([]models.Chart, 0, len(f.charts))
	for _, c := range f.charts {
		out = append(out, c.chart)
	}
	sort.Slice(out, func(i, j int) bool { return key(out[i].Project, out[i].Name) < key(out[j].Project, out[j].Name) })
	return out, nil
}

func (f *Fake) GetChart(ctx context.Context, project, name string) (*models.Chart, error) {
	c, ok := f.charts[key(project, name)]
	if !ok {
		return nil, models.ErrNotFound
	}
	cp := c.chart
	return &cp, nil
}

func (f *Fake) ListVersions(ctx context.Context, project, name string) ([]models.ChartVersion, error) {
	c, ok := f.charts[key(project, name)]
	if !ok {
		return nil, models.ErrNotFound
	}
	out := make([]models.ChartVersion, 0, len(c.versions))
	for _, fv := range c.versions {
		out = append(out, fv.v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out, nil
}

func (f *Fake) getVer(project, name, version string) (*fakeVersion, error) {
	c, ok := f.charts[key(project, name)]
	if !ok {
		return nil, models.ErrNotFound
	}
	fv, ok := c.versions[version]
	if !ok {
		return nil, models.ErrNotFound
	}
	return fv, nil
}

func (f *Fake) GetVersion(ctx context.Context, project, name, version string) (*models.ChartVersion, error) {
	fv, err := f.getVer(project, name, version)
	if err != nil {
		return nil, err
	}
	v := fv.v
	return &v, nil
}

func (f *Fake) GetValues(ctx context.Context, project, name, version string) ([]byte, error) {
	fv, err := f.getVer(project, name, version)
	if err != nil {
		return nil, err
	}
	return []byte(fv.values), nil
}

func (f *Fake) GetReadme(ctx context.Context, project, name, version string) ([]byte, error) {
	fv, err := f.getVer(project, name, version)
	if err != nil {
		return nil, err
	}
	return []byte(fv.readme), nil
}

func (f *Fake) GetSchema(ctx context.Context, project, name, version string) ([]byte, error) {
	fv, err := f.getVer(project, name, version)
	if err != nil {
		return nil, err
	}
	if fv.schema == "" {
		return nil, models.ErrNotFound
	}
	return []byte(fv.schema), nil
}

func (f *Fake) GetChangelog(ctx context.Context, project, name, version string) ([]byte, error) {
	fv, err := f.getVer(project, name, version)
	if err != nil {
		return nil, err
	}
	if fv.changelog == "" {
		return nil, models.ErrNotFound
	}
	return []byte(fv.changelog), nil
}

func (f *Fake) Healthz(ctx context.Context) error { return nil }
