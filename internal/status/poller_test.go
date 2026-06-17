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

	for range 5 {
		p.tick(context.Background())
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
