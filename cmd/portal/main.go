// Command portal is the IDP backend entrypoint.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"syscall"
	"time"

	"console/internal/api"
	"console/internal/argocd"
	"console/internal/auth"
	"console/internal/cache"
	"console/internal/catalog"
	"console/internal/config"
	"console/internal/events"
	"console/internal/gitlab"
	"console/internal/harbor"
	"console/internal/observability"
	"console/internal/provisioning"
	"console/internal/publications"
	"console/internal/status"
	"console/internal/store"
	"console/pkg/models"
)

// demoSubgroups are the team subgroups the fake GitLab pre-seeds (in production
// these are created manually). Mirrors RBAC teams core/dbaas/payments.
var demoSubgroups = []string{"team-core", "team-dbaas", "team-payments"}

func main() {
	cfg, err := config.Load()
	if err != nil {
		panic(err)
	}
	log := observability.NewLogger(cfg.LogLevel, cfg.LogFormat)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cfg, log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, cfg *config.Config, log *slog.Logger) error {
	// --- cache ---
	var c cache.Cache
	switch cfg.Cache {
	case "redis":
		rc, err := cache.NewRedis(cfg.RedisURL)
		if err != nil {
			return err
		}
		c = rc
	default:
		c = cache.NewMemory()
	}
	defer c.Close()

	// --- store ---
	var st store.Store
	switch cfg.Store {
	case "postgres":
		pg, err := store.NewPostgres(ctx, cfg.DatabaseURL, cfg.DatabaseMaxConn)
		if err != nil {
			return err
		}
		st = pg
	default:
		st = store.NewMemory()
	}
	defer st.Close()

	// Base categories + approved ingress-gateway publication (idempotent).
	if err := store.SeedPublications(ctx, st); err != nil {
		return fmt.Errorf("seed publications: %w", err)
	}

	// --- upstreams (Harbor, GitLab and ArgoCD each have a real client + a fake) ---
	var hb harbor.Port
	switch cfg.HarborMode {
	case config.ModeFake:
		hb = harbor.NewFake()
	case config.ModeReal:
		if cfg.HarborURL == "" {
			return errors.New("HARBOR_MODE=real requires HARBOR_URL")
		}
		if cfg.HarborInsecureTLS {
			// Legitimate for the local self-signed stand, dangerous in production
			// (disables cert verification, incl. the robot-cred Basic exchange).
			// Log loudly so it cannot leak into a real deployment unnoticed.
			log.Warn("HARBOR_INSECURE_TLS enabled: Harbor TLS verification is OFF (local stand only, never in production)")
		}
		hb = harbor.NewClient(cfg.HarborURL, cfg.HarborRobotUser, cfg.HarborRobotToken,
			cfg.HarborProjects, cfg.HarborInsecureTLS, cfg.HarborTimeout)
	default:
		return fmt.Errorf("unknown HARBOR_MODE %q", cfg.HarborMode)
	}

	var gl gitlab.Port
	var glFake *gitlab.Fake
	switch cfg.GitLabMode {
	case config.ModeFake:
		glFake = gitlab.NewFake(cfg.GitLabGitopsGroup, demoSubgroups, true /* auto-merge */)
		gl = glFake
	case config.ModeReal:
		if cfg.GitLabURL == "" || cfg.GitLabToken == "" {
			return errors.New("GITLAB_MODE=real requires GITLAB_URL and GITLAB_TOKEN")
		}
		gl = gitlab.NewClient(cfg.GitLabURL, cfg.GitLabToken, cfg.GitLabGitopsGroup, cfg.GitLabTimeout)
	default:
		return fmt.Errorf("unknown GITLAB_MODE %q", cfg.GitLabMode)
	}

	var argo argocd.Port
	var argoFake *argocd.Fake
	switch cfg.ArgoCDMode {
	case config.ModeFake:
		// The fake ArgoCD reconciles from "git": both the fake and the real
		// GitLab client implement ManifestSource, so either can drive it.
		var src argocd.ManifestSource
		if ms, ok := gl.(argocd.ManifestSource); ok {
			src = ms
		}
		argoFake = argocd.NewFake(src)
		argo = argoFake
	case config.ModeReal:
		if cfg.ArgoCDURL == "" || cfg.ArgoCDToken == "" {
			return errors.New("ARGOCD_MODE=real requires ARGOCD_URL and ARGOCD_TOKEN")
		}
		argo = argocd.NewClient(cfg.ArgoCDURL, cfg.ArgoCDToken, cfg.GitLabTimeout)
	default:
		return fmt.Errorf("unknown ARGOCD_MODE %q", cfg.ArgoCDMode)
	}

	// --- domains ---
	gitops, err := provisioning.NewGitOps(cfg.GitLabGitopsGroup, cfg.GitLabSubgroupTmpl,
		cfg.ArgoCDAppNameTmpl, cfg.ArgoCDProject, cfg.GitLabDefaultBranch)
	if err != nil {
		return err
	}
	gitops.ChartRegistry = cfg.ChartRegistry // OCI base for the chart source in application.yaml
	bus := events.New()
	catalogSvc := catalog.New(hb, c)
	if cfg.GitLabAutoMerge {
		// The poller merges the portal's own MRs with no human review. Fine for
		// demos; dangerous against a real GitLab. Log loudly so it cannot enable
		// itself in production unnoticed.
		log.Warn("GITLAB_AUTO_MERGE enabled: portal MRs are merged without review",
			"gitlab_mode", string(cfg.GitLabMode))
	}
	provSvc := provisioning.New(st, gl, argo, catalogSvc, gitops, bus, cfg.ArgoCDCluster, cfg.GitLabDefaultBranch, cfg.GitLabAutoMerge)
	provSvc.Log = observability.Component(log, "provisioning")
	pubsSvc := publications.New(st, catalogSvc)
	pubsSvc.Log = observability.Component(log, "publications")
	statusSvc := status.New(argo)

	// --- auth ---
	authn, err := buildAuth(ctx, cfg, c)
	if err != nil {
		return err
	}

	// --- poller (single replica, in-process) ---
	var reconcilers []status.Reconciler
	if argoFake != nil {
		reconcilers = append(reconcilers, status.Named("argocd-fake", argoFake)) // materialise apps from "git"
	}
	reconcilers = append(reconcilers, status.Named("provisioning", provSvc)) // advance order states
	if cfg.DriftDetection {
		reconcilers = append(reconcilers, status.Named("drift", driftReconciler{provSvc})) // flag Git-side drift
	}
	if cfg.ImportDiscovery {
		reconcilers = append(reconcilers, status.Named("import", importReconciler{provSvc})) // adopt Git-created apps
	}
	if cfg.CatalogAutodiscover {
		ownerTeam := "platform-admins"
		if len(cfg.AdminGroups) > 0 {
			ownerTeam = cfg.AdminGroups[0]
		}
		reconcilers = append(reconcilers, status.Named("catalog-discovery", discoveryReconciler{
			pubs: pubsSvc, cat: catalogSvc, ownerTeam: ownerTeam,
			categoryID: publications.DefaultDiscoveryCategory,
		}))
	}
	poller := status.NewPoller(cfg.StatusPollInterval, observability.Component(log, "poller"), reconcilers...)
	pollerDone := make(chan struct{})
	go func() {
		defer close(pollerDone)
		poller.Run(ctx)
	}()

	// --- HTTP ---
	srv := &api.Server{
		Auth: authn, Catalog: catalogSvc, Prov: provSvc, Pubs: pubsSvc, Status: statusSvc,
		Store: st, Cache: c, Bus: bus, Log: observability.Component(log, "api"), ArgoCDURL: cfg.ArgoCDURL,
		Harbor: hb, GitLab: gl, ArgoCD: argo, Reconcilers: poller,
		System: api.SystemInfo{
			HarborMode:   string(cfg.HarborMode),
			GitLabMode:   string(cfg.GitLabMode),
			ArgoCDMode:   string(cfg.ArgoCDMode),
			StoreBackend: backendName(cfg.Store, "postgres", "memory"),
			CacheBackend: backendName(cfg.Cache, "redis", "memory"),
			HarborURL:    cfg.HarborURL,
			GitLabURL:    cfg.GitLabURL,
			ArgoCDURL:    cfg.ArgoCDURL,
			AuthMode:     cfg.AuthMode,
			OIDCIssuer:   cfg.OIDCIssuer,
			GrafanaURL:   cfg.GrafanaURL,
		},
	}
	// Refresh platform-status and order gauges in-process (single replica),
	// reusing the poller interval. The metrics server below exposes the result.
	go srv.RunMetricsRefresher(ctx, cfg.StatusPollInterval)

	httpServer := &http.Server{
		Addr:              ":" + cfg.HTTPPort,
		Handler:           srv.Router(),
		ReadHeaderTimeout: 10 * time.Second,
		// Bound idle keep-alive connections and request header size. No global
		// WriteTimeout/ReadTimeout: SSE responses are long-lived (WriteTimeout
		// would cut them), and bodies are size-capped via MaxBytesReader instead.
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 1 << 20, // 1 MiB
	}

	// Prometheus /metrics on a dedicated listener, separate from the public API
	// port, so scraping stays internal-only (not exposed through the app ingress).
	metricsMux := http.NewServeMux()
	metricsMux.Handle("/metrics", api.MetricsHandler())
	metricsServer := &http.Server{
		Addr:              ":" + cfg.MetricsPort,
		Handler:           metricsMux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := metricsServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("metrics server failed", "err", err)
		}
	}()

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutCtx)
		_ = metricsServer.Shutdown(shutCtx)
	}()

	log.Info("portal starting",
		"port", cfg.HTTPPort, "metrics_port", cfg.MetricsPort, "auth", cfg.AuthMode,
		"store", cfg.Store, "cache", cfg.Cache,
		"harbor", cfg.HarborMode, "gitlab", cfg.GitLabMode, "argocd", cfg.ArgoCDMode)

	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	// Drain the poller: wait for its in-flight reconcile tick to unwind before
	// exiting, so we do not abandon a half-applied reconcile (e.g. a dangling
	// GitLab branch). Bounded so a stuck reconcile cannot hang shutdown.
	select {
	case <-pollerDone:
	case <-time.After(15 * time.Second):
		log.Warn("poller did not drain within shutdown grace")
	}
	return nil
}

// driftReconciler adapts Service.CheckDrift to the poller's status.Reconciler
// interface so drift detection runs alongside lifecycle reconciliation.
type driftReconciler struct{ s *provisioning.Service }

func (d driftReconciler) Reconcile(ctx context.Context) error { return d.s.CheckDrift(ctx) }

// importReconciler adapts Service.ImportFromGit to status.Reconciler so Git-side
// discovery runs on the poller.
type importReconciler struct{ s *provisioning.Service }

func (i importReconciler) Reconcile(ctx context.Context) error { return i.s.ImportFromGit(ctx) }

// discoveryReconciler registers charts found in Harbor as draft publications
// (owner - the admin group). It pulls the chart list from the catalog
// (admin visibility - all), with the author taken from Chart.yaml.
type discoveryReconciler struct {
	pubs       *publications.Service
	cat        *catalog.Service
	ownerTeam  string
	categoryID string
}

func (d discoveryReconciler) Reconcile(ctx context.Context) error {
	charts, err := d.cat.ListCharts(ctx, &models.User{Role: models.RoleAdmin})
	if err != nil {
		return err
	}
	refs := make([]publications.DiscoveredChart, 0, len(charts))
	for _, c := range charts {
		refs = append(refs, publications.DiscoveredChart{Project: c.Project, Name: c.Name, Author: c.Author})
	}
	return d.pubs.EnsureDiscovered(ctx, refs, d.ownerTeam, d.categoryID)
}

// backendName reports the effective backend for display on the status page:
// `match` when that's what was configured, otherwise the default `fallback`.
func backendName(configured, match, fallback string) string {
	if configured == match {
		return match
	}
	return fallback
}

func buildAuth(ctx context.Context, cfg *config.Config, c cache.Cache) (auth.Authenticator, error) {
	// OIDC is the only runtime authenticator. The no-Keycloak Dev authenticator
	// (internal/auth/dev.go) is a test stub and is never wired into the binary.
	if cfg.AuthMode != "oidc" {
		return nil, fmt.Errorf("AUTH_MODE must be \"oidc\" (dev auth is test-only); got %q", cfg.AuthMode)
	}
	// Session values are encrypted with a key derived from SESSION_SECRET; the
	// insecure default would make that encryption pointless, so refuse to start.
	if cfg.SessionSecret == config.DefaultSessionSecret {
		return nil, fmt.Errorf("SESSION_SECRET must be set to a non-default value in AUTH_MODE=oidc")
	}
	sessions := auth.NewSessionStore(c, cfg.SessionTTL, cfg.SessionSecret)
	rbac := auth.RBAC{
		AdminGroups:    cfg.AdminGroups,
		SupportGroups:  cfg.SupportGroups,
		SecurityGroups: cfg.SecurityGroups,
		TeamPrefix:     cfg.TeamGroupPrefix,
	}
	if cfg.TeamGroupRegex != "" {
		re, err := regexp.Compile(cfg.TeamGroupRegex)
		if err != nil {
			return nil, fmt.Errorf("RBAC_TEAM_GROUP_REGEX: %w", err)
		}
		rbac.TeamRegex = re
	}
	return auth.NewOIDC(ctx, auth.OIDCConfig{
		Issuer:       cfg.OIDCIssuer,
		ClientID:     cfg.OIDCClientID,
		ClientSecret: cfg.OIDCSecret,
		RedirectURL:  cfg.OIDCRedirect,
		Scopes:       cfg.OIDCScopes,
		CookieName:   cfg.SessionCookie,
		Secure:       cfg.CookieSecure,
		SessionTTL:   cfg.SessionTTL,
		PostLogin:    cfg.OIDCPostLogin,
		PostLogout:   cfg.OIDCPostLogout,
	}, sessions, rbac)
}
