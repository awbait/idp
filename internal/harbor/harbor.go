// Package harbor defines the Harbor port (interface) and shared types.
// Real and fake implementations live in client.go and fake.go.
package harbor

import (
	"context"

	"console/pkg/models"
)

// Port is the catalog's view of Harbor. Both the real HTTP client and the
// in-memory fake implement it, switchable by config.
type Port interface {
	// ListCharts returns all charts across the configured projects.
	ListCharts(ctx context.Context) ([]models.Chart, error)
	// GetChart returns a single chart with its version list.
	GetChart(ctx context.Context, project, name string) (*models.Chart, error)
	// ListVersions returns the artifacts (versions) of a chart.
	ListVersions(ctx context.Context, project, name string) ([]models.ChartVersion, error)
	// GetVersion returns details of one version.
	GetVersion(ctx context.Context, project, name, version string) (*models.ChartVersion, error)

	// The following return raw file bodies from the artifact additions.
	GetValues(ctx context.Context, project, name, version string) ([]byte, error)
	GetReadme(ctx context.Context, project, name, version string) ([]byte, error)
	GetSchema(ctx context.Context, project, name, version string) ([]byte, error)
	// GetChangelog returns the raw CHANGELOG.md pulled from the chart .tgz.
	GetChangelog(ctx context.Context, project, name, version string) ([]byte, error)

	// Healthz reports upstream reachability (used by /ready diagnostics only).
	Healthz(ctx context.Context) error
}
