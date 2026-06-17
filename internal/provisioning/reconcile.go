package provisioning

import (
	"context"
	"errors"
	"time"

	"idp/internal/argocd"
	"idp/pkg/models"
)

// Reconcile advances every active order based on its MR and ArgoCD state.
// It is mode-agnostic (works against real or fake upstreams) and idempotent,
// so the single-replica poller can call it on every tick.
func (s *Service) Reconcile(ctx context.Context) error {
	active, err := s.store.ListActive(ctx)
	if err != nil {
		return err
	}
	for _, r := range active {
		s.reconcileOne(ctx, r)
	}
	return nil
}

func (s *Service) reconcileOne(ctx context.Context, r *models.Request) {
	// 1) advance MR state from the latest MR (works even if it merged instantly)
	if mrs, err := s.store.ListMRs(ctx, r.ID); err == nil && len(mrs) > 0 {
		latest := mrs[len(mrs)-1]
		// Optional auto-merge: merge the open MR ourselves (no human gate). A
		// just-created MR may not be mergeable yet; that errors and is retried
		// next tick. The GetMR below then observes the merged state.
		if s.autoMerge && latest.Status == models.MROpened &&
			(r.Status == models.StatusMRCreated || r.Status == models.StatusDeleteRequested) {
			_ = s.gl.MergeMR(ctx, latest.GitLabProjectID, latest.MRIID)
		}
		if live, gerr := s.gl.GetMR(ctx, latest.GitLabProjectID, latest.MRIID); gerr == nil {
			if live.State != latest.Status {
				latest.Status = live.State
				_ = s.store.UpdateMR(ctx, latest)
			}
		}
		switch r.Status {
		case models.StatusMRCreated:
			switch latest.Status {
			case models.MRMerged:
				s.tryTransition(ctx, r, models.StatusMRMerged)
			case models.MRClosed:
				s.tryTransition(ctx, r, models.StatusMRClosed)
			}
		case models.StatusDeleteRequested:
			switch latest.Status {
			case models.MRMerged:
				s.tryTransition(ctx, r, models.StatusDeleteMRMerged)
			case models.MRClosed:
				s.tryTransition(ctx, r, models.StatusMRClosed)
			}
		}
	}

	// 2) reconcile against ArgoCD
	switch r.Status {
	case models.StatusMRMerged:
		if _, err := s.argo.GetApplication(ctx, r.ArgoCDAppName); err == nil {
			s.tryTransition(ctx, r, models.StatusDeploying)
			// Nudge ArgoCD to pull and apply the just-merged revision now instead
			// of waiting for its own git poll; reconcile then gates Healthy on it.
			_ = s.argo.Sync(ctx, r.ArgoCDAppName)
		}
	case models.StatusDeploying:
		// Freshly merged: wait until ArgoCD has actually finished syncing before
		// calling it Healthy, so we don't latch onto a stale pre-sync report.
		if app, err := s.argo.GetApplication(ctx, r.ArgoCDAppName); err == nil {
			if target := mapHealth(app.Health); target != "" &&
				(target != models.StatusHealthy || deploySettled(app)) {
				s.tryTransition(ctx, r, target)
			}
		}
	case models.StatusHealthy, models.StatusDegraded:
		// Already deployed: follow ArgoCD's reported health directly. Do NOT gate on
		// sync status here. Instances of the same chart share one Git branch, so a
		// sibling's create/update/delete MR advances the branch and briefly marks
		// this (unchanged) app OutOfSync; that must not demote a Healthy product
		// back to DEPLOYING - its own manifests/values did not change.
		if app, err := s.argo.GetApplication(ctx, r.ArgoCDAppName); err == nil {
			if target := mapHealth(app.Health); target != "" {
				s.tryTransition(ctx, r, target)
			}
		}
	case models.StatusDeleteMRMerged:
		if _, err := s.argo.GetApplication(ctx, r.ArgoCDAppName); errors.Is(err, models.ErrNotFound) {
			s.markDeleted(ctx, r)
		}
	}
}

// deploySettled reports whether ArgoCD has finished applying the desired state
// (Synced), so a Healthy report reflects the merged change rather than a stale
// pre-sync read right after a merge. We rely on Sync status, not on matching a
// specific Git commit: instances of one chart share a single Git branch, so an
// app's revision tracks the whole branch (advanced by any sibling's MR) rather
// than this instance's own change - comparing exact commits would wedge unrelated
// instances in DEPLOYING. Only used while DEPLOYING (see reconcileOne).
func deploySettled(app *argocd.Application) bool {
	return app.Sync == argocd.SyncSynced
}

func mapHealth(h argocd.HealthStatus) models.RequestStatus {
	switch h {
	case argocd.HealthHealthy:
		return models.StatusHealthy
	case argocd.HealthProgressing:
		return models.StatusDeploying
	case argocd.HealthDegraded:
		return models.StatusDegraded
	case argocd.HealthMissing:
		return models.StatusArgoMissing
	default:
		return ""
	}
}

// tryTransition transitions, ignoring no-op and stale-version races (retried next tick).
func (s *Service) tryTransition(ctx context.Context, r *models.Request, to models.RequestStatus) {
	if r.Status == to {
		return
	}
	if !CanTransition(r.Status, to) {
		return
	}
	_ = s.transition(ctx, r, to, "system")
}

func (s *Service) markDeleted(ctx context.Context, r *models.Request) {
	if !CanTransition(r.Status, models.StatusDeleted) {
		return
	}
	now := time.Now()
	r.DeletedAt = &now
	r.Status = models.StatusDeleted
	if err := s.store.UpdateRequest(ctx, r); err != nil {
		return
	}
	s.event(ctx, r, "system", "deleted", models.StatusDeleteMRMerged, models.StatusDeleted)
	s.publishStatus(r.ID, string(models.StatusDeleted))
}
