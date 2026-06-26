package webhooks

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// countTrigger records how many times Trigger was called and the last reason.
type countTrigger struct {
	n      atomic.Int64
	reason atomic.Value
}

func (c *countTrigger) Trigger(reason string) {
	c.n.Add(1)
	c.reason.Store(reason)
}

func newHandler() (*Handler, *countTrigger) {
	tr := &countTrigger{}
	return New(tr, nil, "gl-secret", "hb-secret"), tr
}

func post(h http.HandlerFunc, header, token, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	if header != "" {
		r.Header.Set(header, token)
	}
	rec := httptest.NewRecorder()
	h(rec, r)
	return rec
}

func TestGitLabMergeTriggers(t *testing.T) {
	h, tr := newHandler()
	body := `{"object_kind":"merge_request","project":{"id":7},"object_attributes":{"iid":3,"action":"merge","state":"merged"}}`
	rec := post(h.GitLab, "X-Gitlab-Token", "gl-secret", body)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if tr.n.Load() != 1 {
		t.Fatalf("trigger calls = %d, want 1", tr.n.Load())
	}
}

func TestGitLabNonTerminalIgnored(t *testing.T) {
	h, tr := newHandler()
	body := `{"object_kind":"merge_request","object_attributes":{"iid":3,"action":"open","state":"opened"}}`
	rec := post(h.GitLab, "X-Gitlab-Token", "gl-secret", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (ignored)", rec.Code)
	}
	if tr.n.Load() != 0 {
		t.Fatalf("trigger calls = %d, want 0", tr.n.Load())
	}
}

func TestGitLabBadSecretRejected(t *testing.T) {
	h, tr := newHandler()
	body := `{"object_kind":"merge_request","object_attributes":{"action":"merge"}}`
	rec := post(h.GitLab, "X-Gitlab-Token", "wrong", body)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if tr.n.Load() != 0 {
		t.Fatalf("trigger must not fire on bad secret")
	}
}

func TestGitLabMissingTokenRejected(t *testing.T) {
	h, _ := newHandler()
	rec := post(h.GitLab, "", "", `{}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestGitLabBadJSON(t *testing.T) {
	h, tr := newHandler()
	rec := post(h.GitLab, "X-Gitlab-Token", "gl-secret", `{not json`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if tr.n.Load() != 0 {
		t.Fatalf("trigger must not fire on bad json")
	}
}

func TestHarborPushTriggers(t *testing.T) {
	h, tr := newHandler()
	body := `{"type":"PUSH_ARTIFACT","event_data":{"repository":{"repo_full_name":"managed-services/redis"}}}`
	rec := post(h.Harbor, "Authorization", "hb-secret", body)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	if tr.n.Load() != 1 {
		t.Fatalf("trigger calls = %d, want 1", tr.n.Load())
	}
}

func TestHarborOtherEventIgnored(t *testing.T) {
	h, tr := newHandler()
	body := `{"type":"SCANNING_COMPLETED"}`
	rec := post(h.Harbor, "Authorization", "hb-secret", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (ignored)", rec.Code)
	}
	if tr.n.Load() != 0 {
		t.Fatalf("trigger calls = %d, want 0", tr.n.Load())
	}
}

func TestHarborBadSecretRejected(t *testing.T) {
	h, _ := newHandler()
	rec := post(h.Harbor, "Authorization", "nope", `{"type":"PUSH_ARTIFACT"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestEnabledFlags(t *testing.T) {
	full := New(nil, nil, "a", "b")
	if !full.GitLabEnabled() || !full.HarborEnabled() {
		t.Fatal("both sources should be enabled")
	}
	none := New(nil, nil, "", "")
	if none.GitLabEnabled() || none.HarborEnabled() {
		t.Fatal("empty secrets must disable both sources")
	}
}

func TestSecretOKEmptyNeverMatches(t *testing.T) {
	if secretOK("", "") {
		t.Fatal("empty want must never match, even against empty got")
	}
}
