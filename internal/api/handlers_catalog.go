package api

import (
	"net/http"
	"strconv"

	"console/internal/auth"
	"github.com/go-chi/chi/v5"
)

// authorizeChart enforces the chart visibility allowlist for the request user
// before any per-chart read. It writes a 404 and returns false when the chart is
// hidden or missing, so callers can `if !s.authorizeChart(...) { return }`.
// Without this gate a user could read a chart hidden from the listing by its URL.
func (s *Server) authorizeChart(w http.ResponseWriter, r *http.Request) bool {
	u := auth.UserFrom(r.Context())
	if _, err := s.Catalog.Authorize(r.Context(), u, chi.URLParam(r, "project"), chi.URLParam(r, "name")); err != nil {
		writeDomainErr(w, err)
		return false
	}
	return true
}

func (s *Server) handleListCharts(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	charts, err := s.Catalog.ListCharts(r.Context(), u)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, charts)
}

func (s *Server) handleGetChart(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	chart, err := s.Catalog.Authorize(r.Context(), u, chi.URLParam(r, "project"), chi.URLParam(r, "name"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, chart)
}

func (s *Server) handleGetVersion(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeChart(w, r) {
		return
	}
	v, err := s.Catalog.GetVersion(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleGetValues(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeChart(w, r) {
		return
	}
	b, err := s.Catalog.GetValues(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
	_, _ = w.Write(b)
}

func (s *Server) handleGetReadme(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeChart(w, r) {
		return
	}
	b, err := s.Catalog.GetReadme(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	_, _ = w.Write(b)
}

func (s *Server) handleGetSchema(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeChart(w, r) {
		return
	}
	b, err := s.Catalog.GetSchema(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(b)
}

func (s *Server) handleGetChangelog(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeChart(w, r) {
		return
	}
	e, err := s.Catalog.GetChangelog(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (s *Server) handleAggregatedChangelog(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeChart(w, r) {
		return
	}
	limit := 20
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	entries, err := s.Catalog.GetAggregatedChangelog(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), limit)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}
