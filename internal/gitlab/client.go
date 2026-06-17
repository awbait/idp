package gitlab

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"idp/pkg/models"
)

// Client is the real GitLab REST API v4 implementation of Port. It speaks the
// subset the GitOps flow needs: resolve groups/projects, create repos, push
// commits on branches, and open/track merge requests. It also implements
// argocd.ManifestSource so a fake ArgoCD can reconcile from real Git.
type Client struct {
	base        string // instance API root, e.g. https://gitlab.local/api/v4
	token       string
	gitopsGroup string // top GitOps group to scan for application.yaml manifests
	http        *http.Client
}

var _ Port = (*Client)(nil)

// NewClient builds a GitLab client. baseURL is the instance root
// (e.g. https://gitlab.example.com); token is a personal/group/project access
// token with the "api" scope; gitopsGroup is the top group whose repos hold the
// GitOps manifests (used by ListApplicationManifests). A zero timeout is 30s.
func NewClient(baseURL, token, gitopsGroup string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &Client{
		base:        strings.TrimRight(baseURL, "/") + "/api/v4",
		token:       token,
		gitopsGroup: gitopsGroup,
		http:        &http.Client{Timeout: timeout},
	}
}

// apiError carries a non-2xx GitLab response for diagnostics.
type apiError struct {
	status int
	body   string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("gitlab: status %d: %s", e.status, e.body)
}

// do performs an API request, decoding a 2xx body into out when non-nil.
// A 404 maps to models.ErrNotFound; other non-2xx become *apiError.
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body, out any) error {
	endpoint := c.base + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("PRIVATE-TOKEN", c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode == http.StatusNotFound {
		return models.ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &apiError{status: resp.StatusCode, body: strings.TrimSpace(string(data))}
	}
	if out != nil {
		if raw, ok := out.(*[]byte); ok {
			*raw = data // caller wants the body verbatim (e.g. raw file)
			return nil
		}
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("gitlab: decode %s: %w", path, err)
		}
	}
	return nil
}

// projectPath URL-encodes a project/group path for use as a path parameter
// (GitLab accepts the namespaced path as a single URL-encoded segment).
func projectPath(fullPath string) string { return url.PathEscape(fullPath) }

func (c *Client) GetGroup(ctx context.Context, fullPath string) (*Group, error) {
	var g Group
	if err := c.do(ctx, http.MethodGet, "/groups/"+projectPath(fullPath), nil, nil, &g); err != nil {
		return nil, err
	}
	return &g, nil
}

func (c *Client) GetProject(ctx context.Context, fullPath string) (*Project, error) {
	var p Project
	if err := c.do(ctx, http.MethodGet, "/projects/"+projectPath(fullPath), nil, nil, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (c *Client) CreateProject(ctx context.Context, namespaceID int, name string) (*Project, error) {
	// Create an EMPTY repo (no auto-generated README): the caller (ensureRepo)
	// seeds a single .gitkeep to establish the default branch. An empty repo has
	// no default_branch yet, which ensureRepo detects to do that one-time seed.
	body := map[string]any{
		"name":         name,
		"path":         name,
		"namespace_id": namespaceID,
	}
	var p Project
	if err := c.do(ctx, http.MethodPost, "/projects", nil, body, &p); err != nil {
		if isTakenErr(err) {
			return nil, models.ErrConflict
		}
		return nil, err
	}
	return &p, nil
}

func (c *Client) CreateBranch(ctx context.Context, projectID int, branch, ref string) error {
	q := url.Values{"branch": {branch}, "ref": {ref}}
	return c.do(ctx, http.MethodPost,
		fmt.Sprintf("/projects/%d/repository/branches", projectID), q, nil, nil)
}

func (c *Client) CommitFiles(ctx context.Context, projectID int, branch, message string, actions []FileAction) error {
	body := map[string]any{
		"branch":         branch,
		"commit_message": message,
		"actions":        actions, // FileAction JSON matches the commits API
	}
	return c.do(ctx, http.MethodPost,
		fmt.Sprintf("/projects/%d/repository/commits", projectID), nil, body, nil)
}

func (c *Client) ListTree(ctx context.Context, projectID int, branch, path string) ([]string, error) {
	type entry struct {
		Path string `json:"path"`
		Type string `json:"type"`
	}
	var out []string
	for page := 1; ; page++ {
		q := url.Values{
			"ref":       {branch},
			"path":      {path},
			"recursive": {"true"},
			"per_page":  {"100"},
			"page":      {strconv.Itoa(page)},
		}
		var entries []entry
		err := c.do(ctx, http.MethodGet,
			fmt.Sprintf("/projects/%d/repository/tree", projectID), q, nil, &entries)
		if errors.Is(err, models.ErrNotFound) {
			return out, nil // missing dir: caller falls back to default paths
		}
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if e.Type == "blob" {
				out = append(out, e.Path)
			}
		}
		if len(entries) < 100 {
			return out, nil
		}
	}
}

func (c *Client) CreateMR(ctx context.Context, projectID int, source, target, title string) (*MR, error) {
	body := map[string]any{
		"source_branch": source,
		"target_branch": target,
		"title":         title,
	}
	var m MR
	if err := c.do(ctx, http.MethodPost,
		fmt.Sprintf("/projects/%d/merge_requests", projectID), nil, body, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (c *Client) GetMR(ctx context.Context, projectID, iid int) (*MR, error) {
	var m MR
	if err := c.do(ctx, http.MethodGet,
		fmt.Sprintf("/projects/%d/merge_requests/%d", projectID, iid), nil, nil, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func (c *Client) MergeMR(ctx context.Context, projectID, iid int) error {
	// GitLab merges immediately when the MR is mergeable. Just after creation the
	// merge_status may still be "checking" (405) - the poller retries next tick.
	return c.do(ctx, http.MethodPut,
		fmt.Sprintf("/projects/%d/merge_requests/%d/merge", projectID, iid), nil, nil, nil)
}

func (c *Client) Healthz(ctx context.Context) error {
	// /version requires auth, so it also validates the token and connectivity.
	return c.do(ctx, http.MethodGet, "/version", nil, nil, nil)
}

// ListApplicationManifests returns every application.yaml committed on the
// default branch of any repo under the GitOps group. It lets a fake ArgoCD
// reconcile from a real GitLab. Implements argocd.ManifestSource.
func (c *Client) ListApplicationManifests(ctx context.Context) ([][]byte, error) {
	apps, err := c.DiscoverApplications(ctx)
	if err != nil {
		return nil, err
	}
	out := make([][]byte, 0, len(apps))
	for _, a := range apps {
		out = append(out, a.Content)
	}
	return out, nil
}

// DiscoverApplications walks every repo under the GitOps group and returns each
// application.yaml with its location. Implements gitlab.Port.
func (c *Client) DiscoverApplications(ctx context.Context) ([]DiscoveredApp, error) {
	if c.gitopsGroup == "" {
		return nil, nil
	}
	projects, err := c.listGroupProjects(ctx, c.gitopsGroup)
	if err != nil {
		return nil, err
	}
	var out []DiscoveredApp
	for _, p := range projects {
		if p.DefaultBranch == "" {
			continue // empty repo, nothing committed yet
		}
		paths, err := c.ListTree(ctx, p.ID, p.DefaultBranch, "")
		if err != nil {
			return nil, err
		}
		for _, fp := range paths {
			if !isAppManifest(fp) {
				continue
			}
			content, ferr := c.getRawFile(ctx, p.ID, fp, p.DefaultBranch)
			if ferr != nil {
				return nil, ferr
			}
			out = append(out, DiscoveredApp{
				ProjectID: p.ID, ProjectPath: p.PathWithNamespace, ProjectWebURL: p.WebURL,
				Branch: p.DefaultBranch, FilePath: fp, Content: content,
			})
		}
	}
	return out, nil
}

func isAppManifest(fp string) bool {
	return strings.HasSuffix(fp, "application.yaml") || strings.HasSuffix(fp, "application.yml")
}

// LastCommitAuthor returns the author of the latest commit touching path on ref.
func (c *Client) LastCommitAuthor(ctx context.Context, projectID int, path, ref string) (string, string, error) {
	q := url.Values{"path": {path}, "ref_name": {ref}, "per_page": {"1"}}
	var commits []struct {
		AuthorName  string `json:"author_name"`
		AuthorEmail string `json:"author_email"`
	}
	if err := c.do(ctx, http.MethodGet,
		fmt.Sprintf("/projects/%d/repository/commits", projectID), q, nil, &commits); err != nil {
		return "", "", err
	}
	if len(commits) == 0 {
		return "", "", nil
	}
	return commits[0].AuthorName, commits[0].AuthorEmail, nil
}

// listGroupProjects lists every project under a group (incl. subgroups).
func (c *Client) listGroupProjects(ctx context.Context, group string) ([]Project, error) {
	var out []Project
	for page := 1; ; page++ {
		q := url.Values{
			"include_subgroups": {"true"},
			"archived":          {"false"},
			"per_page":          {"100"},
			"page":              {strconv.Itoa(page)},
		}
		var projects []Project
		err := c.do(ctx, http.MethodGet, "/groups/"+projectPath(group)+"/projects", q, nil, &projects)
		if errors.Is(err, models.ErrNotFound) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		out = append(out, projects...)
		if len(projects) < 100 {
			return out, nil
		}
	}
}

// GetFile returns a file's verbatim content on a ref (ErrNotFound if absent).
func (c *Client) GetFile(ctx context.Context, projectID int, path, ref string) ([]byte, error) {
	return c.getRawFile(ctx, projectID, path, ref)
}

// getRawFile fetches a file's verbatim content on a ref.
func (c *Client) getRawFile(ctx context.Context, projectID int, path, ref string) ([]byte, error) {
	var data []byte
	q := url.Values{"ref": {ref}}
	endpoint := fmt.Sprintf("/projects/%d/repository/files/%s/raw", projectID, url.PathEscape(path))
	if err := c.do(ctx, http.MethodGet, endpoint, q, nil, &data); err != nil {
		return nil, err
	}
	return data, nil
}

// isTakenErr reports whether err is GitLab's "path already taken" response,
// which surfaces as 409 or a 400 with a specific message.
func isTakenErr(err error) bool {
	var ae *apiError
	if !errors.As(err, &ae) {
		return false
	}
	return ae.status == http.StatusConflict ||
		(ae.status == http.StatusBadRequest && strings.Contains(ae.body, "has already been taken"))
}
