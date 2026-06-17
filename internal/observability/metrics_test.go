package observability

import (
	"errors"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestObserveReconcileCountsResults(t *testing.T) {
	ObserveReconcile("unit-test-recon", 0, nil)
	ObserveReconcile("unit-test-recon", 0, errors.New("boom"))
	ObserveReconcile("unit-test-recon", 0, nil)

	if got := testutil.ToFloat64(reconcileRuns.WithLabelValues("unit-test-recon", "ok")); got != 2 {
		t.Fatalf("ok runs = %v, want 2", got)
	}
	if got := testutil.ToFloat64(reconcileRuns.WithLabelValues("unit-test-recon", "error")); got != 1 {
		t.Fatalf("error runs = %v, want 1", got)
	}
	if got := testutil.ToFloat64(reconcileLastSuccess.WithLabelValues("unit-test-recon")); got == 0 {
		t.Fatal("last success timestamp not set after a successful tick")
	}
}

func TestSetOrderCountsResetsDrainedStatuses(t *testing.T) {
	known := []string{"DRAFT", "HEALTHY", "DEGRADED"}

	SetOrderCounts(map[string]int{"DRAFT": 3, "HEALTHY": 5}, known)
	if got := testutil.ToFloat64(orders.WithLabelValues("HEALTHY")); got != 5 {
		t.Fatalf("HEALTHY = %v, want 5", got)
	}

	// HEALTHY drained to 0: the gauge must follow, not keep the stale 5.
	SetOrderCounts(map[string]int{"DRAFT": 3}, known)
	if got := testutil.ToFloat64(orders.WithLabelValues("HEALTHY")); got != 0 {
		t.Fatalf("HEALTHY after drain = %v, want 0", got)
	}
}

func TestSetComponentUpExposesGauge(t *testing.T) {
	SetComponentUp("unit-test-comp", "integration", "fake", true, 0)

	const want = `
# HELP console_component_up Platform component health: 1 if the last probe succeeded, 0 otherwise.
# TYPE console_component_up gauge
console_component_up{component="unit-test-comp",kind="integration",mode="fake"} 1
`
	if err := testutil.CollectAndCompare(componentUp, strings.NewReader(want), "console_component_up"); err != nil {
		t.Fatal(err)
	}
}
