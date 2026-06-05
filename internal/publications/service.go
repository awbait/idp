// Package publications реализует «публикации чартов»: портальные метаданные
// каталога (категория, владелец) и согласование view-документов.
//
// FSM черновика view: DRAFT → PENDING → APPROVED | REJECTED → DRAFT (правка).
// Approved-версия (ApprovedViewJSON) продолжает обслуживать формы заказа, пока
// новый черновик находится на согласовании.
package publications

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"idp/internal/store"
	"idp/pkg/models"
	"github.com/google/uuid"
)

var (
	ErrForbidden = errors.New("forbidden")
	// ErrPendingLocked: черновик на согласовании — правки заморожены до решения админа.
	ErrPendingLocked = errors.New("publication is pending review")
)

// ValidationError — ошибка валидации входных данных (422 в API).
type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

func invalid(format string, a ...any) error {
	return &ValidationError{Message: fmt.Sprintf(format, a...)}
}

// Service owns publication metadata and the view-approval workflow.
type Service struct {
	store store.Store
}

func New(st store.Store) *Service { return &Service{store: st} }

func newID() string { return uuid.Must(uuid.NewV7()).String() }

// canManage: управление публикацией — участник группы-владельца или админ.
func canManage(u *models.User, ownerTeam string) bool {
	return u.IsAdmin() || u.InTeam(ownerTeam)
}

// --- categories (admin-managed) ---

func (s *Service) ListCategories(ctx context.Context) ([]*models.Category, error) {
	return s.store.ListCategories(ctx)
}

func (s *Service) CreateCategory(ctx context.Context, u *models.User, c *models.Category) error {
	if !u.IsAdmin() {
		return ErrForbidden
	}
	c.ID = strings.TrimSpace(c.ID)
	c.Label = strings.TrimSpace(c.Label)
	if c.ID == "" || c.Label == "" {
		return invalid("id and label are required")
	}
	return s.store.CreateCategory(ctx, c)
}

func (s *Service) UpdateCategory(ctx context.Context, u *models.User, c *models.Category) error {
	if !u.IsAdmin() {
		return ErrForbidden
	}
	if strings.TrimSpace(c.Label) == "" {
		return invalid("label is required")
	}
	return s.store.UpdateCategory(ctx, c)
}

func (s *Service) DeleteCategory(ctx context.Context, u *models.User, id string) error {
	if !u.IsAdmin() {
		return ErrForbidden
	}
	return s.store.DeleteCategory(ctx, id)
}

// --- publications ---

// CreateInput регистрирует чарт в каталоге: категория + группа-владелец.
type CreateInput struct {
	ChartProject string
	ChartName    string
	CategoryID   string
	OwnerTeam    string
}

func (s *Service) Create(ctx context.Context, u *models.User, in CreateInput) (*models.ChartPublication, error) {
	if in.ChartProject == "" || in.ChartName == "" {
		return nil, invalid("chart is required")
	}
	if in.CategoryID == "" {
		return nil, invalid("category_id is required")
	}
	if in.OwnerTeam == "" {
		return nil, invalid("owner_team is required")
	}
	if !canManage(u, in.OwnerTeam) {
		return nil, ErrForbidden
	}
	if err := s.checkCategory(ctx, in.CategoryID); err != nil {
		return nil, err
	}
	p := &models.ChartPublication{
		ID:            newID(),
		ChartProject:  in.ChartProject,
		ChartName:     in.ChartName,
		CategoryID:    in.CategoryID,
		OwnerTeam:     in.OwnerTeam,
		CreatedBy:     u.Subject,
		CreatedByName: u.Name,
		Status:        models.PubDraft,
	}
	if err := s.store.CreatePublication(ctx, p); err != nil {
		return nil, err
	}
	s.addEvent(ctx, p.ID, u, "created", "", p.Status, map[string]any{
		"category_id": p.CategoryID, "owner_team": p.OwnerTeam,
	})
	return p, nil
}

// UpdateInput — правка метаданных и/или черновика view. Nil-поля не трогаются.
type UpdateInput struct {
	CategoryID *string
	OwnerTeam  *string
	View       json.RawMessage // черновик view-документа; nil = не менять
}

func (s *Service) Update(ctx context.Context, u *models.User, id string, in UpdateInput) (*models.ChartPublication, error) {
	p, err := s.store.GetPublication(ctx, id)
	if err != nil {
		return nil, err
	}
	if !canManage(u, p.OwnerTeam) {
		return nil, ErrForbidden
	}
	if p.Status == models.PubPending {
		return nil, ErrPendingLocked
	}
	payload := map[string]any{}
	if in.CategoryID != nil && *in.CategoryID != p.CategoryID {
		if err := s.checkCategory(ctx, *in.CategoryID); err != nil {
			return nil, err
		}
		p.CategoryID = *in.CategoryID
		payload["category_id"] = p.CategoryID
	}
	if in.OwnerTeam != nil && *in.OwnerTeam != p.OwnerTeam {
		// Передать владение можно только в свою команду; админ — в любую.
		if *in.OwnerTeam == "" {
			return nil, invalid("owner_team must not be empty")
		}
		if !u.IsAdmin() && !u.InTeam(*in.OwnerTeam) {
			return nil, ErrForbidden
		}
		p.OwnerTeam = *in.OwnerTeam
		payload["owner_team"] = p.OwnerTeam
	}
	if in.View != nil {
		if !json.Valid(in.View) {
			return nil, invalid("view must be valid JSON")
		}
		p.ViewJSON = in.View
		payload["view_updated"] = true
		// Правка после отклонения возвращает черновик в работу.
		if p.Status == models.PubRejected {
			p.Status = models.PubDraft
		}
	}
	if len(payload) == 0 {
		return p, nil // no-op
	}
	if err := s.store.UpdatePublication(ctx, p); err != nil {
		return nil, err
	}
	s.addEvent(ctx, p.ID, u, "updated", "", "", payload)
	return p, nil
}

// Submit отправляет черновик view на согласование админом.
func (s *Service) Submit(ctx context.Context, u *models.User, id string) (*models.ChartPublication, error) {
	p, err := s.store.GetPublication(ctx, id)
	if err != nil {
		return nil, err
	}
	if !canManage(u, p.OwnerTeam) {
		return nil, ErrForbidden
	}
	if p.Status == models.PubPending {
		return nil, models.ErrConflict
	}
	if len(p.ViewJSON) == 0 {
		return nil, invalid("nothing to submit: view draft is empty")
	}
	from := p.Status
	p.Status = models.PubPending
	if err := s.store.UpdatePublication(ctx, p); err != nil {
		return nil, err
	}
	s.addEvent(ctx, p.ID, u, "submitted", from, p.Status, nil)
	return p, nil
}

// Approve (admin): черновик становится активной view.
func (s *Service) Approve(ctx context.Context, u *models.User, id string) (*models.ChartPublication, error) {
	return s.review(ctx, u, id, models.PubApproved, "")
}

// Reject (admin): черновик отклонён с комментарием; approved-версия не трогается.
func (s *Service) Reject(ctx context.Context, u *models.User, id, comment string) (*models.ChartPublication, error) {
	return s.review(ctx, u, id, models.PubRejected, comment)
}

func (s *Service) review(ctx context.Context, u *models.User, id string, to models.PublicationStatus, comment string) (*models.ChartPublication, error) {
	if !u.IsAdmin() {
		return nil, ErrForbidden
	}
	p, err := s.store.GetPublication(ctx, id)
	if err != nil {
		return nil, err
	}
	if p.Status != models.PubPending {
		return nil, models.ErrConflict
	}
	from := p.Status
	p.Status = to
	p.ReviewedBy = u.Subject
	p.ReviewComment = comment
	if to == models.PubApproved {
		p.ApprovedViewJSON = p.ViewJSON
	}
	if err := s.store.UpdatePublication(ctx, p); err != nil {
		return nil, err
	}
	event := "approved"
	var payload map[string]any
	if to == models.PubRejected {
		event = "rejected"
		payload = map[string]any{"comment": comment}
	}
	s.addEvent(ctx, p.ID, u, event, from, to, payload)
	return p, nil
}

func (s *Service) Get(ctx context.Context, id string) (*models.ChartPublication, error) {
	return s.store.GetPublication(ctx, id)
}

func (s *Service) GetByChart(ctx context.Context, project, name string) (*models.ChartPublication, error) {
	return s.store.GetPublicationByChart(ctx, project, name)
}

func (s *Service) List(ctx context.Context, f store.PublicationFilter) ([]*models.ChartPublication, error) {
	return s.store.ListPublications(ctx, f)
}

func (s *Service) ListEvents(ctx context.Context, id string) ([]*models.PublicationEvent, error) {
	return s.store.ListPublicationEvents(ctx, id)
}

// ActiveView возвращает действующую согласованную view чарта (для форм заказа).
func (s *Service) ActiveView(ctx context.Context, project, name string) (json.RawMessage, error) {
	p, err := s.store.GetPublicationByChart(ctx, project, name)
	if err != nil {
		return nil, err
	}
	if !p.Published() {
		return nil, models.ErrNotFound
	}
	return p.ApprovedViewJSON, nil
}

func (s *Service) checkCategory(ctx context.Context, id string) error {
	cats, err := s.store.ListCategories(ctx)
	if err != nil {
		return err
	}
	for _, c := range cats {
		if c.ID == id {
			return nil
		}
	}
	return invalid("unknown category %q", id)
}

// addEvent пишет аудит-запись; её ошибка не должна ломать основную операцию
// (паттерн provisioning.event).
func (s *Service) addEvent(ctx context.Context, pubID string, u *models.User, eventType string, from, to models.PublicationStatus, payload map[string]any) {
	_ = s.store.AddPublicationEvent(ctx, &models.PublicationEvent{
		PublicationID: pubID,
		Actor:         u.Subject,
		EventType:     eventType,
		FromStatus:    from,
		ToStatus:      to,
		Payload:       payload,
	})
}
