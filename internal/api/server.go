package api

import (
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"console/internal/argocd"
	"console/internal/auth"
	"console/internal/cache"
	"console/internal/catalog"
	"console/internal/events"
	"console/internal/gitlab"
	"console/internal/harbor"
	"console/internal/provisioning"
	"console/internal/publications"
	"console/internal/spa"
	"console/internal/status"
	"console/internal/store"
	"console/internal/webhooks"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const (
	// maxRequestBodyBytes caps a decoded request body to bound memory against a
	// hostile client (Values/View JSON are otherwise unbounded). SSE requests
	// carry no body, so this does not affect streams.
	maxRequestBodyBytes = 4 << 20 // 4 MiB
	// maxSSEStreams caps concurrent Server-Sent Events streams process-wide; each
	// holds a goroutine, a bus subscription and a socket until the client leaves.
	maxSSEStreams = 256
)

// Server holds dependencies for the HTTP API.
type Server struct {
	Auth    auth.Authenticator
	Catalog *catalog.Service
	Prov    *provisioning.Service
	Pubs    *publications.Service
	Status  *status.Service
	Store   store.Store
	Cache   cache.Cache
	Bus     *events.Bus
	Log     *slog.Logger
	// ArgoCDURL is the ArgoCD UI base (ARGOCD_URL); empty when not configured
	// (e.g. fake mode). Used to build per-app deep links in the request detail.
	ArgoCDURL string

	// Upstream ports + their configured modes, used by the system status page
	// (GET /api/v1/status) to probe and report integration health.
	Harbor harbor.Port
	GitLab gitlab.Port
	ArgoCD argocd.Port
	System SystemInfo

	// Reconcilers exposes the background poller's per-loop health to the status
	// page (GET /api/v1/status). Optional: nil omits the reconcilers section.
	Reconcilers reconcilerSnapshotter

	// Webhooks handles inbound upstream webhooks (GitLab MR, Harbor push). Routes
	// register per-source only when that source's secret is set; nil omits them
	// entirely (e.g. tests).
	Webhooks *webhooks.Handler

	// sseStreams counts live SSE streams to enforce maxSSEStreams (zero value is
	// ready to use; no constructor needed).
	sseStreams atomic.Int64
}

// MetricsHandler returns the Prometheus /metrics handler. It is served on a
// dedicated listener (see cmd/portal), separate from the API, so scraping is not
// reachable through the public app ingress.
func MetricsHandler() http.Handler {
	return promhttp.Handler()
}

// Router builds the HTTP handler tree.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.Recoverer)
	r.Use(s.requestLogger)

	// public
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/ready", s.handleReady)
	// /metrics is served on a separate listener (see MetricsHandler), not here.

	r.Route("/api/v1", func(r chi.Router) {
		r.Use(maxBytes(maxRequestBodyBytes)) // bound request-body memory (GET/SSE carry none)

		// auth endpoints (unauthenticated)
		r.Get("/auth/login", s.Auth.Login)
		r.Get("/auth/callback", s.Auth.Callback)
		r.Get("/auth/logout", s.Auth.Logout)

		// upstream webhooks (machine-to-machine, authenticated by a shared secret
		// in-handler, not by session): registered only for sources whose secret
		// is configured.
		if s.Webhooks != nil {
			if s.Webhooks.GitLabEnabled() {
				r.Post("/webhooks/gitlab", s.Webhooks.GitLab)
			}
			if s.Webhooks.HarborEnabled() {
				r.Post("/webhooks/harbor", s.Webhooks.Harbor)
			}
		}

		// authenticated
		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(s.Auth))

			r.Get("/auth/me", s.handleMe)

			// portal version + changelog ("About" page); informational, any role
			r.Get("/info", s.handleAbout)
			r.Get("/changelog", s.handleChangelog)

			// system status (integrations + storage health)
			r.Get("/status", s.handleSystemStatus)

			// catalog
			r.Get("/charts", s.handleListCharts)
			r.Post("/charts/check", s.handleCheckChart) // check a chart at an arbitrary path
			r.Get("/charts/{project}/{name}", s.handleGetChart)
			r.Get("/charts/{project}/{name}/changelog/aggregated", s.handleAggregatedChangelog)
			r.Get("/charts/{project}/{name}/view", s.handleGetChartView) // active approved view (static wins over {version})
			r.Get("/charts/{project}/{name}/{version}", s.handleGetVersion)
			r.Get("/charts/{project}/{name}/{version}/values", s.handleGetValues)
			r.Get("/charts/{project}/{name}/{version}/readme", s.handleGetReadme)
			r.Get("/charts/{project}/{name}/{version}/changelog", s.handleGetChangelog)
			r.Get("/charts/{project}/{name}/{version}/schema", s.handleGetSchema)

			// catalog metadata: categories + publications over the Harbor listing
			r.Get("/catalog", s.handleCatalog)
			r.Get("/categories", s.handleListCategories)
			r.Post("/categories", s.handleCreateCategory)        // admin
			r.Patch("/categories/{id}", s.handleUpdateCategory)  // admin
			r.Delete("/categories/{id}", s.handleDeleteCategory) // admin

			// chart publications: metadata + view builder + approval
			r.Get("/publications", s.handleListPublications)
			r.Post("/publications", s.handleCreatePublication)
			r.Get("/publications/{id}", s.handleGetPublication)
			r.Patch("/publications/{id}", s.handlePatchPublication)
			r.Post("/publications/{id}/validate", s.handleValidatePublication) // live check from the builder
			r.Post("/publications/{id}/submit", s.handleSubmitPublication)
			r.Post("/publications/{id}/withdraw", s.handleWithdrawPublication) // withdraw from approval
			r.Post("/publications/{id}/approve", s.handleApprovePublication)   // admin
			r.Post("/publications/{id}/reject", s.handleRejectPublication)     // admin

			// per-version view builder + approval FSM (multi-version publications)
			r.Get("/publications/pending-versions", s.handlePendingVersions) // admin queue (static path wins over /{id})
			r.Get("/publications/{id}/versions", s.handleListVersions)
			r.Put("/publications/{id}/versions/{version}", s.handleSaveVersionView)
			r.Post("/publications/{id}/versions/{version}/validate", s.handleValidateVersion)
			r.Post("/publications/{id}/versions/{version}/submit", s.handleSubmitVersion)
			r.Post("/publications/{id}/versions/{version}/withdraw", s.handleWithdrawVersion)
			r.Post("/publications/{id}/versions/{version}/approve", s.handleApproveVersion) // admin
			r.Post("/publications/{id}/versions/{version}/reject", s.handleRejectVersion)   // admin
			r.Post("/publications/{id}/versions/{version}/orderable", s.handleSetVersionOrderable)
			r.Post("/publications/{id}/recommended", s.handleSetRecommendedVersion)

			// requests
			r.Get("/requests", s.handleListRequests)
			r.Post("/requests", s.handleCreateRequest)
			r.Get("/requests/events", s.handleAllRequestEvents) // global stream for lists (static path wins over /{id})
			r.Get("/requests/{id}", s.handleGetRequest)
			r.Patch("/requests/{id}", s.handlePatchRequest)
			r.Delete("/requests/{id}", s.handleDeleteRequest)
			r.Post("/requests/{id}/rename", s.handleRenameRequest)
			r.Post("/requests/{id}/submit", s.handleSubmitRequest)
			r.Post("/requests/{id}/sync", s.handleSyncRequest)
			r.Post("/requests/{id}/pull", s.handlePullRequest) // adopt Git state into the portal
			r.Get("/requests/{id}/events", s.handleRequestEvents)

			// applications
			r.Get("/applications", s.handleListApplications)
			r.Get("/applications/{name}", s.handleGetApplication)
			r.Get("/applications/{name}/events", s.handleAppEvents)
		})
	})

	// SPA: serve the embedded frontend for everything not matched above (assets +
	// client-side routes). Registered last so /health, /metrics and /api win.
	if dist, err := spa.FS(); err != nil {
		s.logger().Error("spa assets unavailable", "err", err)
	} else if h, herr := spaHandler(dist); herr != nil {
		s.logger().Error("spa handler init failed", "err", herr)
	} else {
		r.Handle("/*", h)
	}

	return r
}

// maxBytes wraps each request body in http.MaxBytesReader so a handler cannot
// read more than n bytes, bounding memory from a hostile client. Requests
// without a body (GET, SSE) are unaffected.
func maxBytes(n int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil {
				r.Body = http.MaxBytesReader(w, r.Body, n)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// logger returns the configured logger, or the default if none was wired (tests).
func (s *Server) logger() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// requestLogger logs one line per HTTP request with method, path, status, size
// and latency. Liveness/scrape endpoints (/health, /ready, /metrics) log at
// debug so routine polling does not drown the log; everything else logs at info.
func (s *Server) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		start := time.Now()
		next.ServeHTTP(ww, r)

		level := slog.LevelInfo
		switch r.URL.Path {
		case "/health", "/ready":
			level = slog.LevelDebug
		}
		s.logger().LogAttrs(r.Context(), level, "http request",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", ww.Status()),
			slog.Int("bytes", ww.BytesWritten()),
			slog.Int64("duration_ms", time.Since(start).Milliseconds()),
			slog.String("request_id", middleware.GetReqID(r.Context())),
		)
	})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	// /ready is public (pre-auth); log the upstream detail but return a generic
	// message so host/port/driver internals are not exposed to anonymous callers.
	if err := s.Store.Ping(ctx); err != nil {
		s.logger().LogAttrs(ctx, slog.LevelWarn, "readiness check failed",
			slog.String("component", "store"), slog.String("err", err.Error()))
		writeErr(w, http.StatusServiceUnavailable, "not_ready", "store unavailable")
		return
	}
	if err := s.Cache.Ping(ctx); err != nil {
		s.logger().LogAttrs(ctx, slog.LevelWarn, "readiness check failed",
			slog.String("component", "cache"), slog.String("err", err.Error()))
		writeErr(w, http.StatusServiceUnavailable, "not_ready", "cache unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, auth.UserFrom(r.Context()))
}
