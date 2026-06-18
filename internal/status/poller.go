package status

import (
	"context"
	"log/slog"
	"time"

	"console/internal/observability"
)

// Reconciler advances state on each tick. Both the fake ArgoCD (materialise
// apps from git) and the provisioning service implement it.
type Reconciler interface {
	Reconcile(ctx context.Context) error
}

// named tags a Reconciler with a stable label for metrics and logging.
type named struct {
	Reconciler
	name string
}

// Named wraps a reconciler so the poller can label its metrics. Unwrapped
// reconcilers report under "unknown".
func Named(name string, r Reconciler) Reconciler { return named{Reconciler: r, name: name} }

// nameOf returns the metrics label for a reconciler.
func nameOf(r Reconciler) string {
	if n, ok := r.(named); ok {
		return n.name
	}
	return "unknown"
}

// Poller runs the reconcilers on an interval. MVP is single-replica, so this
// runs in-process with no leader election (see spec techdebt note).
type Poller struct {
	interval    time.Duration
	reconcilers []Reconciler
	log         *slog.Logger
	// failing tracks which reconcilers were failing on the previous tick, keyed
	// by name, so we log on the ok<->fail edge instead of every tick. Accessed
	// only from the single Run goroutine, so it needs no lock.
	failing map[string]bool
}

// NewPoller builds a poller. Reconcilers run in order each tick.
func NewPoller(interval time.Duration, log *slog.Logger, reconcilers ...Reconciler) *Poller {
	return &Poller{interval: interval, reconcilers: reconcilers, log: log, failing: map[string]bool{}}
}

// Run blocks, ticking until the context is cancelled. It also reconciles once
// immediately on start.
func (p *Poller) Run(ctx context.Context) {
	t := time.NewTicker(p.interval)
	defer t.Stop()
	p.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.tick(ctx)
		}
	}
}

func (p *Poller) tick(ctx context.Context) {
	for _, r := range p.reconcilers {
		name := nameOf(r)
		start := time.Now()
		err := r.Reconcile(ctx)
		dur := time.Since(start)
		observability.ObserveReconcile(name, dur, err)

		// Log on the ok<->fail edge only: a flapping upstream (e.g. GitLab still
		// booting) would otherwise spam one WARN per tick. Steady-state lines stay
		// at debug. Metrics above still record every tick for rate/alerting.
		switch {
		case err != nil && !p.failing[name]:
			p.failing[name] = true
			p.log.Warn("reconcile failing", "reconciler", name, "err", err)
		case err != nil:
			p.log.Debug("reconcile still failing", "reconciler", name, "err", err)
		case p.failing[name]:
			p.failing[name] = false
			p.log.Info("reconcile recovered", "reconciler", name, "duration_ms", dur.Milliseconds())
		default:
			p.log.Debug("reconcile ok", "reconciler", name, "duration_ms", dur.Milliseconds())
		}
	}
}
