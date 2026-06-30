package publications

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"

	"console/internal/views"
	"console/pkg/models"
)

// Multi-version publications: a ChartPublication is the service; each published
// chart version is a PublicationVersion with its own view document and approval
// FSM (DRAFT -> PENDING -> APPROVED | REJECTED). orderable is the owner-controlled
// allowlist; recommended_version (on the publication) is the default for new
// orders, with a fall back to the highest orderable+APPROVED version.
//
// These methods are additive: the legacy single-view methods on Service keep
// working off the approved_* columns during the transition (see the design doc
// docs/multi-version-publications.md).

// ListVersions returns all version rows of a publication (oldest first).
func (s *Service) ListVersions(ctx context.Context, pubID string) ([]*models.PublicationVersion, error) {
	if _, err := s.store.GetPublication(ctx, pubID); err != nil {
		return nil, err
	}
	return s.store.ListVersions(ctx, pubID)
}

// SaveVersionView creates or updates the draft view of a chart version. A new
// version row starts in DRAFT; editing a REJECTED version returns it to DRAFT.
// The approved view (if any) keeps serving until the new draft is re-approved.
func (s *Service) SaveVersionView(ctx context.Context, u *models.User, pubID, chartVersion string, view json.RawMessage) (*models.PublicationVersion, error) {
	p, err := s.store.GetPublication(ctx, pubID)
	if err != nil {
		return nil, err
	}
	if !canManage(u, p.OwnerTeam) {
		return nil, ErrForbidden
	}
	if strings.TrimSpace(chartVersion) == "" {
		return nil, invalid("chart_version is required")
	}
	// A draft may carry schema flaws (the chart schema can drift), but the
	// document format itself must be valid.
	if issues := views.ValidateStructure(view); len(issues) > 0 {
		return nil, &ValidationError{Message: "view.schema.json не проходит валидацию формата", Issues: issues}
	}
	v, err := s.getOrInitVersion(ctx, p, chartVersion)
	if err != nil {
		return nil, err
	}
	if v.Status == models.PubPending {
		return nil, ErrPendingLocked
	}
	v.ViewJSON = view
	if v.Status == models.PubRejected {
		v.Status = models.PubDraft
	}
	if err := s.store.UpsertVersion(ctx, v); err != nil {
		return nil, err
	}
	s.addEvent(ctx, p.ID, u, "version_updated", "", "", map[string]any{"chart_version": chartVersion})
	return v, nil
}

// SubmitVersion sends a version's draft view for review (-> PENDING).
func (s *Service) SubmitVersion(ctx context.Context, u *models.User, pubID, chartVersion string) (*models.PublicationVersion, error) {
	p, v, err := s.loadManagedVersion(ctx, u, pubID, chartVersion)
	if err != nil {
		return nil, err
	}
	if v.Status == models.PubPending {
		return nil, conflict("версия уже на согласовании")
	}
	if len(v.ViewJSON) == 0 {
		return nil, invalid("нечего отправлять: нет черновика view")
	}
	if issues := s.validateVersionView(ctx, p, chartVersion, v.ViewJSON); len(issues) > 0 {
		return nil, &ValidationError{Message: "view.schema.json не проходит валидацию", Issues: issues}
	}
	from := v.Status
	v.Status = models.PubPending
	if err := s.store.UpsertVersion(ctx, v); err != nil {
		return nil, err
	}
	s.addEvent(ctx, p.ID, u, "version_submitted", from, v.Status, map[string]any{"chart_version": chartVersion})
	return v, nil
}

// WithdrawVersion pulls a version back from review for rework (PENDING -> DRAFT).
func (s *Service) WithdrawVersion(ctx context.Context, u *models.User, pubID, chartVersion string) (*models.PublicationVersion, error) {
	p, v, err := s.loadManagedVersion(ctx, u, pubID, chartVersion)
	if err != nil {
		return nil, err
	}
	if v.Status != models.PubPending {
		return nil, conflict("версия не находится на согласовании")
	}
	from := v.Status
	v.Status = models.PubDraft
	if err := s.store.UpsertVersion(ctx, v); err != nil {
		return nil, err
	}
	s.addEvent(ctx, p.ID, u, "version_withdrawn", from, v.Status, map[string]any{"chart_version": chartVersion})
	return v, nil
}

// ApproveVersion (admin): the version's draft view becomes its approved view.
func (s *Service) ApproveVersion(ctx context.Context, u *models.User, pubID, chartVersion string) (*models.PublicationVersion, error) {
	return s.reviewVersion(ctx, u, pubID, chartVersion, models.PubApproved, "")
}

// RejectVersion (admin): the version's draft is rejected with a comment; its
// approved view (if any) keeps serving.
func (s *Service) RejectVersion(ctx context.Context, u *models.User, pubID, chartVersion, comment string) (*models.PublicationVersion, error) {
	return s.reviewVersion(ctx, u, pubID, chartVersion, models.PubRejected, comment)
}

func (s *Service) reviewVersion(ctx context.Context, u *models.User, pubID, chartVersion string, to models.PublicationStatus, comment string) (*models.PublicationVersion, error) {
	if !u.IsAdmin() {
		return nil, ErrForbidden
	}
	p, err := s.store.GetPublication(ctx, pubID)
	if err != nil {
		return nil, err
	}
	v, err := s.store.GetVersion(ctx, pubID, chartVersion)
	if err != nil {
		return nil, err
	}
	if v.Status != models.PubPending {
		return nil, conflict("версия не находится на согласовании")
	}
	from := v.Status
	if to == models.PubApproved {
		v.ApprovedViewJSON = v.ViewJSON
		// Snapshot description/icon so the catalog shows approved, not live,
		// data. Best-effort and chart-level (Harbor does not expose per-version
		// Chart.yaml metadata here); a no-op if the source is unavailable.
		if s.schemas != nil {
			if d, err := s.schemas.LatestDescription(ctx, p.ChartProject, p.ChartName); err == nil {
				v.ApprovedDescription = d
			}
			if ic, err := s.schemas.LatestIcon(ctx, p.ChartProject, p.ChartName); err == nil {
				v.ApprovedIconURL = ic
			}
		}
	}
	v.Status = to
	v.ReviewedBy = u.Subject
	v.ReviewComment = comment
	if err := s.store.UpsertVersion(ctx, v); err != nil {
		return nil, err
	}
	event := "version_approved"
	var payload map[string]any
	if to == models.PubRejected {
		event = "version_rejected"
		payload = map[string]any{"chart_version": chartVersion, "comment": comment}
	} else {
		payload = map[string]any{"chart_version": chartVersion}
	}
	s.addEvent(ctx, p.ID, u, event, from, to, payload)
	s.logger().Debug("publication version review",
		"publication_id", p.ID, "chart", p.ChartName, "chart_version", chartVersion,
		"from", from, "to", to, "actor", u.Subject)
	return v, nil
}

// SetVersionOrderable flips a version's allowlist flag. Only an APPROVED version
// can be made orderable; clearing the flag is always allowed.
func (s *Service) SetVersionOrderable(ctx context.Context, u *models.User, pubID, chartVersion string, orderable bool) (*models.PublicationVersion, error) {
	p, v, err := s.loadManagedVersion(ctx, u, pubID, chartVersion)
	if err != nil {
		return nil, err
	}
	if orderable && (v.Status != models.PubApproved || len(v.ApprovedViewJSON) == 0) {
		return nil, conflict("включить в каталог можно только согласованную версию")
	}
	if v.Orderable == orderable {
		return v, nil // no-op
	}
	if err := s.store.SetOrderable(ctx, v.ID, orderable); err != nil {
		return nil, err
	}
	v.Orderable = orderable
	s.addEvent(ctx, p.ID, u, "version_orderable", "", "", map[string]any{
		"chart_version": chartVersion, "orderable": orderable,
	})
	s.logger().Info("publication version allowlist",
		"publication_id", p.ID, "chart", p.ChartName, "chart_version", chartVersion,
		"orderable", orderable, "actor", u.Subject)
	return v, nil
}

// SetRecommendedVersion marks the recommended version for new orders, or clears
// it with an empty chartVersion. A non-empty target must be orderable+APPROVED.
func (s *Service) SetRecommendedVersion(ctx context.Context, u *models.User, pubID, chartVersion string) error {
	p, err := s.store.GetPublication(ctx, pubID)
	if err != nil {
		return err
	}
	if !canManage(u, p.OwnerTeam) {
		return ErrForbidden
	}
	if chartVersion != "" {
		v, err := s.store.GetVersion(ctx, pubID, chartVersion)
		if err != nil {
			return err
		}
		if !v.Published() {
			return conflict("рекомендуемой можно сделать только доступную для заказа версию")
		}
	}
	if err := s.store.SetRecommended(ctx, pubID, chartVersion); err != nil {
		return err
	}
	s.addEvent(ctx, p.ID, u, "version_recommended", "", "", map[string]any{"chart_version": chartVersion})
	s.logger().Info("publication version recommended",
		"publication_id", p.ID, "chart", p.ChartName, "chart_version", chartVersion, "actor", u.Subject)
	return nil
}

// CatalogVersions projects a publication's versions for the catalog: the
// resolved recommended (default-served) chart version and the list of all
// orderable+APPROVED versions, highest first (for the "+N" chip and tooltip).
// Both are empty when the publication has no orderable versions yet.
func (s *Service) CatalogVersions(ctx context.Context, p *models.ChartPublication) (recommended string, orderable []string, err error) {
	versions, err := s.store.ListVersions(ctx, p.ID)
	if err != nil {
		return "", nil, err
	}
	pub := make([]*models.PublicationVersion, 0, len(versions))
	for _, v := range versions {
		if v.Published() {
			pub = append(pub, v)
		}
	}
	sort.Slice(pub, func(i, j int) bool {
		return compareChartVersions(pub[i].ChartVersion, pub[j].ChartVersion) > 0 // highest first
	})
	orderable = make([]string, len(pub))
	for i, v := range pub {
		orderable[i] = v.ChartVersion
	}
	if v := resolveOrderableVersion(p, versions, ""); v != nil {
		recommended = v.ChartVersion
	}
	return recommended, orderable, nil
}

// ActiveViewVersion returns the approved view of an orderable version (for order
// forms). An empty chartVersion resolves the recommended version, falling back
// to the highest orderable+APPROVED one.
func (s *Service) ActiveViewVersion(ctx context.Context, project, name, chartVersion string) (json.RawMessage, error) {
	p, err := s.store.GetPublicationByChart(ctx, project, name)
	if err != nil {
		return nil, err
	}
	versions, err := s.store.ListVersions(ctx, p.ID)
	if err != nil {
		return nil, err
	}
	v := resolveOrderableVersion(p, versions, chartVersion)
	if v == nil {
		return nil, models.ErrNotFound
	}
	return v.ApprovedViewJSON, nil
}

// resolveOrderableVersion picks the version to serve: the requested one if it is
// orderable+APPROVED; otherwise (empty request) the recommended version, falling
// back to the highest orderable+APPROVED version. Returns nil if none qualifies.
func resolveOrderableVersion(p *models.ChartPublication, versions []*models.PublicationVersion, requested string) *models.PublicationVersion {
	published := make([]*models.PublicationVersion, 0, len(versions))
	for _, v := range versions {
		if v.Published() {
			published = append(published, v)
		}
	}
	if len(published) == 0 {
		return nil
	}
	if requested != "" {
		for _, v := range published {
			if v.ChartVersion == requested {
				return v
			}
		}
		return nil
	}
	if p.RecommendedVersion != "" {
		for _, v := range published {
			if v.ChartVersion == p.RecommendedVersion {
				return v
			}
		}
	}
	// Fall back to the highest orderable+APPROVED version.
	sort.Slice(published, func(i, j int) bool {
		return compareChartVersions(published[i].ChartVersion, published[j].ChartVersion) < 0
	})
	return published[len(published)-1]
}

// --- helpers ---

// getOrInitVersion returns the stored version row, or a fresh DRAFT one (with a
// new ID) when (publication, chart_version) does not exist yet.
func (s *Service) getOrInitVersion(ctx context.Context, p *models.ChartPublication, chartVersion string) (*models.PublicationVersion, error) {
	v, err := s.store.GetVersion(ctx, p.ID, chartVersion)
	if err == nil {
		return v, nil
	}
	if !errors.Is(err, models.ErrNotFound) {
		return nil, err
	}
	return &models.PublicationVersion{
		ID:            newID(),
		PublicationID: p.ID,
		ChartVersion:  chartVersion,
		Status:        models.PubDraft,
	}, nil
}

// loadManagedVersion loads a publication and one of its existing versions,
// enforcing manage rights.
func (s *Service) loadManagedVersion(ctx context.Context, u *models.User, pubID, chartVersion string) (*models.ChartPublication, *models.PublicationVersion, error) {
	p, err := s.store.GetPublication(ctx, pubID)
	if err != nil {
		return nil, nil, err
	}
	if !canManage(u, p.OwnerTeam) {
		return nil, nil, ErrForbidden
	}
	v, err := s.store.GetVersion(ctx, pubID, chartVersion)
	if err != nil {
		return nil, nil, err
	}
	return p, v, nil
}

// validateVersionView cross-validates a view against that chart version's schema;
// if the schema is unavailable, only the structure is checked.
func (s *Service) validateVersionView(ctx context.Context, p *models.ChartPublication, chartVersion string, view json.RawMessage) []views.Issue {
	var schema []byte
	if s.schemas != nil {
		if b, err := s.schemas.GetSchema(ctx, p.ChartProject, p.ChartName, chartVersion); err == nil {
			schema = b
		}
	}
	return views.Validate(view, schema)
}

// compareChartVersions orders Helm SemVer-ish versions by numeric major.minor.patch
// (a leading "v" and any pre-release/build suffix are ignored for ordering). It is
// a best-effort comparison for the recommended-version fall back; unparsable parts
// compare as 0, with a lexicographic tie-break so the order stays deterministic.
func compareChartVersions(a, b string) int {
	pa, pb := splitVersion(a), splitVersion(b)
	for i := range 3 {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return strings.Compare(a, b)
}

func splitVersion(v string) [3]int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	var out [3]int
	for i, part := range strings.SplitN(v, ".", 3) {
		if i > 2 {
			break
		}
		out[i], _ = strconv.Atoi(strings.TrimSpace(part))
	}
	return out
}
