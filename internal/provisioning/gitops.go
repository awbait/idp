package provisioning

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"text/template"

	"console/pkg/models"
)

// plainYAMLScalar matches values safe to emit as a bare YAML scalar (no quoting
// needed). Anything else is JSON-encoded by yamlScalar, which is a valid YAML
// double-quoted scalar - this keeps normal output byte-identical (no spurious
// drift) while neutralising values with YAML-significant characters or newlines.
var plainYAMLScalar = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]*$`)

// yamlScalar returns s ready to substitute as a standalone YAML scalar: bare when
// safe, otherwise JSON-quoted (a JSON string is a valid YAML scalar). Prevents
// YAML injection from a field carrying ":" lines, newlines, etc.
func yamlScalar(s string) string {
	if plainYAMLScalar.MatchString(s) {
		return s
	}
	b, _ := json.Marshal(s)
	return string(b)
}

// GitOps encapsulates the GitOps repo convention:
//
//	{topGroup}/{subgroup}/{chart}/{service_name}/{application.yaml,values.yaml}
//
// The subgroup is created manually; the chart repo is created idempotently;
// each ordered instance is a folder inside the chart repo.
type GitOps struct {
	TopGroup      string
	SubgroupTmpl  *template.Template
	AppNameTmpl   *template.Template
	ArgoProject   string
	DefaultBranch string
	// ChartRegistry is the OCI/Helm registry base for the chart source in the
	// generated application.yaml (set from config after construction). The chart
	// repoURL is "{ChartRegistry}/{chart_project}".
	ChartRegistry string
}

type tmplData struct {
	Team        string
	ServiceName string
	Chart       string
}

// NewGitOps compiles the subgroup and app-name templates.
func NewGitOps(topGroup, subgroupTmpl, appNameTmpl, argoProject, defaultBranch string) (*GitOps, error) {
	sg, err := template.New("subgroup").Parse(subgroupTmpl)
	if err != nil {
		return nil, fmt.Errorf("subgroup template: %w", err)
	}
	an, err := template.New("appname").Parse(appNameTmpl)
	if err != nil {
		return nil, fmt.Errorf("appname template: %w", err)
	}
	return &GitOps{
		TopGroup: topGroup, SubgroupTmpl: sg, AppNameTmpl: an,
		ArgoProject: argoProject, DefaultBranch: defaultBranch,
	}, nil
}

func render(t *template.Template, d tmplData) string {
	var b bytes.Buffer
	_ = t.Execute(&b, d)
	return b.String()
}

// SubgroupPath returns e.g. "managed-services/team-core".
func (g *GitOps) SubgroupPath(team string) string {
	return g.TopGroup + "/" + render(g.SubgroupTmpl, tmplData{Team: team})
}

// RepoPath returns the chart repo full path, e.g. "managed-services/team-core/postgres".
func (g *GitOps) RepoPath(team, chart string) string {
	return g.SubgroupPath(team) + "/" + chart
}

// AppName renders the ArgoCD Application name (computed once at creation). The
// chart is part of the name so two different charts ordered with the same
// service_name into one namespace do not produce two application.yaml files that
// define the same-named Application CR (which would make their app-of-apps repos
// fight over a single object). Mirrors the active-service key (team, chart,
// service, cluster).
func (g *GitOps) AppName(team, chart, service string) string {
	return render(g.AppNameTmpl, tmplData{Team: team, Chart: chart, ServiceName: service})
}

// TeamFromSubgroup reverses SubgroupTmpl to recover the team from a subgroup
// segment (e.g. "team-core" -> "core" for template "team-{{.Team}}"). Best-effort:
// handles the common prefix/suffix template forms, else returns the input.
func (g *GitOps) TeamFromSubgroup(subgroup string) string {
	fixed := render(g.SubgroupTmpl, tmplData{}) // template with an empty team, e.g. "team-"
	switch {
	case fixed == "":
		return subgroup
	case strings.HasPrefix(subgroup, fixed):
		return strings.TrimPrefix(subgroup, fixed)
	case strings.HasSuffix(subgroup, fixed):
		return strings.TrimSuffix(subgroup, fixed)
	default:
		return subgroup
	}
}

// InstanceDir is the folder inside the chart repo for an instance:
// {cluster}/{service}. Grouping by cluster keeps instances of the same service
// in different clusters apart (cluster is part of the active-service identity).
// Empty cluster falls back to the flat {service} layout (legacy records).
func (g *GitOps) InstanceDir(cluster, service string) string {
	if cluster == "" {
		return service
	}
	return cluster + "/" + service
}

// ValuesPath / AppPath are file paths within the chart repo.
func (g *GitOps) ValuesPath(cluster, service string) string {
	return g.InstanceDir(cluster, service) + "/values.yaml"
}
func (g *GitOps) AppPath(cluster, service string) string {
	return g.InstanceDir(cluster, service) + "/application.yaml"
}

// applicationYAML is rendered into application.yaml. It is a self-contained,
// MULTI-SOURCE ArgoCD Application: source 0 is the Helm chart pulled from the
// OCI registry, source 1 is this Git repo (ref "values") so the adjacent
// {service}/values.yaml is mixed in via helm.valueFiles ($values). A bootstrap
// app-of-apps (ApplicationSet, scripts/stand) applies these committed files as
// CRs, so this manifest fully describes the deployment - no per-repo wiring.
// metadata.namespace is argocd so the app-of-apps materialises it there.
// (The fake ArgoCD parses only metadata.name, labels, spec.project and
// spec.destination.name, all of which remain present here.)
var applicationYAML = template.Must(template.New("app").Parse(`apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: {{.AppName}}
  namespace: argocd
  labels:
    managed-by: portal
    idp.team: {{.Team}}
    idp.chart: {{.Chart}}
    idp.service: {{.Service}}
spec:
  project: {{.Project}}
  destination:
    name: {{.Cluster}}
    namespace: {{.Namespace}}
  sources:
    - repoURL: {{.ChartRepo}}
      chart: {{.Chart}}
      targetRevision: {{.ChartVersion}}
      helm:
        valueFiles:
          - $values/{{.Path}}/values.yaml
    - repoURL: {{.RepoURL}}
      targetRevision: {{.Branch}}
      ref: values
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
`))

// RenderApplication produces the application.yaml content for a request: a
// multi-source Application referencing the chart in the OCI registry plus the
// adjacent values.yaml in this Git repo. repoURL is the Git repo (the chart
// repo's web URL); the chart source is "{ChartRegistry}/{chart_project}".
func (g *GitOps) RenderApplication(r *models.Request, repoURL string) (string, error) {
	chartRepo := strings.TrimRight(g.ChartRegistry, "/") + "/" + r.ChartProject
	// Use the canonical clone URL (".git"): GitLab 301-redirects the web URL
	// (.../repo) to .../repo.git on /info/refs, and ArgoCD's git client does not
	// follow that redirect ("failed to get git client ... status code: 301").
	gitRepo := repoURL
	if !strings.HasSuffix(gitRepo, ".git") {
		gitRepo += ".git"
	}
	namespace := r.Namespace
	if namespace == "" {
		namespace = r.ServiceName // back-compat: pre-namespace records
	}
	var b bytes.Buffer
	// Quote every standalone scalar (yamlScalar) so a field with YAML-significant
	// characters cannot break or inject structure. Path is exempt: it is embedded
	// inside a larger string ($values/<path>/values.yaml) and its segments are
	// nameRe-validated.
	err := applicationYAML.Execute(&b, map[string]string{
		"AppName":      yamlScalar(r.ArgoCDAppName),
		"Team":         yamlScalar(r.Team),
		"Chart":        yamlScalar(r.ChartName),
		"Service":      yamlScalar(r.ServiceName),
		"Namespace":    yamlScalar(namespace),
		"Project":      yamlScalar(g.ArgoProject),
		"Cluster":      yamlScalar(r.Cluster),
		"RepoURL":      yamlScalar(gitRepo),
		"Path":         g.InstanceDir(r.Cluster, r.ServiceName),
		"Branch":       yamlScalar(g.DefaultBranch),
		"ChartRepo":    yamlScalar(chartRepo),
		"ChartVersion": yamlScalar(r.ChartVersion),
	})
	return b.String(), err
}
