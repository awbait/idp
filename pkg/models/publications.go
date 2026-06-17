package models

import (
	"encoding/json"
	"time"
)

// PublicationStatus is the lifecycle of a publication's view document draft.
// "Published" (the order form is available) is determined by the presence of
// ApprovedViewJSON, not by status: the approved version keeps working
// while a new draft is under review.
type PublicationStatus string

const (
	PubDraft    PublicationStatus = "DRAFT"
	PubPending  PublicationStatus = "PENDING"
	PubApproved PublicationStatus = "APPROVED"
	PubRejected PublicationStatus = "REJECTED"
)

// Category groups published charts in the catalog and the left menu.
type Category struct {
	ID    string `json:"id"` // slug
	Label string `json:"label"`
	Sort  int    `json:"sort"`
}

// ChartPublication is portal metadata on top of a Harbor chart: category,
// owner (owner_team manages, created_by, author) and the view document
// (formerly web/public/schemas/<chart>.ui.json).
type ChartPublication struct {
	ID            string            `json:"id"`
	ChartProject  string            `json:"chart_project"`
	ChartName     string            `json:"chart_name"`
	CategoryID    string            `json:"category_id"`
	OwnerTeam     string            `json:"owner_team"`
	CreatedBy     string            `json:"created_by"`
	CreatedByName string            `json:"created_by_name"`
	Status        PublicationStatus `json:"status"`
	// DraftCategoryID/DraftOwnerTeam is a proposed but not yet approved metadata
	// change. Live values (CategoryID/OwnerTeam, used by the catalog and
	// permissions) change only on approve; an empty string - no pending changes.
	DraftCategoryID string `json:"draft_category_id,omitempty"`
	DraftOwnerTeam  string `json:"draft_owner_team,omitempty"`
	// ViewJSON is the editable view document draft; ApprovedViewJSON is the
	// active approved version (order forms are built from it).
	ViewJSON         json.RawMessage `json:"view_json,omitempty"`
	ApprovedViewJSON json.RawMessage `json:"approved_view_json,omitempty"`
	// ApprovedViewVersion is the chart version (latest at approve time) the
	// active view is approved for. The "blessed" version: up to it the view is
	// checked, orders can be updated; newer in Harbor - the author should update the view.
	ApprovedViewVersion string `json:"approved_view_version,omitempty"`
	// ApprovedDescription is the chart description (from Chart.yaml/Harbor) at approve time.
	// The catalog shows it, not the live one from Harbor: data is refreshed only after
	// a new approval.
	ApprovedDescription string `json:"approved_description,omitempty"`
	// ApprovedIconURL is the chart icon (Chart.yaml icon) at approve time. The catalog and
	// chart profile show it, not the live one from Harbor - otherwise a new version with a new
	// icon would "leak" into the catalog before approval. Empty = no icon.
	ApprovedIconURL string    `json:"approved_icon_url,omitempty"`
	ReviewedBy      string    `json:"reviewed_by,omitempty"`
	ReviewComment   string    `json:"review_comment,omitempty"`
	Version         int       `json:"version"` // optimistic lock
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// Published reports whether the publication has an active approved view.
func (p *ChartPublication) Published() bool { return len(p.ApprovedViewJSON) > 0 }

// PendingMeta reports whether there is an unapproved category/owner change.
func (p *ChartPublication) PendingMeta() bool {
	return p.DraftCategoryID != "" || p.DraftOwnerTeam != ""
}

// PublicationEvent is a publication audit / status-change record.
type PublicationEvent struct {
	ID            int64             `json:"id"`
	PublicationID string            `json:"publication_id"`
	Actor         string            `json:"actor"`
	EventType     string            `json:"event_type"`
	FromStatus    PublicationStatus `json:"from_status,omitempty"`
	ToStatus      PublicationStatus `json:"to_status,omitempty"`
	Payload       map[string]any    `json:"payload,omitempty"`
	CreatedAt     time.Time         `json:"created_at"`
}
