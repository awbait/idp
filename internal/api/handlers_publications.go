package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"console/internal/auth"
	"console/internal/catalog"
	"console/internal/publications"
	"console/internal/store"
	"console/internal/views"
	"console/pkg/models"
	"github.com/go-chi/chi/v5"
)

// --- categories ---

func (s *Server) handleListCategories(w http.ResponseWriter, r *http.Request) {
	cats, err := s.Pubs.ListCategories(r.Context())
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, cats)
}

func (s *Server) handleCreateCategory(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var c models.Category
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	if err := s.Pubs.CreateCategory(r.Context(), u, &c); err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (s *Server) handleUpdateCategory(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var c models.Category
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	c.ID = chi.URLParam(r, "id")
	if err := s.Pubs.UpdateCategory(r.Context(), u, &c); err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleDeleteCategory(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if err := s.Pubs.DeleteCategory(r.Context(), u, chi.URLParam(r, "id")); err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

// --- publications ---

type createPubReq struct {
	Chart      string `json:"chart"` // "project/name"
	CategoryID string `json:"category_id"`
	OwnerTeam  string `json:"owner_team"`
}

type patchPubReq struct {
	CategoryID *string         `json:"category_id"`
	OwnerTeam  *string         `json:"owner_team"`
	View       json.RawMessage `json:"view"` // view-document draft; null/absent = leave unchanged
}

type rejectPubReq struct {
	Comment string `json:"comment"`
}

func (s *Server) handleListPublications(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	pubs, err := s.Pubs.List(r.Context(), store.PublicationFilter{
		Status: models.PublicationStatus(q.Get("status")),
		Team:   q.Get("team"),
		Chart:  q.Get("chart"),
	})
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pubs)
}

func (s *Server) handleCreatePublication(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var body createPubReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	project, name, ok := strings.Cut(body.Chart, "/")
	if !ok {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed", `chart must be "project/name"`)
		return
	}
	pub, err := s.Pubs.Create(r.Context(), u, publications.CreateInput{
		ChartProject: project, ChartName: name,
		CategoryID: body.CategoryID, OwnerTeam: body.OwnerTeam,
	})
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, pub)
}

func (s *Server) handleGetPublication(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	pub, err := s.Pubs.Get(r.Context(), id)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	evs, _ := s.Pubs.ListEvents(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{
		"publication": pub,
		"events":      evs,
	})
}

func (s *Server) handlePatchPublication(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var body patchPubReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	pub, err := s.Pubs.Update(r.Context(), u, chi.URLParam(r, "id"), publications.UpdateInput{
		CategoryID: body.CategoryID, OwnerTeam: body.OwnerTeam, View: body.View,
	})
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pub)
}

type validatePubReq struct {
	View json.RawMessage `json:"view"`
}

// handleValidatePublication: live validation of a draft view from the builder.
// Always returns 200 with a list of issues (empty = document is valid).
func (s *Server) handleValidatePublication(w http.ResponseWriter, r *http.Request) {
	var body validatePubReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.View) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	issues, err := s.Pubs.ValidateView(r.Context(), chi.URLParam(r, "id"), body.View)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	if issues == nil {
		issues = []views.Issue{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"issues": issues})
}

func (s *Server) handleSubmitPublication(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	pub, err := s.Pubs.Submit(r.Context(), u, chi.URLParam(r, "id"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pub)
}

func (s *Server) handleWithdrawPublication(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	pub, err := s.Pubs.Withdraw(r.Context(), u, chi.URLParam(r, "id"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pub)
}

func (s *Server) handleApprovePublication(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	pub, err := s.Pubs.Approve(r.Context(), u, chi.URLParam(r, "id"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pub)
}

func (s *Server) handleRejectPublication(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var body rejectPubReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	pub, err := s.Pubs.Reject(r.Context(), u, chi.URLParam(r, "id"), strings.TrimSpace(body.Comment))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, pub)
}

// --- publication versions (per-version view + approval FSM) ---

// handlePendingVersions is the admin approval queue for per-version submissions.
func (s *Server) handlePendingVersions(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	if !u.IsAdmin() {
		writeErr(w, http.StatusForbidden, "forbidden", "admin only")
		return
	}
	pending, err := s.Pubs.PendingVersions(r.Context())
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	if pending == nil {
		pending = []publications.PendingVersion{}
	}
	writeJSON(w, http.StatusOK, pending)
}

func (s *Server) handleListVersions(w http.ResponseWriter, r *http.Request) {
	versions, err := s.Pubs.ListVersions(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	if versions == nil {
		versions = []*models.PublicationVersion{}
	}
	writeJSON(w, http.StatusOK, versions)
}

type saveVersionReq struct {
	View json.RawMessage `json:"view"`
}

func (s *Server) handleSaveVersionView(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var body saveVersionReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.View) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	v, err := s.Pubs.SaveVersionView(r.Context(), u, chi.URLParam(r, "id"), chi.URLParam(r, "version"), body.View)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// handleValidateVersion is a live builder check of a draft view against a
// specific version's schema; always 200 with a list of issues (empty = valid).
func (s *Server) handleValidateVersion(w http.ResponseWriter, r *http.Request) {
	var body validatePubReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.View) == 0 {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	issues, err := s.Pubs.ValidateVersionView(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "version"), body.View)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	if issues == nil {
		issues = []views.Issue{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"issues": issues})
}

func (s *Server) handleSubmitVersion(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	v, err := s.Pubs.SubmitVersion(r.Context(), u, chi.URLParam(r, "id"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleWithdrawVersion(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	v, err := s.Pubs.WithdrawVersion(r.Context(), u, chi.URLParam(r, "id"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleApproveVersion(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	v, err := s.Pubs.ApproveVersion(r.Context(), u, chi.URLParam(r, "id"), chi.URLParam(r, "version"))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) handleRejectVersion(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var body rejectPubReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	v, err := s.Pubs.RejectVersion(r.Context(), u, chi.URLParam(r, "id"), chi.URLParam(r, "version"), strings.TrimSpace(body.Comment))
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

type orderableReq struct {
	Orderable bool `json:"orderable"`
}

func (s *Server) handleSetVersionOrderable(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var body orderableReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	v, err := s.Pubs.SetVersionOrderable(r.Context(), u, chi.URLParam(r, "id"), chi.URLParam(r, "version"), body.Orderable)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

type recommendedReq struct {
	Version string `json:"version"`
}

func (s *Server) handleSetRecommendedVersion(w http.ResponseWriter, r *http.Request) {
	u := auth.UserFrom(r.Context())
	var body recommendedReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	if err := s.Pubs.SetRecommendedVersion(r.Context(), u, chi.URLParam(r, "id"), strings.TrimSpace(body.Version)); err != nil {
		writeDomainErr(w, err)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

// --- catalog overlay & active view ---

// publicationSummary is a lightweight projection of a publication for the
// catalog/menu (without view-document bodies).
type publicationSummary struct {
	ID            string                   `json:"id"`
	CategoryID    string                   `json:"category_id"`
	OwnerTeam     string                   `json:"owner_team"`
	CreatedBy     string                   `json:"created_by"`
	CreatedByName string                   `json:"created_by_name"`
	Status        models.PublicationStatus `json:"status"`
	Published     bool                     `json:"published"`      // has an active approved view
	HasOrderView  bool                     `json:"has_order_view"` // approved view contains views.order
	// ApprovedViewVersion is the "blessed" chart version: the view is checked up
	// to it, and orders on a lower version can be upgraded.
	ApprovedViewVersion string `json:"approved_view_version,omitempty"`
	// RecommendedVersion is the version served by default for new orders (the
	// owner's choice, or the highest orderable+APPROVED as a fall back). Empty
	// when the service has no orderable versions yet (multi-version publications).
	RecommendedVersion string `json:"recommended_version,omitempty"`
	// OrderableVersions are all versions available for ordering (allowlist),
	// highest first - the catalog card shows the first as the main chip and the
	// rest as "+N".
	OrderableVersions []string `json:"orderable_versions,omitempty"`
	// ApprovedDescription is the chart description at approval time (the catalog
	// shows this, not the live one from Harbor).
	ApprovedDescription string `json:"approved_description,omitempty"`
	// ApprovedIconURL is the chart icon at approval time (catalog/profile show
	// this, not the live one from Harbor).
	ApprovedIconURL string `json:"approved_icon_url,omitempty"`
}

type catalogChart struct {
	models.Chart
	Publication *publicationSummary `json:"publication,omitempty"`
	// Missing: the publication references a chart that is (no longer) in Harbor.
	Missing bool `json:"missing,omitempty"`
}

// handleCatalog returns the catalog in one request: live Harbor listing of the
// configured projects + categories + overlaid publication metadata. Charts
// without a publication stay visible (live catalog); publications whose charts
// lie outside the configured projects (added by path) are fetched from Harbor
// one by one.
func (s *Server) handleCatalog(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := auth.UserFrom(ctx)
	charts, err := s.Catalog.ListCharts(ctx, u)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	cats, err := s.Pubs.ListCategories(ctx)
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	pubs, err := s.Pubs.List(ctx, store.PublicationFilter{})
	if err != nil {
		writeDomainErr(w, err)
		return
	}
	byChart := make(map[string]*publicationSummary, len(pubs))
	for _, p := range pubs {
		// Per-version allowlist projection (multi-version publications); empty for
		// services that have no orderable versions yet. Best-effort: a lookup error
		// degrades to the legacy single-view fields below.
		recommended, orderable, _ := s.Pubs.CatalogVersions(ctx, p)
		byChart[p.ChartProject+"/"+p.ChartName] = &publicationSummary{
			ID:                  p.ID,
			CategoryID:          p.CategoryID,
			OwnerTeam:           p.OwnerTeam,
			CreatedBy:           p.CreatedBy,
			CreatedByName:       p.CreatedByName,
			Status:              p.Status,
			Published:           p.Published() || len(orderable) > 0,
			HasOrderView:        hasOrderView(p.ApprovedViewJSON),
			ApprovedViewVersion: p.ApprovedViewVersion,
			ApprovedDescription: p.ApprovedDescription,
			ApprovedIconURL:     p.ApprovedIconURL,
			RecommendedVersion:  recommended,
			OrderableVersions:   orderable,
		}
	}
	out := make([]catalogChart, 0, len(charts))
	listed := make(map[string]bool, len(charts))
	for _, c := range charts {
		listed[c.Project+"/"+c.Name] = true
		out = append(out, catalogChart{Chart: c, Publication: byChart[c.Project+"/"+c.Name]})
	}
	// Publications for charts outside the Harbor listing, added by an arbitrary
	// path: fetch metadata one by one; a chart gone from Harbor is shown with the
	// missing flag (so the owner sees the publication is orphaned).
	for _, p := range pubs {
		key := p.ChartProject + "/" + p.ChartName
		if listed[key] {
			continue
		}
		entry := catalogChart{
			Chart:       models.Chart{Project: p.ChartProject, Name: p.ChartName},
			Publication: byChart[key],
		}
		if ch, cerr := s.Catalog.GetChart(ctx, p.ChartProject, p.ChartName); cerr == nil {
			if !catalog.VisibleTo(ch, u) {
				continue
			}
			entry.Chart = *ch
		} else {
			entry.Missing = true
		}
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"categories": cats,
		"charts":     out,
	})
}

type checkChartReq struct {
	Path string `json:"path"` // "project/name"
}

// handleCheckChart checks a chart at an arbitrary Harbor path before
// publication: existence + file completeness of the latest version.
func (s *Server) handleCheckChart(w http.ResponseWriter, r *http.Request) {
	var body checkChartReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON")
		return
	}
	path := strings.Trim(strings.TrimSpace(body.Path), "/")
	project, name, ok := strings.Cut(path, "/")
	if !ok || project == "" || name == "" {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed",
			`путь должен иметь вид "project/name"`)
		return
	}
	if strings.Contains(name, "/") {
		writeErr(w, http.StatusUnprocessableEntity, "validation_failed",
			"вложенные пути (project/a/b) пока не поддерживаются, укажите project/name")
		return
	}
	res, err := s.Catalog.CheckChart(r.Context(), project, name)
	if err != nil {
		// Log the raw upstream error; return a generic message so Harbor
		// host/transport details do not leak to the client.
		s.logger().LogAttrs(r.Context(), slog.LevelWarn, "chart check failed",
			slog.String("chart", project+"/"+name), slog.String("err", err.Error()))
		writeErr(w, http.StatusBadGateway, "upstream_unavailable", "upstream unavailable")
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// hasOrderView reports whether the view-document contains the views.order
// projection (used to build the order form and the left-menu item).
func hasOrderView(view json.RawMessage) bool {
	if len(view) == 0 {
		return false
	}
	var doc struct {
		Views map[string]json.RawMessage `json:"views"`
	}
	if err := json.Unmarshal(view, &doc); err != nil {
		return false
	}
	_, ok := doc.Views["order"]
	return ok
}

// handleGetChartView returns a chart's approved view. With ?version=X it returns
// that orderable version's view (multi-version publications); without it, the
// legacy single active approved view.
func (s *Server) handleGetChartView(w http.ResponseWriter, r *http.Request) {
	project, name := chi.URLParam(r, "project"), chi.URLParam(r, "name")
	var (
		view []byte
		err  error
	)
	if version := r.URL.Query().Get("version"); version != "" {
		view, err = s.Pubs.ActiveViewVersion(r.Context(), project, name, version)
	} else {
		view, err = s.Pubs.ActiveView(r.Context(), project, name)
	}
	if err != nil {
		if errors.Is(err, models.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "no approved view for chart")
			return
		}
		writeDomainErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(view)
}
