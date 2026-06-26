// Package webhooks handles inbound upstream webhooks that accelerate the status
// poller in hybrid mode (STATUS_UPDATE_MODE=hybrid). GitLab (merge request
// merged/closed) and Harbor (chart pushed) deliveries translate into an
// immediate reconcile sweep instead of waiting for the next poll tick.
//
// Webhooks are an accelerator, not a replacement: the periodic poll stays on as
// a safety net, so a missed or unauthenticated delivery only delays a reaction,
// never strands an order. Handlers are therefore deliberately thin - verify the
// shared secret, decide whether the event is actionable, and kick the poller.
package webhooks

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"

	"console/internal/observability"
)

// maxBodyBytes caps the webhook payload we read. Generous for a JSON event; the
// API router already wraps bodies in MaxBytesReader, this is defence in depth.
const maxBodyBytes = 1 << 20 // 1 MiB

// Triggerer kicks an immediate reconcile sweep. *status.Poller implements it;
// the interface keeps this package decoupled from the poller internals.
type Triggerer interface {
	Trigger(reason string)
}

// Handler serves the GitLab and Harbor webhook endpoints. Construct via New.
type Handler struct {
	trigger      Triggerer
	log          *slog.Logger
	gitlabToken  string
	harborSecret string
}

// New builds a Handler. gitlabToken is the shared secret expected in GitLab's
// X-Gitlab-Token header (GITLAB_WEBHOOK_TOKEN); harborSecret is the value
// expected verbatim in Harbor's Authorization header (HARBOR_WEBHOOK_SECRET).
// An empty secret disables that source (every delivery is rejected) - callers
// should avoid registering the route at all in that case.
func New(trigger Triggerer, log *slog.Logger, gitlabToken, harborSecret string) *Handler {
	return &Handler{trigger: trigger, log: log, gitlabToken: gitlabToken, harborSecret: harborSecret}
}

// GitLabEnabled reports whether the GitLab webhook secret is configured.
func (h *Handler) GitLabEnabled() bool { return h.gitlabToken != "" }

// HarborEnabled reports whether the Harbor webhook secret is configured.
func (h *Handler) HarborEnabled() bool { return h.harborSecret != "" }

// gitlabPayload is the slice of GitLab's merge-request event we act on.
// https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html
type gitlabPayload struct {
	ObjectKind string `json:"object_kind"`
	Project    struct {
		ID int `json:"id"`
	} `json:"project"`
	ObjectAttributes struct {
		IID    int    `json:"iid"`
		Action string `json:"action"` // open, close, reopen, update, merge, ...
		State  string `json:"state"`  // opened, closed, merged, ...
	} `json:"object_attributes"`
}

// GitLab handles POST /api/v1/webhooks/gitlab. It triggers a reconcile sweep on
// a merge request reaching a terminal state (merged/closed), so the portal
// reacts to a human-merged MR at once instead of on the next poll tick. Other
// events (open, update, push) are accepted but ignored - the poll covers them.
func (h *Handler) GitLab(w http.ResponseWriter, r *http.Request) {
	if !secretOK(h.gitlabToken, r.Header.Get("X-Gitlab-Token")) {
		h.reject(w, "gitlab")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		h.badRequest(w, "gitlab", "read body", err)
		return
	}
	var p gitlabPayload
	if err := json.Unmarshal(body, &p); err != nil {
		h.badRequest(w, "gitlab", "decode payload", err)
		return
	}
	// Act only on a merge request entering a terminal state. GitLab sends
	// action=merge|close (and state=merged|closed); match either to be tolerant
	// of payload variations across GitLab versions.
	terminal := p.ObjectKind == "merge_request" &&
		(p.ObjectAttributes.Action == "merge" || p.ObjectAttributes.Action == "close" ||
			p.ObjectAttributes.State == "merged" || p.ObjectAttributes.State == "closed")
	if !terminal {
		h.ignore(w, "gitlab", "merge_request_state", p.ObjectKind)
		return
	}
	h.accept(w, "gitlab", "gitlab mr "+p.ObjectAttributes.State,
		slog.Int("gitlab_project_id", p.Project.ID),
		slog.Int("mr_iid", p.ObjectAttributes.IID),
		slog.String("action", p.ObjectAttributes.Action))
}

// harborPayload is the slice of a Harbor webhook event we act on.
// https://goharbor.io/docs/latest/working-with-projects/project-configuration/configure-webhooks/
type harborPayload struct {
	Type      string `json:"type"` // PUSH_ARTIFACT, DELETE_ARTIFACT, ...
	EventData struct {
		Repository struct {
			RepoFullName string `json:"repo_full_name"`
		} `json:"repository"`
	} `json:"event_data"`
}

// Harbor handles POST /api/v1/webhooks/harbor. A pushed (or deleted) artifact
// triggers a reconcile sweep so catalog auto-discovery picks up the new chart at
// once instead of on the next poll. The catalog listing itself is uncached and
// the per-version blobs are keyed by immutable digest, so no cache invalidation
// is needed here.
func (h *Handler) Harbor(w http.ResponseWriter, r *http.Request) {
	if !secretOK(h.harborSecret, r.Header.Get("Authorization")) {
		h.reject(w, "harbor")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes))
	if err != nil {
		h.badRequest(w, "harbor", "read body", err)
		return
	}
	var p harborPayload
	if err := json.Unmarshal(body, &p); err != nil {
		h.badRequest(w, "harbor", "decode payload", err)
		return
	}
	if p.Type != "PUSH_ARTIFACT" && p.Type != "DELETE_ARTIFACT" {
		h.ignore(w, "harbor", "event_type", p.Type)
		return
	}
	h.accept(w, "harbor", "harbor "+p.Type,
		slog.String("repository", p.EventData.Repository.RepoFullName),
		slog.String("event_type", p.Type))
}

// accept kicks the poller and answers 202: the work happens asynchronously, the
// caller just needs to know the event was taken.
func (h *Handler) accept(w http.ResponseWriter, source, reason string, attrs ...slog.Attr) {
	h.trigger.Trigger(reason)
	observability.ObserveWebhook(source, "accepted")
	h.logger().LogAttrs(context.Background(), slog.LevelInfo, "webhook accepted",
		append([]slog.Attr{slog.String("source", source)}, attrs...)...)
	w.WriteHeader(http.StatusAccepted)
}

// ignore acknowledges a delivery we do not act on, so the sender does not retry
// or disable the hook. 200 with no side effect.
func (h *Handler) ignore(w http.ResponseWriter, source, field, value string) {
	observability.ObserveWebhook(source, "ignored")
	h.logger().Debug("webhook ignored", "source", source, field, value)
	w.WriteHeader(http.StatusOK)
}

func (h *Handler) reject(w http.ResponseWriter, source string) {
	observability.ObserveWebhook(source, "unauthorized")
	h.logger().Warn("webhook rejected", "source", source, "reason", "bad secret")
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

func (h *Handler) badRequest(w http.ResponseWriter, source, stage string, err error) {
	observability.ObserveWebhook(source, "bad_request")
	h.logger().Warn("webhook bad request", "source", source, "stage", stage, "err", err)
	http.Error(w, "bad request", http.StatusBadRequest)
}

func (h *Handler) logger() *slog.Logger {
	if h.log != nil {
		return h.log
	}
	return slog.Default()
}

// secretOK reports whether got matches want in constant time. An empty want
// (source not configured) never matches, so a misconfigured route cannot accept
// unauthenticated deliveries.
func secretOK(want, got string) bool {
	if want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
}
