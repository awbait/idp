package api_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"console/internal/api"
)

// TestMetricsHandlerServes: the dedicated metrics handler exposes Prometheus
// text (served on its own port in cmd/portal, not the API router).
func TestMetricsHandlerServes(t *testing.T) {
	rec := httptest.NewRecorder()
	api.MetricsHandler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("metrics handler: status %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "# HELP") {
		t.Fatalf("metrics handler did not return Prometheus exposition:\n%s", rec.Body.String())
	}
}

// TestRouterDoesNotServeMetrics: /metrics must not be on the public API router
// (it moved to the dedicated metrics port). The SPA fallback handles it instead,
// so it must not return Prometheus exposition.
func TestRouterDoesNotServeMetrics(t *testing.T) {
	srv, _, _ := newServer(t)
	rec := httptest.NewRecorder()
	srv.Router().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if strings.Contains(rec.Body.String(), "# HELP") {
		t.Fatalf("/metrics is still served by the API router")
	}
}
