// Package gitlab defines the GitLab port and shared types. The GitOps layout
// is a group of repositories: managed-services/{subgroup}/{chart}/{service}/.
package gitlab

import (
	"context"

	"console/pkg/models"
)

// Group is a GitLab group/subgroup.
type Group struct {
	ID       int    `json:"id"`
	FullPath string `json:"full_path"`
}

// Project is a GitLab repository.
type Project struct {
	ID                int    `json:"id"`
	PathWithNamespace string `json:"path_with_namespace"`
	WebURL            string `json:"web_url"`
	DefaultBranch     string `json:"default_branch"`
}

// MR is a merge request.
type MR struct {
	IID            int             `json:"iid"`
	ProjectID      int             `json:"project_id"`
	WebURL         string          `json:"web_url"`
	State          models.MRStatus `json:"state"`
	MergeCommitSHA string          `json:"merge_commit_sha"` // set once merged; the target git revision
}

// FileAction is one change in a commit (mirrors GitLab commit actions API).
type FileAction struct {
	Action   string `json:"action"` // create|update|delete
	FilePath string `json:"file_path"`
	Content  string `json:"content,omitempty"`
}

// DiscoveredApp is one application.yaml found under the GitOps group, with enough
// location info to read its sibling files and derive the order identity.
type DiscoveredApp struct {
	ProjectID     int
	ProjectPath   string // path_with_namespace, e.g. managed-services/team-core/postgres
	ProjectWebURL string // repo web URL (the git source baked into application.yaml)
	Branch        string // default branch the manifest lives on
	FilePath      string // application.yaml path within the repo, e.g. in-cluster/pg1/application.yaml
	Content       []byte // the application.yaml bytes
}

// Port is the provisioning layer's view of GitLab. Both the real HTTP client
// and the in-memory fake implement it.
type Port interface {
	// GetGroup resolves a (sub)group by full path; ErrNotFound if absent.
	// The portal never creates team subgroups - they are provisioned manually.
	GetGroup(ctx context.Context, fullPath string) (*Group, error)
	// GetProject resolves a repo by full path; ErrNotFound if absent.
	GetProject(ctx context.Context, fullPath string) (*Project, error)
	// CreateProject creates a repo inside a namespace (the team subgroup).
	CreateProject(ctx context.Context, namespaceID int, name string) (*Project, error)

	// CreateBranch creates a branch from ref on a project.
	CreateBranch(ctx context.Context, projectID int, branch, ref string) error
	// CommitFiles commits a set of file actions onto a branch.
	CommitFiles(ctx context.Context, projectID int, branch, message string, actions []FileAction) error
	// ListTree returns file paths under a directory on a branch (for delete).
	ListTree(ctx context.Context, projectID int, branch, path string) ([]string, error)
	// GetFile returns a file's verbatim content on a ref; ErrNotFound if absent.
	// Used by drift detection to read back committed values.yaml/application.yaml.
	GetFile(ctx context.Context, projectID int, path, ref string) ([]byte, error)
	// DiscoverApplications returns every application.yaml under the GitOps group
	// with its location (for import/discovery of orders created outside the portal).
	DiscoverApplications(ctx context.Context) ([]DiscoveredApp, error)
	// LastCommitAuthor returns the author (name, email) of the most recent commit
	// touching path on ref. Empty strings if unknown; used to attribute imported
	// orders to whoever created the manifest in Git.
	LastCommitAuthor(ctx context.Context, projectID int, path, ref string) (name, email string, err error)

	// CreateMR opens a merge request.
	CreateMR(ctx context.Context, projectID int, source, target, title string) (*MR, error)
	// GetMR returns the current MR state.
	GetMR(ctx context.Context, projectID, iid int) (*MR, error)
	// MergeMR merges an open MR. Used by the optional auto-merge in the poller;
	// a not-yet-mergeable MR returns an error and is retried on the next tick.
	MergeMR(ctx context.Context, projectID, iid int) error

	Healthz(ctx context.Context) error
}
