package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"console/internal/auth"
	"console/internal/provisioning"
	"console/internal/store"
	"console/pkg/models"
)

type createReq struct {
	Chart       string         `json:"chart"` // "project/name"
	Version     string         `json:"version"`
	Team        string         `json:"team"`
	ServiceName string         `json:"service_name"`
	DisplayName string         `json:"display_name"`
	Cluster     string         `json:"cluster"`   // ArgoCD destination cluster
	Namespace   string         `json:"namespace"` // ArgoCD destination namespace
	Values      map[string]any `json:"values"`
	Draft       bool           `json:"draft"` // persist as DRAFT without opening an MR
}

type patchReq struct {
	Version     string         `json:"version"`
	ServiceName string         `json:"service_name"` // draft only
	DisplayName string         `json:"display_name"` // draft only
	Cluster     string         `json:"cluster"`      // draft only
	Namespace   string         `json:"namespace"`    // draft only
	Values      map[string]any `json:"values"`
}

func (s *Server) handleListRequests(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	q := r.URL.Query()
	f := store.RequestFilter{
		Team:           q.Get("team"),
		Status:         models.RequestStatus(q.Get("status")),
		Chart:          q.Get("chart"),
		IncludeDeleted: q.Get("include_deleted") == "true",
	}
	reqs, err := s.Prov.List(r.Context(), u, f)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, reqs)
}

func (s *Server) handleCreateRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var body createReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	project, name, ok := strings.Cut(body.Chart, "/")
	if !ok {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", `chart must be "project/name"`)
		return
	}
	req, err := s.Prov.Create(r.Context(), u, provisioning.CreateInput{
		ChartProject: project, ChartName: name, Version: body.Version,
		Team: body.Team, ServiceName: body.ServiceName, DisplayName: body.DisplayName,
		Cluster: body.Cluster, Namespace: body.Namespace,
		Values: body.Values, Draft: body.Draft,
	})
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, req)
}

func (s *Server) handleGetRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	id := chi.URLParam(r, "id")
	req, err := s.Prov.Get(r.Context(), u, id)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	mrs, _ := s.Prov.ListMRs(r.Context(), id)
	evs, _ := s.Prov.ListEvents(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{
		"request":        req,
		"merge_requests": mrs,
		"events":         evs,
		"argocd_url":     s.argocdAppURL(req),
	})
}

// argocdAppURL builds a deep link to the order's ArgoCD Application, or "" when
// ArgoCD isn't configured / the app doesn't exist yet (draft).
func (s *Server) argocdAppURL(req *models.Request) string {
	if s.ArgoCDURL == "" || req.ArgoCDAppName == "" || req.Status == models.StatusDraft {
		return ""
	}
	return strings.TrimRight(s.ArgoCDURL, "/") + "/applications/" + req.ArgoCDAppName
}

func (s *Server) handlePatchRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var body patchReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	req, err := s.Prov.Update(r.Context(), u, chi.URLParam(r, "id"), provisioning.UpdateInput{
		Version: body.Version, ServiceName: body.ServiceName, DisplayName: body.DisplayName,
		Cluster: body.Cluster, Namespace: body.Namespace, Values: body.Values,
	})
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, req)
}

type renameReq struct {
	DisplayName string `json:"display_name"`
}

// handleRenameRequest changes only the cosmetic display name (no MR, any status).
func (s *Server) handleRenameRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var body renameReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	req, err := s.Prov.Rename(r.Context(), u, chi.URLParam(r, "id"), strings.TrimSpace(body.DisplayName))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, req)
}

func (s *Server) handleSubmitRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	req, err := s.Prov.Submit(r.Context(), u, chi.URLParam(r, "id"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, req)
}

func (s *Server) handleDeleteRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	req, err := s.Prov.Delete(r.Context(), u, chi.URLParam(r, "id"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, req)
}

func (s *Server) handleSyncRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if err := s.Prov.ForceSync(r.Context(), u, chi.URLParam(r, "id")); err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "sync_requested"})
}

// handlePullRequest adopts the order's current Git state (values + version) into
// the portal, clearing drift. GitOps pull - does not write to Git.
func (s *Server) handlePullRequest(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	req, err := s.Prov.PullFromGit(r.Context(), u, chi.URLParam(r, "id"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, req)
}
