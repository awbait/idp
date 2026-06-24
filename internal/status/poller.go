package status

import (
	"context"
	"log/slog"
	"sync"
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
	// mu guards the per-reconciler state maps below: tick() writes them from the
	// Run goroutine, Snapshot() reads them from an HTTP handler goroutine.
	mu sync.Mutex
	// failing tracks which reconcilers were failing on the previous tick, keyed
	// by name, so we log on the ok<->fail edge instead of every tick.
	failing map[string]bool
	// fails counts consecutive failures per reconciler; nextAttempt is the time
	// before which a failing reconciler is skipped (exponential backoff).
	fails       map[string]int
	nextAttempt map[string]time.Time
	// lastSuccess/lastErr/lastDuration record the most recent outcome per
	// reconciler for the status page (Snapshot).
	lastSuccess  map[string]time.Time
	lastErr      map[string]string
	lastDuration map[string]time.Duration
	// now is the clock, injectable in tests; defaults to time.Now.
	now func() time.Time
}

// NewPoller builds a poller. Reconcilers run in order each tick.
func NewPoller(interval time.Duration, log *slog.Logger, reconcilers ...Reconciler) *Poller {
	return &Poller{
		interval: interval, reconcilers: reconcilers, log: log,
		failing: map[string]bool{}, fails: map[string]int{}, nextAttempt: map[string]time.Time{},
		lastSuccess: map[string]time.Time{}, lastErr: map[string]string{}, lastDuration: map[string]time.Duration{},
		now: time.Now,
	}
}

// ReconcilerState is a point-in-time view of one reconciler's health, for the
// status page. LastSuccess is zero if it has never succeeded.
type ReconcilerState struct {
	Name        string
	Failing     bool
	Fails       int
	LastSuccess time.Time
	LastErr     string
	LastRunMs   int64
}

// Snapshot returns the current health of every reconciler, in run order. Safe to
// call concurrently with the poller loop.
func (p *Poller) Snapshot() []ReconcilerState {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]ReconcilerState, 0, len(p.reconcilers))
	for _, r := range p.reconcilers {
		name := nameOf(r)
		out = append(out, ReconcilerState{
			Name:        name,
			Failing:     p.failing[name],
			Fails:       p.fails[name],
			LastSuccess: p.lastSuccess[name],
			LastErr:     p.lastErr[name],
			LastRunMs:   p.lastDuration[name].Milliseconds(),
		})
	}
	return out
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
		p.mu.Lock()
		next, inBackoff := p.nextAttempt[name]
		p.mu.Unlock()
		if inBackoff && p.now().Before(next) {
			continue
		}
		start := time.Now()
		rctx, cancel := context.WithTimeout(ctx, reconcileTimeout)
		err := r.Reconcile(rctx)
		cancel()
		dur := time.Since(start)
		observability.ObserveReconcile(name, dur, err)

		p.mu.Lock()
		p.lastDuration[name] = dur
		wasFailing := p.failing[name]
		if err != nil {
			p.fails[name]++
			p.nextAttempt[name] = p.now().Add(backoffFor(p.interval, p.fails[name]))
			p.lastErr[name] = err.Error()
			p.failing[name] = true
		} else {
			delete(p.fails, name)
			delete(p.nextAttempt, name)
			p.lastErr[name] = ""
			p.lastSuccess[name] = p.now()
			p.failing[name] = false
		}
		fails := p.fails[name]
		p.mu.Unlock()

		// Log on the ok<->fail edge only: a flapping upstream (e.g. GitLab still
		// booting) would otherwise spam one WARN per tick. Steady-state lines stay
		// at debug. Metrics above still record every tick for rate/alerting.
		switch {
		case err != nil && !wasFailing:
			p.log.Warn("reconcile failing", "reconciler", name, "err", err)
		case err != nil:
			p.log.Debug("reconcile still failing", "reconciler", name, "err", err, "backoff_ms", backoffFor(p.interval, fails).Milliseconds())
		case wasFailing:
			p.log.Info("reconcile recovered", "reconciler", name, "duration_ms", dur.Milliseconds())
		default:
			p.log.Debug("reconcile ok", "reconciler", name, "duration_ms", dur.Milliseconds())
		}
	}
}
