package gitlab_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"console/internal/gitlab"
	"console/pkg/models"
)

// newServer spins up a stub GitLab and a Client pointed at it. The handler
// receives every request so each test can assert on the path/method/body.
func newServer(t *testing.T, h http.HandlerFunc) (*gitlab.Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return gitlab.NewClient(srv.URL, "tok", "managed-services", 0), srv
}

func TestClientGetGroupAndProject(t *testing.T) {
	ctx := context.Background()
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("PRIVATE-TOKEN"); got != "tok" {
			t.Errorf("missing token, got %q", got)
		}
		switch {
		case r.Method == http.MethodGet && r.URL.EscapedPath() == "/api/v4/groups/managed-services%2Fteam-core":
			// The client must send the namespaced path as a single %2F-encoded
			// segment (EscapedPath preserves it; .Path would be decoded).
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 7, "full_path": "managed-services/team-core"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/v4/projects/"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 11, "path_with_namespace": "managed-services/team-core/postgres",
				"web_url": "http://gl/x", "default_branch": "main",
			})
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusInternalServerError)
		}
	})

	g, err := c.GetGroup(ctx, "managed-services/team-core")
	if err != nil || g.ID != 7 {
		t.Fatalf("GetGroup: %+v err=%v", g, err)
	}
	p, err := c.GetProject(ctx, "managed-services/team-core/postgres")
	if err != nil || p.ID != 11 || p.DefaultBranch != "main" {
		t.Fatalf("GetProject: %+v err=%v", p, err)
	}
}

func TestClientNotFound(t *testing.T) {
	c, _ := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"message":"404 Group Not Found"}`, http.StatusNotFound)
	})
	if _, err := c.GetGroup(context.Background(), "nope"); !errors.Is(err, models.ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestClientCreateProjectConflict(t *testing.T) {
	c, _ := newServer(t, func(w http.ResponseWriter, _ *http.Request) {
		// GitLab returns 400 with this message when the path is taken.
		http.Error(w, `{"message":{"path":["has already been taken"]}}`, http.StatusBadRequest)
	})
	if _, err := c.CreateProject(context.Background(), 7, "postgres"); !errors.Is(err, models.ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
}

func TestClientCommitFilesPayload(t *testing.T) {
	var body map[string]any
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v4/projects/11/repository/commits" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		data, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(data, &body)
		w.WriteHeader(http.StatusCreated)
	})
	err := c.CommitFiles(context.Background(), 11, "portal/x", "msg", []gitlab.FileAction{
		{Action: "create", FilePath: "a/values.yaml", Content: "k: v"},
		{Action: "delete", FilePath: "a/application.yaml"},
	})
	if err != nil {
		t.Fatalf("CommitFiles: %v", err)
	}
	if body["branch"] != "portal/x" || body["commit_message"] != "msg" {
		t.Fatalf("bad commit body: %#v", body)
	}
	actions, ok := body["actions"].([]any)
	if !ok || len(actions) != 2 {
		t.Fatalf("want 2 actions, got %#v", body["actions"])
	}
	first := actions[0].(map[string]any)
	if first["action"] != "create" || first["file_path"] != "a/values.yaml" || first["content"] != "k: v" {
		t.Fatalf("bad first action: %#v", first)
	}
	// delete action omits content (omitempty)
	if _, has := actions[1].(map[string]any)["content"]; has {
		t.Fatalf("delete action should omit content: %#v", actions[1])
	}
}

func TestClientCreateAndGetMR(t *testing.T) {
	ctx := context.Background()
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v4/projects/11/merge_requests":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"iid": 3, "project_id": 11, "web_url": "http://gl/mr/3", "state": "opened",
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v4/projects/11/merge_requests/3":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"iid": 3, "project_id": 11, "web_url": "http://gl/mr/3", "state": "merged",
			})
		default:
			http.Error(w, "unexpected", http.StatusInternalServerError)
		}
	})

	mr, err := c.CreateMR(ctx, 11, "portal/x", "main", "Create x")
	if err != nil || mr.IID != 3 || mr.State != models.MROpened {
		t.Fatalf("CreateMR: %+v err=%v", mr, err)
	}
	got, err := c.GetMR(ctx, 11, 3)
	if err != nil || got.State != models.MRMerged {
		t.Fatalf("GetMR: %+v err=%v", got, err)
	}
}

func TestClientListApplicationManifests(t *testing.T) {
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v4/groups/managed-services/projects":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"id": 11, "path_with_namespace": "managed-services/team-core/ingress-gateway", "default_branch": "main"},
				{"id": 12, "path_with_namespace": "managed-services/team-core/empty", "default_branch": ""}, // skipped
			})
		case r.URL.Path == "/api/v4/projects/11/repository/tree":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"path": "gw/application.yaml", "type": "blob"},
				{"path": "gw/values.yaml", "type": "blob"}, // not a manifest
			})
		case r.URL.EscapedPath() == "/api/v4/projects/11/repository/files/gw%2Fapplication.yaml/raw":
			_, _ = w.Write([]byte("kind: Application\nmetadata:\n  name: core-gw\n"))
		default:
			http.Error(w, "unexpected "+r.URL.Path, http.StatusInternalServerError)
		}
	})

	manifests, err := c.ListApplicationManifests(context.Background())
	if err != nil {
		t.Fatalf("ListApplicationManifests: %v", err)
	}
	if len(manifests) != 1 {
		t.Fatalf("want 1 manifest, got %d", len(manifests))
	}
	if !strings.Contains(string(manifests[0]), "core-gw") {
		t.Fatalf("unexpected manifest: %s", manifests[0])
	}
}

func TestClientListTreePaginates(t *testing.T) {
	// First page returns 100 blobs, second returns the rest, then stop.
	c, _ := newServer(t, func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		var entries []map[string]any
		switch page {
		case "1":
			for range 100 {
				entries = append(entries, map[string]any{"path": "d/f", "type": "blob"})
			}
		case "2":
			entries = []map[string]any{
				{"path": "d/last.yaml", "type": "blob"},
				{"path": "d/sub", "type": "tree"}, // directories are skipped
			}
		}
		_ = json.NewEncoder(w).Encode(entries)
	})
	files, err := c.ListTree(context.Background(), 11, "main", "d")
	if err != nil {
		t.Fatalf("ListTree: %v", err)
	}
	if len(files) != 101 {
		t.Fatalf("want 101 blobs across pages, got %d", len(files))
	}
}
