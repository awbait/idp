// Package models holds the domain types shared across the portal.
package models

import "time"

// RequestStatus is the lifecycle state of an order (see spec FSM).
type RequestStatus string

const (
	StatusDraft           RequestStatus = "DRAFT"
	StatusMRCreated       RequestStatus = "MR_CREATED"
	StatusMRClosed        RequestStatus = "MR_CLOSED"
	StatusMRMerged        RequestStatus = "MR_MERGED"
	StatusDeploying       RequestStatus = "DEPLOYING"
	StatusHealthy         RequestStatus = "HEALTHY"
	StatusDegraded        RequestStatus = "DEGRADED"
	StatusArgoMissing     RequestStatus = "ARGO_MISSING"
	StatusDeleteRequested RequestStatus = "DELETE_REQUESTED"
	StatusDeleteMRMerged  RequestStatus = "DELETE_MR_MERGED"
	StatusDeleted         RequestStatus = "DELETED"
)

// MRStatus mirrors the GitLab merge request state we care about.
type MRStatus string

const (
	MROpened MRStatus = "opened"
	MRMerged MRStatus = "merged"
	MRClosed MRStatus = "closed"
)

// MRAction records why an MR was opened.
type MRAction string

const (
	ActionCreate MRAction = "create"
	ActionUpdate MRAction = "update"
	ActionDelete MRAction = "delete"
)

// Role is a portal authorization role. Exactly one role per user, derived from
// Keycloak groups (see internal/auth/rbac.go) with this precedence:
//
//		admin > support > security > member > auditor
//
//	  - auditor  - default read-only principal (no team, no special group)
//	  - member   - belongs to one or more teams; self-service over its own teams
//	  - security - InfoSec; no team (its access is not team-scoped)
//	  - support  - cross-team operations: view and edit orders of every team
//	  - admin    - platform administrator; absolute access
type Role string

const (
	RoleAuditor  Role = "auditor"
	RoleMember   Role = "member"
	RoleSupport  Role = "support"
	RoleSecurity Role = "security"
	RoleAdmin    Role = "admin"
)

// User is the authenticated principal derived from the OIDC token.
type User struct {
	Subject  string   `json:"sub"`
	Email    string   `json:"email"`
	Username string   `json:"preferred_username"`
	Name     string   `json:"name"`
	Teams    []string `json:"teams"` // derived from team-* groups (prefix stripped)
	Role     Role     `json:"role"`
}

// IsAdmin reports whether the user has the admin role.
func (u *User) IsAdmin() bool { return u.Role == RoleAdmin }

// IsSupport reports whether the user has the support role (cross-team order ops).
func (u *User) IsSupport() bool { return u.Role == RoleSupport }

// IsSecurity reports whether the user has the security role (InfoSec).
func (u *User) IsSecurity() bool { return u.Role == RoleSecurity }

// InTeam reports whether the user belongs to the given team.
func (u *User) InTeam(team string) bool {
	for _, t := range u.Teams {
		if t == team {
			return true
		}
	}
	return false
}

// Request is a self-service order for a managed service instance.
type Request struct {
	ID            string        `json:"id"`
	CreatedBy     string        `json:"created_by"`
	CreatedByName string        `json:"created_by_name"`
	Team          string        `json:"team"`
	ChartProject  string        `json:"chart_project"`
	ChartName     string        `json:"chart_name"`
	ChartVersion  string        `json:"chart_version"`
	ServiceName   string        `json:"service_name"` // deploy identity: GitOps folder, ArgoCD app, unique index
	DisplayName   string        `json:"display_name"` // cosmetic, user-facing, mutable; no deploy impact
	Cluster       string        `json:"cluster"`      // ArgoCD Application destination.name
	Namespace     string        `json:"namespace"`    // ArgoCD Application destination.namespace (empty -> service_name)
	ValuesYAML    string        `json:"values_yaml"`
	Status        RequestStatus `json:"status"`
	ArgoCDAppName string        `json:"argocd_app_name"`
	Version       int           `json:"version"` // optimistic lock
	CreatedAt     time.Time     `json:"created_at"`
	UpdatedAt     time.Time     `json:"updated_at"`
	DeletedAt     *time.Time    `json:"deleted_at,omitempty"`
	// Drifted is set by the drift reconciler when the order's committed Git state
	// (values.yaml / chart version) was changed outside the portal. DriftDetail
	// holds a human-readable summary of what diverged. Read-only signal - the
	// portal does not auto-overwrite Git.
	Drifted     bool   `json:"drifted"`
	DriftDetail string `json:"drift_detail,omitempty"`
	// Imported is true for orders discovered in Git (their application.yaml was
	// created outside the portal and adopted by the import reconciler).
	Imported bool `json:"imported"`
}

// RequestMR links an order to a GitLab merge request.
type RequestMR struct {
	ID              string    `json:"id"`
	RequestID       string    `json:"request_id"`
	GitLabProjectID int       `json:"gitlab_project_id"`
	MRIID           int       `json:"mr_iid"`
	MRURL           string    `json:"mr_url"`
	Status          MRStatus  `json:"mr_status"`
	Action          MRAction  `json:"action"`
	CreatedAt       time.Time `json:"created_at"`
}

// RequestEvent is an audit-log / state-transition record.
type RequestEvent struct {
	ID         int64          `json:"id"`
	RequestID  string         `json:"request_id"`
	Actor      string         `json:"actor"`
	EventType  string         `json:"event_type"`
	FromStatus RequestStatus  `json:"from_status,omitempty"`
	ToStatus   RequestStatus  `json:"to_status,omitempty"`
	Payload    map[string]any `json:"payload,omitempty"`
	CreatedAt  time.Time      `json:"created_at"`
}
