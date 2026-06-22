package status

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// scriptedReconciler returns the next error from a fixed script on each call.
type scriptedReconciler struct {
	errs []error
	i    int
}

func (s *scriptedReconciler) Reconcile(context.Context) error {
	e := s.errs[s.i]
	if s.i < len(s.errs)-1 {
		s.i++
	}
	return e
}

// TestPollerLogsOnEdgeOnly drives a reconciler through ok -> fail -> fail -> ok
// and asserts the poller logs the WARN/INFO edges once, not every tick.
func TestPollerLogsOnEdgeOnly(t *testing.T) {
	boom := errors.New("gitlab: status 502")
	rec := Named("import", &scriptedReconciler{errs: []error{nil, boom, boom, boom, nil}})

	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}))
	p := NewPoller(time.Hour, log, rec)
	// Advance the clock well past any backoff before each tick, so the reconciler
	// runs every tick (this test exercises edge-logging, not backoff).
	clock := time.Unix(0, 0)
	p.now = func() time.Time { return clock }

	for range 5 {
		p.tick(context.Background())
		clock = clock.Add(24 * time.Hour)
	}

	out := buf.String()
	if got := strings.Count(out, "reconcile failing"); got != 1 {
		t.Fatalf(`"reconcile failing" logged %d times, want 1 (edge only)`+"\n%s", got, out)
	}
	if got := strings.Count(out, "reconcile recovered"); got != 1 {
		t.Fatalf(`"reconcile recovered" logged %d times, want 1 (edge only)`+"\n%s", got, out)
	}
	// At info level the repeated-failure and steady-ok debug lines stay silent.
	if strings.Contains(out, "reconcile still failing") || strings.Contains(out, "reconcile ok") {
		t.Fatalf("debug-level lines leaked at info level:\n%s", out)
	}
}

func TestBackoffFor(t *testing.T) {
	const iv = 10 * time.Second
	cases := []struct {
		failures int
		want     time.Duration
	}{
		{0, 0},
		{1, iv},
		{2, 2 * iv},
		{3, 4 * iv},
		{100, backoffMax}, // overflow / cap
	}
	for _, c := range cases {
		if got := backoffFor(iv, c.failures); got != c.want {
			t.Errorf("backoffFor(%v, %d) = %v, want %v", iv, c.failures, got, c.want)
		}
	}
}

// TestPollerBacksOff: a persistently-failing reconciler is skipped while in
// backoff and retried once the (controlled) clock passes nextAttempt.
func TestPollerBacksOff(t *testing.T) {
	rec := &countingReconciler{err: errors.New("boom")}
	log := slog.New(slog.NewJSONHandler(&bytes.Buffer{}, &slog.HandlerOptions{Level: slog.LevelError}))
	p := NewPoller(time.Minute, log, Named("x", rec))
	clock := time.Unix(0, 0)
	p.now = func() time.Time { return clock }

	p.tick(context.Background()) // runs, fails -> backoff 1m
	if rec.calls != 1 {
		t.Fatalf("first tick should run, calls=%d", rec.calls)
	}
	clock = clock.Add(30 * time.Second) // still within 1m backoff
	p.tick(context.Background())
	if rec.calls != 1 {
		t.Fatalf("tick within backoff must skip, calls=%d", rec.calls)
	}
	clock = clock.Add(31 * time.Second) // now past the 1m backoff
	p.tick(context.Background())
	if rec.calls != 2 {
		t.Fatalf("tick after backoff must run, calls=%d", rec.calls)
	}
}

type countingReconciler struct {
	err   error
	calls int
}

func (c *countingReconciler) Reconcile(context.Context) error {
	c.calls++
	return c.err
}
