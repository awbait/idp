// Package publications implements "chart publications": portal catalog
// metadata (category, owner) and the approval of view documents.
//
// View draft FSM: DRAFT -> PENDING -> APPROVED | REJECTED -> DRAFT (edit).
// The approved version (ApprovedViewJSON) keeps serving order forms while a
// new draft is under review.
package publications

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"console/internal/store"
	"console/internal/views"
	"console/pkg/models"
)

var (
	ErrForbidden = errors.New("forbidden")
	// ErrPendingLocked: draft is under review, edits are frozen until the admin decides.
	ErrPendingLocked = errors.New("publication is pending review")
)

// ValidationError is an input validation error (422 in the API). Issues
// is filled for view document errors (path inside the document + message).
type ValidationError struct {
	Message string
	Issues  []views.Issue
}

func (e *ValidationError) Error() string { return e.Message }

func invalid(format string, a ...any) error {
	return &ValidationError{Message: fmt.Sprintf(format, a...)}
}

// conflictError is a conflict with a human-readable reason: errors.Is(err,
// models.ErrConflict) stays true (the API maps it to 409), but the message
// carries clear text instead of a bare "conflict".
type conflictError struct{ msg string }

func (e *conflictError) Error() string        { return e.msg }
func (e *conflictError) Is(target error) bool { return target == models.ErrConflict }

func conflict(format string, a ...any) error {
	return &conflictError{msg: fmt.Sprintf(format, a...)}
}

// SchemaSource provides values.schema.json and the chart's latest version
// number (implemented by catalog.Service). The schema is needed for view
// document cross-validation; the version - to stamp the approved view
// (ApprovedViewVersion). On nil or a source error, the corresponding step is skipped.
type SchemaSource interface {
	LatestSchema(ctx context.Context, project, name string) ([]byte, error)
	LatestVersion(ctx context.Context, project, name string) (string, error)
	LatestDescription(ctx context.Context, project, name string) (string, error)
	LatestIcon(ctx context.Context, project, name string) (string, error)
}

// Service owns publication metadata and the view-approval workflow.
type Service struct {
	store   store.Store
	schemas SchemaSource
	// Log is the structured logger; wired by main. Nil-safe via logger().
	Log *slog.Logger
}

func New(st store.Store, schemas SchemaSource) *Service {
	return &Service{store: st, schemas: schemas}
}

// logger returns the configured logger, or the default if none was wired (tests).
func (s *Service) logger() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

func newID() string { return uuid.Must(uuid.NewV7()).String() }

// canManage: manage a publication, a member of the owner group or an admin.
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
	if err := s.store.CreateCategory(ctx, c); err != nil {
		if errors.Is(err, models.ErrConflict) {
			return conflict("категория %q уже существует", c.ID)
		}
		return err
	}
	return nil
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
	if err := s.store.DeleteCategory(ctx, id); err != nil {
		if errors.Is(err, models.ErrConflict) {
			return conflict("категория %q используется публикациями, сначала перенесите их", id)
		}
		return err
	}
	return nil
}

// --- publications ---

// CreateInput registers a chart in the catalog: category + owner group.
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
		if errors.Is(err, models.ErrConflict) {
			return nil, conflict("чарт %s/%s уже добавлен в каталог", in.ChartProject, in.ChartName)
		}
		return nil, err
	}
	s.addEvent(ctx, p.ID, u, "created", "", p.Status, map[string]any{
		"category_id": p.CategoryID, "owner_team": p.OwnerTeam,
	})
	return p, nil
}

// UpdateInput edits metadata and/or the view draft. Nil fields are left untouched.
type UpdateInput struct {
	CategoryID *string
	OwnerTeam  *string
	View       json.RawMessage // view document draft; nil = do not change
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
	// A category/owner change is not applied immediately: it accumulates in the
	// draft fields and moves to live (CategoryID/OwnerTeam) only on approve.
	// Reverting a value to the approved one clears the draft.
	if in.CategoryID != nil {
		if *in.CategoryID == p.CategoryID {
			if p.DraftCategoryID != "" {
				p.DraftCategoryID = ""
				payload["draft_category_id"] = ""
			}
		} else if *in.CategoryID != p.DraftCategoryID {
			if err := s.checkCategory(ctx, *in.CategoryID); err != nil {
				return nil, err
			}
			p.DraftCategoryID = *in.CategoryID
			payload["draft_category_id"] = p.DraftCategoryID
		}
	}
	if in.OwnerTeam != nil {
		if *in.OwnerTeam == "" {
			return nil, invalid("owner_team must not be empty")
		}
		if *in.OwnerTeam == p.OwnerTeam {
			if p.DraftOwnerTeam != "" {
				p.DraftOwnerTeam = ""
				payload["draft_owner_team"] = ""
			}
		} else if *in.OwnerTeam != p.DraftOwnerTeam {
			// Ownership transfer can be proposed only to your own team; an admin, to any.
			if !u.IsAdmin() && !u.InTeam(*in.OwnerTeam) {
				return nil, ErrForbidden
			}
			p.DraftOwnerTeam = *in.OwnerTeam
			payload["draft_owner_team"] = p.DraftOwnerTeam
		}
	}
	if in.View != nil {
		// A draft may be saved with schema flaws (the chart schema can
		// change), but the format structure must be valid.
		if issues := views.ValidateStructure(in.View); len(issues) > 0 {
			return nil, &ValidationError{Message: "view.schema.json не проходит валидацию формата", Issues: issues}
		}
		p.ViewJSON = in.View
		payload["view_updated"] = true
	}
	if len(payload) == 0 {
		return p, nil // no-op
	}
	// Any draft edit (view or metadata) returns a rejected publication
	// back to work.
	if p.Status == models.PubRejected {
		p.Status = models.PubDraft
	}
	if err := s.store.UpdatePublication(ctx, p); err != nil {
		return nil, err
	}
	s.addEvent(ctx, p.ID, u, "updated", "", "", payload)
	return p, nil
}

// Submit sends the view draft for review by an admin.
func (s *Service) Submit(ctx context.Context, u *models.User, id string) (*models.ChartPublication, error) {
	p, err := s.store.GetPublication(ctx, id)
	if err != nil {
		return nil, err
	}
	if !canManage(u, p.OwnerTeam) {
		return nil, ErrForbidden
	}
	if p.Status == models.PubPending {
		return nil, conflict("черновик уже на согласовании")
	}
	if len(p.ViewJSON) == 0 && !p.PendingMeta() {
		return nil, invalid("нечего отправлять: нет ни черновика view, ни изменений метаданных")
	}
	// Only a fully valid document goes to review: format +
	// (when possible) a check against the chart's values.schema.json. If only
	// metadata changes (the view was not touched), there is nothing to check.
	if len(p.ViewJSON) > 0 {
		if issues := s.validateView(ctx, p, p.ViewJSON); len(issues) > 0 {
			return nil, &ValidationError{Message: "view.schema.json не проходит валидацию", Issues: issues}
		}
	}
	from := p.Status
	p.Status = models.PubPending
	if err := s.store.UpdatePublication(ctx, p); err != nil {
		return nil, err
	}
	s.addEvent(ctx, p.ID, u, "submitted", from, p.Status, nil)
	return p, nil
}

// Withdraw pulls a draft back from review for rework: PENDING -> DRAFT.
// Available to owners (and the admin); the approved version, as usual, is untouched.
func (s *Service) Withdraw(ctx context.Context, u *models.User, id string) (*models.ChartPublication, error) {
	p, err := s.store.GetPublication(ctx, id)
	if err != nil {
		return nil, err
	}
	if !canManage(u, p.OwnerTeam) {
		return nil, ErrForbidden
	}
	if p.Status != models.PubPending {
		return nil, conflict("публикация не находится на согласовании")
	}
	from := p.Status
	p.Status = models.PubDraft
	if err := s.store.UpdatePublication(ctx, p); err != nil {
		return nil, err
	}
	s.addEvent(ctx, p.ID, u, "withdrawn", from, p.Status, nil)
	return p, nil
}

// Approve (admin): the draft becomes the active view.
func (s *Service) Approve(ctx context.Context, u *models.User, id string) (*models.ChartPublication, error) {
	return s.review(ctx, u, id, models.PubApproved, "")
}

// Reject (admin): the draft is rejected with a comment; the approved version is untouched.
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
		return nil, conflict("публикация не находится на согласовании")
	}
	from := p.Status
	var applied map[string]any
	if to == models.PubApproved {
		p.ApprovedViewJSON = p.ViewJSON
		// Stamp the version the view is approved for: this is the "blessed"
		// chart version (latest at approve time). Best-effort: if Harbor is
		// unavailable, keep the previous mark.
		if v := s.latestVersion(ctx, p); v != "" {
			p.ApprovedViewVersion = v
		}
		// Snapshot the description and icon too - catalog/profile show the
		// approved ones, not the live Harbor data (otherwise a new version "leaks" into the catalog).
		if s.schemas != nil {
			if d, err := s.schemas.LatestDescription(ctx, p.ChartProject, p.ChartName); err == nil {
				p.ApprovedDescription = d
			}
			if ic, err := s.schemas.LatestIcon(ctx, p.ChartProject, p.ChartName); err == nil {
				p.ApprovedIconURL = ic
			}
		}
		// The approved metadata change is applied to the live values and the draft
		// is cleared. Recheck the category: it could have been deleted during review.
		applied = map[string]any{}
		if p.DraftCategoryID != "" {
			if err := s.checkCategory(ctx, p.DraftCategoryID); err != nil {
				return nil, err
			}
			p.CategoryID = p.DraftCategoryID
			p.DraftCategoryID = ""
			applied["category_id"] = p.CategoryID
		}
		if p.DraftOwnerTeam != "" {
			p.OwnerTeam = p.DraftOwnerTeam
			p.DraftOwnerTeam = ""
			applied["owner_team"] = p.OwnerTeam
		}
	}
	// Set the status and review details after the possible checks, so that
	// a failed approve does not leave the publication in a half-accepted state.
	p.Status = to
	p.ReviewedBy = u.Subject
	p.ReviewComment = comment
	if err := s.store.UpdatePublication(ctx, p); err != nil {
		return nil, err
	}
	event := "approved"
	var payload map[string]any
	if to == models.PubRejected {
		event = "rejected"
		payload = map[string]any{"comment": comment}
	} else if len(applied) > 0 {
		payload = applied
	}
	s.addEvent(ctx, p.ID, u, event, from, to, payload)
	s.logger().Debug("publication review",
		"publication_id", p.ID, "chart", p.ChartName, "from", from, "to", to, "actor", u.Subject)
	return p, nil
}

// DefaultDiscoveryCategory is the category for auto-discovered drafts (seed).
const DefaultDiscoveryCategory = "uncategorized"

// DiscoveredChart is a chart found in Harbor for auto-registration.
type DiscoveredChart struct {
	Project string
	Name    string
	Author  string // from Chart.yaml maintainers, may be empty
}

// EnsureDiscovered creates draft publications for charts found in Harbor that
// do not have a publication yet: the owner is the admin group (ownerTeam), the
// category is the default (categoryID), the author comes from Chart.yaml. Existing ones are left untouched.
// A system operation (no user/RBAC), called by the background reconciler.
func (s *Service) EnsureDiscovered(ctx context.Context, charts []DiscoveredChart, ownerTeam, categoryID string) error {
	for _, c := range charts {
		if _, err := s.store.GetPublicationByChart(ctx, c.Project, c.Name); err == nil {
			continue // already registered
		} else if !errors.Is(err, models.ErrNotFound) {
			return err
		}
		p := &models.ChartPublication{
			ID:            newID(),
			ChartProject:  c.Project,
			ChartName:     c.Name,
			CategoryID:    categoryID,
			OwnerTeam:     ownerTeam,
			CreatedBy:     "auto-discovery",
			CreatedByName: c.Author, // empty if the chart has no maintainers
			Status:        models.PubDraft,
		}
		if err := s.store.CreatePublication(ctx, p); err != nil {
			if errors.Is(err, models.ErrConflict) {
				continue // race with another registration path - ok
			}
			return err
		}
		s.addEvent(ctx, p.ID, &models.User{Subject: "auto-discovery"}, "discovered", "", p.Status,
			map[string]any{"owner_team": ownerTeam, "author": c.Author})
	}
	return nil
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

// ActiveView returns the chart's active approved view (for order forms).
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

// ValidateView runs a full validation of the view draft for the builder
// (live check): format structure + a check against the chart schema. Returns
// a list of problems (empty = all good), not an error, 422 is not needed here.
func (s *Service) ValidateView(ctx context.Context, id string, view json.RawMessage) ([]views.Issue, error) {
	p, err := s.store.GetPublication(ctx, id)
	if err != nil {
		return nil, err
	}
	return s.validateView(ctx, p, view), nil
}

// latestVersion is a best-effort latest chart version number (for the
// ApprovedViewVersion stamp). Empty if the source is unavailable.
func (s *Service) latestVersion(ctx context.Context, p *models.ChartPublication) string {
	if s.schemas == nil {
		return ""
	}
	v, err := s.schemas.LatestVersion(ctx, p.ChartProject, p.ChartName)
	if err != nil {
		return ""
	}
	return v
}

// validateView does format + best-effort cross-validation against the chart
// schema: if the schema is unavailable (no SchemaSource, a chart without a
// schema, Harbor unavailable), we check only the structure.
func (s *Service) validateView(ctx context.Context, p *models.ChartPublication, view json.RawMessage) []views.Issue {
	var schema []byte
	if s.schemas != nil {
		if b, err := s.schemas.LatestSchema(ctx, p.ChartProject, p.ChartName); err == nil {
			schema = b
		}
	}
	return views.Validate(view, schema)
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

// addEvent writes an audit record; its error must not break the main operation
// (the provisioning.event pattern).
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
