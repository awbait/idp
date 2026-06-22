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

// reconcileTimeout is a per-reconciler safety net so a wedged DB query or
// upstream call (background paths carry no request deadline) cannot tie up a
// connection forever and block every later reconciler. Generous: normal ticks
// finish in milliseconds to seconds.
const reconcileTimeout = 5 * time.Minute

// backoffMax caps the exponential backoff applied to a failing reconciler, so a
// persistently-broken upstream (e.g. GitLab discovery scanning every project) is
// not hammered every tick.
const backoffMax = 5 * time.Minute

// backoffFor returns how long to skip a reconciler after `failures` consecutive
// failures: interval * 2^(failures-1), capped at backoffMax. Zero means "run now".
func backoffFor(interval time.Duration, failures int) time.Duration {
	if failures <= 0 {
		return 0
	}
	d := interval << (failures - 1) // interval * 2^(failures-1)
	if d <= 0 || d > backoffMax {   // overflow or over cap
		return backoffMax
	}
	return d
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
	// fails counts consecutive failures per reconciler; nextAttempt is the time
	// before which a failing reconciler is skipped (exponential backoff).
	fails       map[string]int
	nextAttempt map[string]time.Time
	// now is the clock, injectable in tests; defaults to time.Now.
	now func() time.Time
}

// NewPoller builds a poller. Reconcilers run in order each tick.
func NewPoller(interval time.Duration, log *slog.Logger, reconcilers ...Reconciler) *Poller {
	return &Poller{
		interval: interval, reconcilers: reconcilers, log: log,
		failing: map[string]bool{}, fails: map[string]int{}, nextAttempt: map[string]time.Time{},
		now: time.Now,
	}
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
		// Skip reconcilers in backoff after consecutive failures, so a broken
		// upstream is retried with exponential delay instead of every tick.
		if t, ok := p.nextAttempt[name]; ok && p.now().Before(t) {
			continue
		}
		start := time.Now()
		rctx, cancel := context.WithTimeout(ctx, reconcileTimeout)
		err := r.Reconcile(rctx)
		cancel()
		dur := time.Since(start)
		observability.ObserveReconcile(name, dur, err)

		if err != nil {
			p.fails[name]++
			p.nextAttempt[name] = p.now().Add(backoffFor(p.interval, p.fails[name]))
		} else {
			delete(p.fails, name)
			delete(p.nextAttempt, name)
		}

		// Log on the ok<->fail edge only: a flapping upstream (e.g. GitLab still
		// booting) would otherwise spam one WARN per tick. Steady-state lines stay
		// at debug. Metrics above still record every tick for rate/alerting.
		switch {
		case err != nil && !p.failing[name]:
			p.failing[name] = true
			p.log.Warn("reconcile failing", "reconciler", name, "err", err)
		case err != nil:
			p.log.Debug("reconcile still failing", "reconciler", name, "err", err, "backoff_ms", backoffFor(p.interval, p.fails[name]).Milliseconds())
		case p.failing[name]:
			p.failing[name] = false
			p.log.Info("reconcile recovered", "reconciler", name, "duration_ms", dur.Milliseconds())
		default:
			p.log.Debug("reconcile ok", "reconciler", name, "duration_ms", dur.Milliseconds())
		}
	}
}
