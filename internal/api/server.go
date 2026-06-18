package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"console/internal/argocd"
	"console/internal/auth"
	"console/internal/cache"
	"console/internal/catalog"
	"console/internal/events"
	"console/internal/gitlab"
	"console/internal/harbor"
	"console/internal/provisioning"
	"console/internal/publications"
	"console/internal/status"
	"console/internal/store"
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
	r.Handle("/metrics", promhttp.Handler())

	r.Route("/api/v1", func(r chi.Router) {
		// auth endpoints (unauthenticated)
		r.Get("/auth/login", s.Auth.Login)
		r.Get("/auth/callback", s.Auth.Callback)
		r.Get("/auth/logout", s.Auth.Logout)

		// authenticated
		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(s.Auth))

			r.Get("/auth/me", s.handleMe)

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

	return r
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
		case "/health", "/ready", "/metrics":
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
	if err := s.Store.Ping(ctx); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "not_ready", "store: "+err.Error())
		return
	}
	if err := s.Cache.Ping(ctx); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "not_ready", "cache: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, auth.UserFrom(r.Context()))
}
