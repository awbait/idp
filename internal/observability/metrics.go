package observability

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Prometheus metrics for the portal. All series carry the `console_` prefix and are
// registered on the default registry, which promhttp.Handler() (mounted at
// /metrics) exposes. Collectors are package-level so any layer can update them
// without threading a registry through the call graph.
var (
	// componentUp is 1 when a platform component (upstream or storage backend)
	// answered its probe, 0 otherwise. Mirrors GET /api/v1/status.
	componentUp = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "console_component_up",
		Help: "Platform component health: 1 if the last probe succeeded, 0 otherwise.",
	}, []string{"component", "kind", "mode"})

	// componentProbeDuration tracks how long each component probe takes.
	componentProbeDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "console_component_probe_duration_seconds",
		Help:    "Duration of a platform component health probe.",
		Buckets: prometheus.DefBuckets,
	}, []string{"component"})

	// componentLastProbe is the unix timestamp of the last probe of a component;
	// a stale value flags a stuck refresher.
	componentLastProbe = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "console_component_last_probe_timestamp_seconds",
		Help: "Unix timestamp of the last health probe of a platform component.",
	}, []string{"component"})

	// orders is the number of orders in each lifecycle status (DRAFT, HEALTHY,
	// DEGRADED, ...). Refreshed periodically from the store.
	orders = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "console_orders",
		Help: "Number of orders currently in each lifecycle status.",
	}, []string{"status"})

	// reconcileRuns counts background reconcile ticks per reconciler and outcome.
	reconcileRuns = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "console_reconcile_runs_total",
		Help: "Total background reconcile ticks, by reconciler and result.",
	}, []string{"reconciler", "result"})

	// reconcileDuration tracks how long a reconciler tick takes.
	reconcileDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "console_reconcile_duration_seconds",
		Help:    "Duration of a single reconciler tick.",
		Buckets: prometheus.DefBuckets,
	}, []string{"reconciler"})

	// reconcileLastSuccess is the unix timestamp of the last successful tick per
	// reconciler; alert when its age exceeds the poll interval.
	reconcileLastSuccess = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "console_reconcile_last_success_timestamp_seconds",
		Help: "Unix timestamp of the last successful reconciler tick.",
	}, []string{"reconciler"})
)

// SetComponentUp records the health of a platform component (up/down), its probe
// latency and the time of the probe.
func SetComponentUp(name, kind, mode string, up bool, d time.Duration) {
	v := 0.0
	if up {
		v = 1
	}
	componentUp.WithLabelValues(name, kind, mode).Set(v)
	componentProbeDuration.WithLabelValues(name).Observe(d.Seconds())
	componentLastProbe.WithLabelValues(name).Set(float64(time.Now().Unix()))
}

// SetOrderCounts replaces the per-status order gauge. Statuses absent from the
// map are reset to 0 so drained states do not linger at their last value; pass
// the full set of known statuses as `known`.
func SetOrderCounts(counts map[string]int, known []string) {
	for _, s := range known {
		orders.WithLabelValues(s).Set(float64(counts[s]))
	}
}

// ObserveReconcile records one reconciler tick: its duration, the run counter
// (result=ok|error) and, on success, the last-success timestamp.
func ObserveReconcile(name string, d time.Duration, err error) {
	reconcileDuration.WithLabelValues(name).Observe(d.Seconds())
	result := "ok"
	if err != nil {
		result = "error"
	}
	reconcileRuns.WithLabelValues(name, result).Inc()
	if err == nil {
		reconcileLastSuccess.WithLabelValues(name).Set(float64(time.Now().Unix()))
	}
}
