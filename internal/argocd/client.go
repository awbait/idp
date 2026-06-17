package argocd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"idp/pkg/models"
)

// Client is the real ArgoCD implementation of Port. It speaks the ArgoCD
// gRPC-gateway REST API (the same endpoints the argocd CLI uses) with a bearer
// token, exposing only the read/sync subset the status layer needs. App
// creation is GitOps-driven (a bootstrap ApplicationSet materialises apps from
// the manifests the portal commits to Git), so there is no Create here.
type Client struct {
	base  string // API root, e.g. https://argocd.local/api/v1
	token string
	http  *http.Client
}

var _ Port = (*Client)(nil)

// NewClient builds an ArgoCD client. baseURL is the argocd-server root
// (e.g. http://argocd.local:8083); token is a bearer token from
// `argocd account generate-token` (or a project token). A zero timeout is 30s.
func NewClient(baseURL, token string, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &Client{
		base:  strings.TrimRight(baseURL, "/") + "/api/v1",
		token: token,
		http:  &http.Client{Timeout: timeout},
	}
}

// apiError carries a non-2xx ArgoCD response for diagnostics.
type apiError struct {
	status int
	body   string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("argocd: status %d: %s", e.status, e.body)
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
	req.Header.Set("Authorization", "Bearer "+c.token)
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
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("argocd: decode %s: %w", path, err)
		}
	}
	return nil
}

// apiApp is the trimmed ArgoCD Application JSON the portal reads.
type apiApp struct {
	Metadata struct {
		Name   string            `json:"name"`
		Labels map[string]string `json:"labels"`
	} `json:"metadata"`
	Spec struct {
		Project     string `json:"project"`
		Destination struct {
			Name   string `json:"name"`
			Server string `json:"server"`
		} `json:"destination"`
	} `json:"spec"`
	Status struct {
		Sync struct {
			Status    string   `json:"status"`
			Revision  string   `json:"revision"`
			Revisions []string `json:"revisions"`
		} `json:"sync"`
		Health struct {
			Status string `json:"status"`
		} `json:"health"`
	} `json:"status"`
}

func (a *apiApp) toApp() Application {
	cluster := a.Spec.Destination.Name
	if cluster == "" {
		cluster = a.Spec.Destination.Server
	}
	sync := SyncStatus(a.Status.Sync.Status)
	if sync == "" {
		sync = SyncUnknown
	}
	health := HealthStatus(a.Status.Health.Status)
	if health == "" {
		health = HealthUnknown
	}
	return Application{
		Name:      a.Metadata.Name,
		Project:   a.Spec.Project,
		Cluster:   cluster,
		Sync:      sync,
		Health:    health,
		Labels:    a.Metadata.Labels,
		Revision:  a.Status.Sync.Revision,
		Revisions: a.Status.Sync.Revisions,
	}
}

func (c *Client) ListApplications(ctx context.Context, selector map[string]string) ([]Application, error) {
	q := url.Values{}
	if s := encodeSelector(selector); s != "" {
		q.Set("selector", s)
	}
	var resp struct {
		Items []apiApp `json:"items"`
	}
	if err := c.do(ctx, http.MethodGet, "/applications", q, nil, &resp); err != nil {
		return nil, err
	}
	out := make([]Application, 0, len(resp.Items))
	for i := range resp.Items {
		out = append(out, resp.Items[i].toApp())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (c *Client) GetApplication(ctx context.Context, name string) (*Application, error) {
	var app apiApp
	if err := c.do(ctx, http.MethodGet, "/applications/"+url.PathEscape(name), nil, nil, &app); err != nil {
		// ArgoCD returns 403 "permission denied" (not 404) for an application
		// that doesn't exist, to avoid leaking existence. With our admin token a
		// 403 on a specific app therefore means "not found" - map it so the
		// delete flow (DELETE_MR_MERGED -> DELETED, gated on ErrNotFound) can
		// observe a pruned app.
		var ae *apiError
		if errors.Is(err, models.ErrNotFound) || (errors.As(err, &ae) && ae.status == http.StatusForbidden) {
			return nil, models.ErrNotFound
		}
		return nil, err
	}
	a := app.toApp()
	return &a, nil
}

func (c *Client) Sync(ctx context.Context, name string) error {
	// Empty body = sync the app's target revision with default options.
	return c.do(ctx, http.MethodPost, "/applications/"+url.PathEscape(name)+"/sync", nil, struct{}{}, nil)
}

func (c *Client) Healthz(ctx context.Context) error {
	// The version endpoint lives at /api/version (outside the /api/v1 base) and is
	// unauthenticated, so it wouldn't validate the token. session/userinfo is under
	// /api/v1, cheap, and reports whether our bearer token is accepted - covering
	// both connectivity and auth. It returns 200 even when unauthenticated, so we
	// must inspect loggedIn rather than rely on the status code.
	var info struct {
		LoggedIn bool `json:"loggedIn"`
	}
	if err := c.do(ctx, http.MethodGet, "/session/userinfo", nil, nil, &info); err != nil {
		return err
	}
	if !info.LoggedIn {
		return errors.New("argocd: token rejected (not logged in)")
	}
	return nil
}

// encodeSelector renders an equality label selector "k1=v1,k2=v2" with keys
// sorted for deterministic requests.
func encodeSelector(selector map[string]string) string {
	if len(selector) == 0 {
		return ""
	}
	keys := make([]string, 0, len(selector))
	for k := range selector {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+selector[k])
	}
	return strings.Join(parts, ",")
}
