package harbor

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"path"
	"time"

	"gopkg.in/yaml.v3"
	"idp/pkg/models"
)

// Real Helm charts vendored for the fakes-only dev/demo run. The chart is the
// single source of truth for its values.schema.json - the portal serves and
// validates against these exact bytes, so there is no second copy to drift.
// Layout: charts/{project}/{name}/ with the usual Helm files.
//
//go:embed charts
var chartsFS embed.FS

type chartMeta struct {
	Name        string `yaml:"name"`
	Version     string `yaml:"version"`
	Description string `yaml:"description"`
	Icon        string `yaml:"icon"`
	Maintainers []struct {
		Name string `yaml:"name"`
	} `yaml:"maintainers"`
}

// author returns the first maintainer's name (Chart.yaml), used as the author of
// an auto-discovered publication. Empty when the chart has no maintainers.
func (m chartMeta) author() string {
	if len(m.Maintainers) > 0 {
		return m.Maintainers[0].Name
	}
	return ""
}

// seedEmbeddedCharts registers every embedded chart so it is orderable exactly
// like a Harbor-hosted one (catalog, schema, values, readme, changelog).
func (f *Fake) seedEmbeddedCharts() {
	// Stable timestamp: scripts must not call time.Now() in seeds, and it keeps
	// "latest = last by Created" deterministic for tests.
	created := time.Date(2026, 5, 20, 0, 0, 0, 0, time.UTC)

	projects, _ := fs.ReadDir(chartsFS, "charts")
	for _, proj := range projects {
		if !proj.IsDir() {
			continue
		}
		names, _ := fs.ReadDir(chartsFS, path.Join("charts", proj.Name()))
		for _, nd := range names {
			if !nd.IsDir() {
				continue
			}
			base := path.Join("charts", proj.Name(), nd.Name())
			metaB, err := fs.ReadFile(chartsFS, path.Join(base, "Chart.yaml"))
			if err != nil {
				continue
			}
			var m chartMeta
			if yaml.Unmarshal(metaB, &m) != nil || m.Name == "" || m.Version == "" {
				continue
			}
			read := func(p string) string {
				b, _ := fs.ReadFile(chartsFS, path.Join(base, p))
				return string(b)
			}
			// Serve the chart's real defaults (minimal/empty) so the catalog/form
			// starts clean; the rich annotated example is values.example.yaml (a
			// reference doc, not auto-applied). This keeps example gateways/xroutes
			// from being the default both in Helm and in the order form.
			values := read("values.yaml")
			readme := read("README.md")
			schema := read("values.schema.json")
			changelog := read("CHANGELOG.md")

			// Content-derived digest: editing any vendored file changes it, which
			// invalidates the catalog's per-digest cache (a stable digest would
			// keep serving a stale schema/values after edits - a dev footgun).
			h := sha256.New()
			for _, s := range []string{string(metaB), values, schema, readme, changelog} {
				h.Write([]byte(s))
			}
			digest := "sha256:" + hex.EncodeToString(h.Sum(nil))

			f.add(&fakeChart{
				chart: models.Chart{Project: proj.Name(), Name: m.Name, Description: m.Description, IconURL: m.Icon, Author: m.author()},
				versions: map[string]*fakeVersion{
					m.Version: {
						v: models.ChartVersion{
							Project: proj.Name(), Name: m.Name, Version: m.Version,
							Digest: digest, AppVersion: m.Version, Created: created,
						},
						values:    values,
						readme:    readme,
						schema:    schema,
						changelog: changelog,
					},
				},
			})
		}
	}
}
