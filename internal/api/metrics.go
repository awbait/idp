package api

import (
	"context"
	"time"

	"console/internal/observability"
	"console/internal/store"
	"console/pkg/models"
)

// orderStatuses is the full set of order lifecycle states, used to reset drained
// statuses to 0 in the gauge so a state that emptied out stops reporting its
// last count.
var orderStatuses = []models.RequestStatus{
	models.StatusDraft, models.StatusMRCreated, models.StatusMRClosed,
	models.StatusMRMerged, models.StatusDeploying, models.StatusHealthy,
	models.StatusDegraded, models.StatusArgoMissing, models.StatusDeleteRequested,
	models.StatusDeleteMRMerged, models.StatusDeleted,
}

// RunMetricsRefresher periodically refreshes the platform-status and order
// gauges until ctx is cancelled. It refreshes once immediately, then on each
// tick. Single-replica MVP, so it runs in-process alongside the poller.
func (s *Server) RunMetricsRefresher(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	s.refreshMetrics(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.refreshMetrics(ctx)
		}
	}
}

// refreshMetrics probes every platform component and counts orders by status,
// pushing both into the Prometheus collectors.
func (s *Server) refreshMetrics(ctx context.Context) {
	s.refreshComponentMetrics(ctx)
	s.refreshOrderMetrics(ctx)
}

// refreshComponentMetrics runs each status probe (timed) and records up/down +
// latency. Probes run sequentially; the set is small and each is bounded by
// checkTimeout, so a stuck upstream cannot stall the others for long.
func (s *Server) refreshComponentMetrics(ctx context.Context) {
	for _, c := range s.statusChecks() {
		pctx, cancel := context.WithTimeout(ctx, checkTimeout)
		start := time.Now()
		err := c.probe(pctx)
		cancel()
		observability.SetComponentUp(c.name, c.kind, c.mode, err == nil, time.Since(start))
	}
}

// refreshOrderMetrics counts non-deleted-scoped orders by status across all
// teams and updates the per-status gauge.
func (s *Server) refreshOrderMetrics(ctx context.Context) {
	reqs, err := s.Store.ListRequests(ctx, store.RequestFilter{Admin: true, IncludeDeleted: true})
	if err != nil {
		s.Log.Warn("metrics: list requests failed", "err", err)
		return
	}
	counts := make(map[string]int, len(orderStatuses))
	for _, r := range reqs {
		counts[string(r.Status)]++
	}
	known := make([]string, len(orderStatuses))
	for i, st := range orderStatuses {
		known[i] = string(st)
	}
	observability.SetOrderCounts(counts, known)
}
