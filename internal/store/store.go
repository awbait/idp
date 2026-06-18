// Package store defines the persistence port and its implementations
// (Postgres for production, in-memory for tests/local).
package store

import (
	"context"

	"console/pkg/models"
)

// RequestFilter narrows ListRequests. Teams scopes visibility to the caller's
// teams (empty Teams + Admin=true means "all teams").
type RequestFilter struct {
	Teams          []string
	Admin          bool
	Team           string
	Status         models.RequestStatus
	Chart          string
	IncludeDeleted bool
}

// PublicationFilter narrows ListPublications.
type PublicationFilter struct {
	Status models.PublicationStatus
	Team   string // owner_team
	Chart  string // chart_name
}

// Store is the portal's persistence port.
type Store interface {
	// Requests
	CreateRequest(ctx context.Context, r *models.Request) error // ErrConflict on dup
	GetRequest(ctx context.Context, id string) (*models.Request, error)
	ListRequests(ctx context.Context, f RequestFilter) ([]*models.Request, error)
	UpdateRequest(ctx context.Context, r *models.Request) error // optimistic lock; ErrStaleVersion
	// ListActive returns non-deleted requests in non-terminal states (for the poller).
	ListActive(ctx context.Context) ([]*models.Request, error)
	// SetDrift updates only the drift flag/detail (no optimistic-lock bump), so the
	// poller can record drift without racing concurrent user edits.
	SetDrift(ctx context.Context, id string, drifted bool, detail string) error

	// Merge requests
	AddMR(ctx context.Context, mr *models.RequestMR) error
	UpdateMR(ctx context.Context, mr *models.RequestMR) error
	ListMRs(ctx context.Context, requestID string) ([]*models.RequestMR, error)
	// GetOpenMR returns the single open MR for a request, or ErrNotFound.
	GetOpenMR(ctx context.Context, requestID string) (*models.RequestMR, error)

	// Events / audit
	AddEvent(ctx context.Context, e *models.RequestEvent) error
	ListEvents(ctx context.Context, requestID string) ([]*models.RequestEvent, error)

	// Catalog categories
	CreateCategory(ctx context.Context, c *models.Category) error // ErrConflict on dup id
	UpdateCategory(ctx context.Context, c *models.Category) error
	DeleteCategory(ctx context.Context, id string) error // ErrConflict when referenced by publications
	ListCategories(ctx context.Context) ([]*models.Category, error)

	// Chart publications (catalog metadata + view documents)
	CreatePublication(ctx context.Context, p *models.ChartPublication) error // ErrConflict on dup chart
	GetPublication(ctx context.Context, id string) (*models.ChartPublication, error)
	GetPublicationByChart(ctx context.Context, project, name string) (*models.ChartPublication, error)
	ListPublications(ctx context.Context, f PublicationFilter) ([]*models.ChartPublication, error)
	UpdatePublication(ctx context.Context, p *models.ChartPublication) error // optimistic lock; ErrStaleVersion

	AddPublicationEvent(ctx context.Context, e *models.PublicationEvent) error
	ListPublicationEvents(ctx context.Context, publicationID string) ([]*models.PublicationEvent, error)

	Ping(ctx context.Context) error
	Close()
}
