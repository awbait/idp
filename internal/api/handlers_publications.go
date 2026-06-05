package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"idp/internal/auth"
	"idp/internal/catalog"
	"idp/internal/publications"
	"idp/internal/store"
	"idp/internal/views"
	"idp/pkg/models"
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
	View       json.RawMessage `json:"view"` // черновик view-документа; null/absent = не менять
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

// handleValidatePublication — live-валидация черновика view из конструктора:
// всегда 200 со списком проблем (пустой = документ валиден).
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

// --- catalog overlay & active view ---

// publicationSummary — лёгкая проекция публикации для каталога/меню
// (без тел view-документов).
type publicationSummary struct {
	ID            string                   `json:"id"`
	CategoryID    string                   `json:"category_id"`
	OwnerTeam     string                   `json:"owner_team"`
	CreatedBy     string                   `json:"created_by"`
	CreatedByName string                   `json:"created_by_name"`
	Status        models.PublicationStatus `json:"status"`
	Published     bool                     `json:"published"`      // есть действующая approved-view
	HasOrderView  bool                     `json:"has_order_view"` // approved-view содержит views.order
}

type catalogChart struct {
	models.Chart
	Publication *publicationSummary `json:"publication,omitempty"`
	// Missing: публикация ссылается на чарт, которого (уже) нет в Harbor.
	Missing bool `json:"missing,omitempty"`
}

// handleCatalog — каталог одним запросом: живой Harbor-листинг настроенных
// проектов + категории + наложенные метаданные публикаций. Чарты без публикации
// остаются видимыми (живой каталог); публикации, чьи чарты лежат вне настроенных
// проектов (добавлены по пути), дотягиваются из Harbor поштучно.
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
		byChart[p.ChartProject+"/"+p.ChartName] = &publicationSummary{
			ID:            p.ID,
			CategoryID:    p.CategoryID,
			OwnerTeam:     p.OwnerTeam,
			CreatedBy:     p.CreatedBy,
			CreatedByName: p.CreatedByName,
			Status:        p.Status,
			Published:     p.Published(),
			HasOrderView:  hasOrderView(p.ApprovedViewJSON),
		}
	}
	out := make([]catalogChart, 0, len(charts))
	listed := make(map[string]bool, len(charts))
	for _, c := range charts {
		listed[c.Project+"/"+c.Name] = true
		out = append(out, catalogChart{Chart: c, Publication: byChart[c.Project+"/"+c.Name]})
	}
	// Публикации чартов вне Harbor-листинга: добавлены по произвольному пути —
	// дотягиваем метаданные поштучно; пропавший из Harbor чарт показываем с
	// пометкой missing (владельцу видно, что публикация осиротела).
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

// handleCheckChart проверяет чарт по произвольному пути в Harbor перед
// публикацией: существование + комплектность файлов последней версии.
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
			"вложенные пути (project/a/b) пока не поддерживаются — укажите project/name")
		return
	}
	res, err := s.Catalog.CheckChart(r.Context(), project, name)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "upstream_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// hasOrderView сообщает, содержит ли view-документ проекцию views.order
// (по ней строится форма заказа и пункт в левом меню).
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

// handleGetChartView отдаёт действующую согласованную view чарта.
func (s *Server) handleGetChartView(w http.ResponseWriter, r *http.Request) {
	view, err := s.Pubs.ActiveView(r.Context(), chi.URLParam(r, "project"), chi.URLParam(r, "name"))
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
