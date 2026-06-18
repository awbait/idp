package api

import (
	"net/http"
	"strconv"

	"console/internal/auth"
	"github.com/go-chi/chi/v5"
)

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
	chart, err := s.Catalog.GetChart(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, chart)
}

func (s *Server) handleGetVersion(w http.ResponseWriter, r *http.Request) {
	v, err := s.Catalog.GetVersion(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleGetValues(w http.ResponseWriter, r *http.Request) {
	b, err := s.Catalog.GetValues(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
	_, _ = w.Write(b)
}

func (s *Server) handleGetReadme(w http.ResponseWriter, r *http.Request) {
	b, err := s.Catalog.GetReadme(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	_, _ = w.Write(b)
}

func (s *Server) handleGetSchema(w http.ResponseWriter, r *http.Request) {
	b, err := s.Catalog.GetSchema(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(b)
}

func (s *Server) handleGetChangelog(w http.ResponseWriter, r *http.Request) {
	e, err := s.Catalog.GetChangelog(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (s *Server) handleAggregatedChangelog(w http.ResponseWriter, r *http.Request) {
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
