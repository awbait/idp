// Package config loads runtime configuration from the environment.
package config

import (
	"time"

	"github.com/caarlos0/env/v11"
)

// Mode selects between a real upstream client and an in-memory fake.
type Mode string

const (
	ModeReal Mode = "real"
	ModeFake Mode = "fake"
)

// Config is the full portal configuration. Defaults favour a local
// fakes-only run so the whole portal boots with just Postgres+Redis
// (or fully in-memory in tests).
type Config struct {
	// Server
	HTTPPort  string `env:"HTTP_PORT" envDefault:"8080"`
	PublicURL string `env:"PUBLIC_URL" envDefault:"http://localhost:8080"`

	// Upstream modes. Default to "real" so a misconfigured deployment fails loudly
	// (missing URL/token) instead of silently serving fakes. "fake" is opt-in -
	// used by tests and explicit local dev (make run / run-oidc without -RealGitlab).
	HarborMode Mode `env:"HARBOR_MODE" envDefault:"real"`
	GitLabMode Mode `env:"GITLAB_MODE" envDefault:"real"`
	ArgoCDMode Mode `env:"ARGOCD_MODE" envDefault:"real"`

	// Storage backends: "postgres"|"memory", "redis"|"memory".
	Store string `env:"STORE" envDefault:"memory"`
	Cache string `env:"CACHE" envDefault:"memory"`

	// Auth: "oidc"|"dev". dev mode injects a static user (no Keycloak).
	AuthMode       string        `env:"AUTH_MODE" envDefault:"dev"`
	OIDCIssuer     string        `env:"OIDC_ISSUER"`
	OIDCClientID   string        `env:"OIDC_CLIENT_ID"`
	OIDCSecret     string        `env:"OIDC_CLIENT_SECRET"`
	OIDCRedirect   string        `env:"OIDC_REDIRECT_URL"`
	OIDCPostLogin  string        `env:"OIDC_POST_LOGIN_REDIRECT" envDefault:"/"`
	OIDCPostLogout string        `env:"OIDC_POST_LOGOUT_REDIRECT"`
	OIDCScopes     []string      `env:"OIDC_SCOPES" envSeparator:"," envDefault:"openid,profile,email,groups"`
	SessionSecret  string        `env:"SESSION_SECRET" envDefault:"dev-insecure-session-secret-change-me"`
	SessionCookie  string        `env:"SESSION_COOKIE_NAME" envDefault:"idp_session"`
	SessionTTL     time.Duration `env:"SESSION_TTL" envDefault:"24h"`

	// RBAC
	AdminGroups []string `env:"RBAC_ADMIN_GROUPS" envSeparator:","`
	// SupportGroups grant the support role (cross-team order view/edit);
	// SecurityGroups grant the security role (InfoSec). Empty => nobody has them.
	SupportGroups   []string `env:"RBAC_SUPPORT_GROUPS" envSeparator:","`
	SecurityGroups  []string `env:"RBAC_SECURITY_GROUPS" envSeparator:","`
	TeamGroupPrefix string   `env:"RBAC_TEAM_GROUP_PREFIX" envDefault:"team-"`
	// TeamGroupRegex, when set, overrides the prefix: a regex whose first capture
	// group is the team name, matched against each raw group claim. Lets an
	// external IdP with a different/nested group structure map to teams.
	TeamGroupRegex string `env:"RBAC_TEAM_GROUP_REGEX"`

	// Harbor
	HarborURL         string        `env:"HARBOR_URL"`
	HarborRobotUser   string        `env:"HARBOR_ROBOT_USER"`
	HarborRobotToken  string        `env:"HARBOR_ROBOT_TOKEN"`
	HarborProjects    []string      `env:"HARBOR_PROJECTS" envSeparator:"," envDefault:"platform,managed-services"`
	HarborWebhookKey  string        `env:"HARBOR_WEBHOOK_SECRET"`
	HarborInsecureTLS bool          `env:"HARBOR_INSECURE_TLS" envDefault:"false"`
	HarborTimeout     time.Duration `env:"HARBOR_TIMEOUT" envDefault:"30s"`

	// GitLab
	GitLabURL           string        `env:"GITLAB_URL"`
	GitLabToken         string        `env:"GITLAB_TOKEN"`
	GitLabTimeout       time.Duration `env:"GITLAB_TIMEOUT" envDefault:"30s"`
	GitLabAutoMerge     bool          `env:"GITLAB_AUTO_MERGE" envDefault:"false"`
	GitLabGitopsGroup   string        `env:"GITLAB_GITOPS_GROUP" envDefault:"managed-services"`
	GitLabSubgroupTmpl  string        `env:"GITLAB_TEAM_SUBGROUP_TEMPLATE" envDefault:"team-{{.Team}}"`
	GitLabDefaultBranch string        `env:"GITLAB_DEFAULT_BRANCH" envDefault:"main"`
	GitLabWebhookToken  string        `env:"GITLAB_WEBHOOK_TOKEN"`

	// ArgoCD
	ArgoCDURL         string `env:"ARGOCD_URL"`
	ArgoCDToken       string `env:"ARGOCD_TOKEN"`
	ArgoCDProject     string `env:"ARGOCD_PROJECT" envDefault:"portal-managed"`
	ArgoCDCluster     string `env:"ARGOCD_DEFAULT_CLUSTER" envDefault:"in-cluster"`
	ArgoCDAppNameTmpl string `env:"ARGOCD_APP_NAME_TEMPLATE" envDefault:"{{.Team}}-{{.ServiceName}}"`
	// ChartRegistry is the OCI/Helm registry base the committed application.yaml
	// points its chart source at, e.g. "host.docker.internal:8084" on the stand
	// (the chart repoURL becomes "{ChartRegistry}/{chart_project}"). This is the
	// Harbor OCI endpoint. Empty in fakes-only mode (the manifest is inert).
	ChartRegistry      string        `env:"CHART_REGISTRY"`
	StatusUpdateMode   string        `env:"STATUS_UPDATE_MODE" envDefault:"polling"`
	StatusPollInterval time.Duration `env:"STATUS_POLL_INTERVAL" envDefault:"15s"`
	// DriftDetection toggles the reverse-sync reconciler that flags orders whose
	// committed Git state was changed outside the portal (read-only signal).
	DriftDetection bool `env:"DRIFT_DETECTION_ENABLED" envDefault:"true"`
	// ImportDiscovery toggles the reconciler that adopts application.yaml manifests
	// created directly in Git (bypassing the portal) as IMPORTED orders. Off by
	// default - it creates order rows.
	ImportDiscovery bool `env:"IMPORT_DISCOVERY_ENABLED" envDefault:"false"`
	// CatalogAutodiscover toggles background registration of charts found in Harbor
	// as draft publications (owned by the admin group). Off by default - it creates
	// publication rows for every chart in the scanned projects.
	CatalogAutodiscover bool `env:"CATALOG_AUTODISCOVER" envDefault:"false"`

	// Postgres / Redis
	DatabaseURL     string `env:"DATABASE_URL"`
	DatabaseMaxConn int32  `env:"DATABASE_MAX_CONNS" envDefault:"20"`
	RedisURL        string `env:"REDIS_URL"`

	// Observability
	LogLevel  string `env:"LOG_LEVEL" envDefault:"info"`
	LogFormat string `env:"LOG_FORMAT" envDefault:"json"`
}

// Load parses configuration from the process environment.
func Load() (*Config, error) {
	cfg := &Config{}
	if err := env.Parse(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}
