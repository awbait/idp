package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"idp/internal/auth"
)

func (s *Server) handleListApplications(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	apps, err := s.Status.ListApplications(r.Context(), u)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, apps)
}

func (s *Server) handleGetApplication(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	app, err := s.Status.GetApplication(r.Context(), u, chi.URLParam(r, "name"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, app)
}

// handleAllRequestEvents streams status changes for ALL requests (a global
// topic) so list views can refresh live. The payload is only a "something
// changed" signal - the client re-fetches the team-scoped list on each event.
func (s *Server) handleAllRequestEvents(w http.ResponseWriter, r *http.Request) {
	s.stream(w, r, "requests")
}

func (s *Server) handleRequestEvents(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := chi.URLParam(r, "id")
	if _, err := s.Prov.Get(r.Context(), u, id); err != nil { // authz
		writeDomainErr(w, err)
		return
	}
	s.stream(w, r, "request:"+id)
}

func (s *Server) handleAppEvents(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	name := chi.URLParam(r, "name")
	if _, err := s.Status.GetApplication(r.Context(), u, name); err != nil { // authz
		writeDomainErr(w, err)
		return
	}
	s.stream(w, r, "app:"+name)
}
