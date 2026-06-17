package harbor

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"idp/pkg/models"
)

// Client is the real Harbor implementation of Port. Catalog metadata (projects,
// repositories, artifacts/versions) comes from the Harbor API v2.0; the per-chart
// file bodies (values.yaml, README.md, values.schema.json, CHANGELOG.md) are read
// by pulling the chart's OCI artifact (.tgz) and extracting them - Harbor's chart
// "additions" only cover values.yaml + readme.md, so the tarball is the single
// source that also yields the schema and changelog.
//
// Auth: an optional robot account (HTTP Basic on the API, and basic-on-token for
// the OCI registry). With no creds it runs anonymously, which works against a
// public Harbor project (the local stand makes `platform` public).
type Client struct {
	base     string // Harbor root, e.g. https://harbor.local:8084 (no /api/v2.0)
	user     string
	token    string
	projects []string
	httpc    *http.Client

	mu    sync.Mutex
	blobs map[string]map[string][]byte // manifest digest -> {filename: body}
}

var _ Port = (*Client)(nil)

// helm OCI media type for the chart .tgz layer.
const helmChartLayerMediaType = "application/vnd.cncf.helm.chart.content.v1.tar+gzip"

// blobCacheCap bounds the in-process extracted-file cache (charts are tiny and
// the catalog layer also caches by content digest; this just avoids re-pulling
// the same .tgz once per file endpoint).
const blobCacheCap = 64

// NewClient builds a Harbor client. baseURL is the Harbor root
// (e.g. https://harbor.local:8084). user/token are robot-account credentials
// (empty => anonymous). projects is the set surfaced in the catalog. A zero
// timeout defaults to 30s.
func NewClient(baseURL, user, token string, projects []string, insecureTLS bool, timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	if insecureTLS {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &Client{
		base:     strings.TrimRight(baseURL, "/"),
		user:     user,
		token:    token,
		projects: projects,
		httpc:    &http.Client{Timeout: timeout, Transport: tr},
		blobs:    map[string]map[string][]byte{},
	}
}

// apiError carries a non-2xx Harbor response for diagnostics.
type apiError struct {
	status int
	body   string
}

func (e *apiError) Error() string { return fmt.Sprintf("harbor: status %d: %s", e.status, e.body) }

// IsAccessDenied reports whether the error is a Harbor 401/403: the project is
// private and the portal's credentials (robot account, or anonymous) can't read
// it. Callers can turn this into a friendly "no access" message instead of a
// raw upstream error.
func IsAccessDenied(err error) bool {
	var ae *apiError
	return errors.As(err, &ae) &&
		(ae.status == http.StatusUnauthorized || ae.status == http.StatusForbidden)
}

// isProjectSkippable reports whether a per-project listing error means "this
// project isn't here / not visible" (so the catalog should skip it) rather than
// a real failure. Harbor returns 404 for a known-absent project, but 401/403 when
// an absent or private project is read without sufficient credentials.
func isProjectSkippable(err error) bool {
	return err == models.ErrNotFound || IsAccessDenied(err)
}

func (c *Client) basicAuth() string {
	if c.user == "" && c.token == "" {
		return ""
	}
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(c.user+":"+c.token))
}

// apiGet performs a GET against the Harbor REST API and decodes a 2xx body into
// out. A 404 maps to models.ErrNotFound; other non-2xx become *apiError.
func (c *Client) apiGet(ctx context.Context, p string, query url.Values, out any) error {
	endpoint := c.base + "/api/v2.0" + p
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if a := c.basicAuth(); a != "" {
		req.Header.Set("Authorization", a)
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusNotFound {
		return models.ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &apiError{status: resp.StatusCode, body: strings.TrimSpace(string(data))}
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("harbor: decode %s: %w", p, err)
		}
	}
	return nil
}

// ---- Harbor API JSON shapes (trimmed to what the catalog needs) ----

type apiRepo struct {
	Name        string `json:"name"` // "{project}/{repo}"
	Description string `json:"description"`
}

type apiArtifact struct {
	Digest   string `json:"digest"`
	PushTime string `json:"push_time"`
	Tags     []struct {
		Name string `json:"name"`
	} `json:"tags"`
	ExtraAttrs struct {
		Version     string `json:"version"`
		AppVersion  string `json:"appVersion"`
		Description string `json:"description"`
		Icon        string `json:"icon"` // Chart.yaml icon (URL or data:image/...;base64,)
	} `json:"extra_attrs"`
}

// repoShortName strips the leading "{project}/" from a Harbor repository name.
func repoShortName(project, full string) string {
	return strings.TrimPrefix(full, project+"/")
}

// ---- metadata (Harbor API v2.0) ----

func (c *Client) ListCharts(ctx context.Context) ([]models.Chart, error) {
	var out []models.Chart
	for _, project := range c.projects {
		var repos []apiRepo
		err := c.apiGet(ctx, "/projects/"+url.PathEscape(project)+"/repositories",
			url.Values{"page_size": {"100"}}, &repos)
		if err != nil {
			// A configured project may be absent or invisible to these creds -
			// Harbor answers 404, or 401/403 for an absent project read
			// anonymously. Skip it rather than failing the whole catalog.
			if isProjectSkippable(err) {
				continue
			}
			return nil, err
		}
		for _, r := range repos {
			name := repoShortName(project, r.Name)
			ch, err := c.GetChart(ctx, project, name)
			if err != nil {
				if err == models.ErrNotFound {
					continue
				}
				return nil, err
			}
			if ch.Description == "" {
				ch.Description = r.Description
			}
			out = append(out, *ch)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Project+"/"+out[i].Name < out[j].Project+"/"+out[j].Name
	})
	return out, nil
}

func (c *Client) GetChart(ctx context.Context, project, name string) (*models.Chart, error) {
	arts, err := c.listArtifacts(ctx, project, name)
	if err != nil {
		return nil, err
	}
	if len(arts) == 0 {
		return nil, models.ErrNotFound
	}
	vers := make([]models.ChartVersion, 0, len(arts))
	ch := &models.Chart{Project: project, Name: name}
	for _, a := range arts {
		vers = append(vers, artifactToVersion(project, name, a))
		if ch.Description == "" {
			ch.Description = a.ExtraAttrs.Description
		}
		if ch.IconURL == "" {
			ch.IconURL = a.ExtraAttrs.Icon
		}
	}
	// versions oldest->newest so LatestVersion is the newest by push time
	// ("last tag" rule, matching the fake's add()).
	sort.Slice(vers, func(i, j int) bool { return vers[i].Created.Before(vers[j].Created) })
	for _, v := range vers {
		ch.Versions = append(ch.Versions, v.Version)
	}
	ch.LatestVersion = vers[len(vers)-1].Version
	return ch, nil
}

func (c *Client) ListVersions(ctx context.Context, project, name string) ([]models.ChartVersion, error) {
	arts, err := c.listArtifacts(ctx, project, name)
	if err != nil {
		return nil, err
	}
	out := make([]models.ChartVersion, 0, len(arts))
	for _, a := range arts {
		out = append(out, artifactToVersion(project, name, a))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	return out, nil
}

func (c *Client) listArtifacts(ctx context.Context, project, name string) ([]apiArtifact, error) {
	var arts []apiArtifact
	err := c.apiGet(ctx,
		"/projects/"+url.PathEscape(project)+"/repositories/"+url.PathEscape(name)+"/artifacts",
		url.Values{"with_tag": {"true"}, "page_size": {"100"}}, &arts)
	if err != nil {
		return nil, err
	}
	return arts, nil
}

func artifactToVersion(project, name string, a apiArtifact) models.ChartVersion {
	v := models.ChartVersion{
		Project:    project,
		Name:       name,
		Digest:     a.Digest,
		AppVersion: a.ExtraAttrs.AppVersion,
	}
	// version: prefer the chart metadata, else the first tag.
	v.Version = a.ExtraAttrs.Version
	for _, t := range a.Tags {
		if v.Version == "" {
			v.Version = t.Name
		}
		if t.Name != v.Version {
			v.Tags = append(v.Tags, t.Name)
		}
	}
	if t, err := time.Parse(time.RFC3339, a.PushTime); err == nil {
		v.Created = t
	}
	return v
}

func (c *Client) GetVersion(ctx context.Context, project, name, version string) (*models.ChartVersion, error) {
	vers, err := c.ListVersions(ctx, project, name)
	if err != nil {
		return nil, err
	}
	for i := range vers {
		if vers[i].Version == version {
			return &vers[i], nil
		}
	}
	return nil, models.ErrNotFound
}

// ---- file bodies (OCI pull + untar) ----

func (c *Client) GetValues(ctx context.Context, project, name, version string) ([]byte, error) {
	return c.file(ctx, project, name, version, "values.yaml")
}
func (c *Client) GetReadme(ctx context.Context, project, name, version string) ([]byte, error) {
	return c.file(ctx, project, name, version, "README.md")
}
func (c *Client) GetSchema(ctx context.Context, project, name, version string) ([]byte, error) {
	return c.file(ctx, project, name, version, "values.schema.json")
}
func (c *Client) GetChangelog(ctx context.Context, project, name, version string) ([]byte, error) {
	return c.file(ctx, project, name, version, "CHANGELOG.md")
}

func (c *Client) file(ctx context.Context, project, name, version, filename string) ([]byte, error) {
	files, err := c.pullFiles(ctx, project, name, version)
	if err != nil {
		return nil, err
	}
	b, ok := files[filename]
	if !ok {
		return nil, models.ErrNotFound
	}
	return b, nil
}

// pullFiles resolves the chart's OCI manifest, fetches the chart .tgz layer, and
// returns its top-level files keyed by base name. Results are cached by manifest
// digest.
func (c *Client) pullFiles(ctx context.Context, project, name, version string) (map[string][]byte, error) {
	repo := project + "/" + name

	manifest, digest, err := c.fetchManifest(ctx, repo, version)
	if err != nil {
		return nil, err
	}
	if digest != "" {
		c.mu.Lock()
		cached, ok := c.blobs[digest]
		c.mu.Unlock()
		if ok {
			return cached, nil
		}
	}

	var layer string
	for _, l := range manifest.Layers {
		if l.MediaType == helmChartLayerMediaType {
			layer = l.Digest
			break
		}
	}
	if layer == "" && len(manifest.Layers) == 1 {
		layer = manifest.Layers[0].Digest // single-layer chart without the canonical media type
	}
	if layer == "" {
		return nil, fmt.Errorf("harbor: %s:%s has no helm chart layer", repo, version)
	}

	body, err := c.fetchBlob(ctx, repo, layer)
	if err != nil {
		return nil, err
	}
	files, err := extractChartFiles(body)
	if err != nil {
		return nil, fmt.Errorf("harbor: extract %s:%s: %w", repo, version, err)
	}

	if digest != "" {
		c.mu.Lock()
		if len(c.blobs) >= blobCacheCap {
			c.blobs = map[string]map[string][]byte{} // simple bounded reset
		}
		c.blobs[digest] = files
		c.mu.Unlock()
	}
	return files, nil
}

type ociManifest struct {
	Layers []struct {
		MediaType string `json:"mediaType"`
		Digest    string `json:"digest"`
	} `json:"layers"`
}

// fetchManifest GETs the OCI manifest, handling Harbor's bearer-token auth. It
// returns the parsed manifest and the manifest content digest (for caching).
func (c *Client) fetchManifest(ctx context.Context, repo, ref string) (*ociManifest, string, error) {
	endpoint := c.base + "/v2/" + repo + "/manifests/" + url.PathEscape(ref)
	resp, err := c.registryGet(ctx, endpoint, "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json")
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusNotFound {
		return nil, "", models.ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", &apiError{status: resp.StatusCode, body: strings.TrimSpace(string(data))}
	}
	var m ociManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, "", fmt.Errorf("harbor: decode manifest %s:%s: %w", repo, ref, err)
	}
	return &m, resp.Header.Get("Docker-Content-Digest"), nil
}

func (c *Client) fetchBlob(ctx context.Context, repo, digest string) ([]byte, error) {
	endpoint := c.base + "/v2/" + repo + "/blobs/" + digest
	resp, err := c.registryGet(ctx, endpoint, "*/*")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, models.ErrNotFound
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return nil, &apiError{status: resp.StatusCode, body: strings.TrimSpace(string(data))}
	}
	return io.ReadAll(io.LimitReader(resp.Body, 64<<20))
}

// registryGet issues an OCI distribution GET, negotiating a bearer token on 401
// per the WWW-Authenticate challenge (Harbor's registry token service). The
// returned response body is the caller's to close.
func (c *Client) registryGet(ctx context.Context, endpoint, accept string) (*http.Response, error) {
	do := func(bearer string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", accept)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		return c.httpc.Do(req)
	}

	resp, err := do("")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusUnauthorized {
		return resp, nil
	}
	challenge := resp.Header.Get("WWW-Authenticate")
	resp.Body.Close()
	token, err := c.fetchRegistryToken(ctx, challenge)
	if err != nil {
		return nil, err
	}
	return do(token)
}

// fetchRegistryToken exchanges a Bearer WWW-Authenticate challenge for a token
// at the registry's token realm, attaching robot creds when configured.
func (c *Client) fetchRegistryToken(ctx context.Context, challenge string) (string, error) {
	realm, params := parseBearerChallenge(challenge)
	if realm == "" {
		return "", fmt.Errorf("harbor: unexpected auth challenge %q", challenge)
	}
	q := url.Values{}
	if s := params["service"]; s != "" {
		q.Set("service", s)
	}
	if s := params["scope"]; s != "" {
		q.Set("scope", s)
	}
	endpoint := realm
	if len(q) > 0 {
		endpoint += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	if a := c.basicAuth(); a != "" {
		req.Header.Set("Authorization", a)
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", &apiError{status: resp.StatusCode, body: strings.TrimSpace(string(data))}
	}
	var tok struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(data, &tok); err != nil {
		return "", fmt.Errorf("harbor: decode token: %w", err)
	}
	if tok.Token != "" {
		return tok.Token, nil
	}
	return tok.AccessToken, nil
}

// parseBearerChallenge parses `Bearer realm="...",service="...",scope="..."`.
func parseBearerChallenge(h string) (realm string, params map[string]string) {
	params = map[string]string{}
	h = strings.TrimSpace(h)
	if !strings.HasPrefix(strings.ToLower(h), "bearer ") {
		return "", params
	}
	for _, part := range strings.Split(h[len("Bearer "):], ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		key := strings.TrimSpace(kv[0])
		val := strings.Trim(strings.TrimSpace(kv[1]), `"`)
		if key == "realm" {
			realm = val
		} else {
			params[key] = val
		}
	}
	return realm, params
}

// chartFiles are the top-level chart files the catalog serves.
var chartFiles = map[string]bool{
	"values.yaml":        true,
	"README.md":          true,
	"values.schema.json": true,
	"CHANGELOG.md":       true,
}

// extractChartFiles untars a Helm chart .tgz and returns the chart's top-level
// files (one directory deep: "{chart}/values.yaml" etc.), keyed by base name.
// Subchart files under "{chart}/charts/..." are deeper and thus ignored.
func extractChartFiles(tgz []byte) (map[string][]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(tgz))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	out := map[string][]byte{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag != tar.TypeReg {
			continue
		}
		clean := path.Clean(h.Name)
		parts := strings.Split(clean, "/")
		if len(parts) != 2 { // "{chart}/{file}" only
			continue
		}
		base := parts[1]
		if !chartFiles[base] {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(tr, 16<<20))
		if err != nil {
			return nil, err
		}
		out[base] = b
	}
	return out, nil
}

func (c *Client) Healthz(ctx context.Context) error {
	var out struct {
		Status string `json:"status"`
	}
	if err := c.apiGet(ctx, "/health", nil, &out); err != nil {
		return err
	}
	if out.Status != "" && !strings.EqualFold(out.Status, "healthy") {
		return fmt.Errorf("harbor: unhealthy: %s", out.Status)
	}
	return nil
}
