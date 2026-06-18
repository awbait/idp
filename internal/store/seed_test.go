package store

import (
	"testing"

	"console/internal/views"
)

// The ingress-gateway seed document must pass format validation - otherwise
// the builder would immediately show errors on the reference publication.
func TestSeedViewIsStructurallyValid(t *testing.T) {
	if issues := views.ValidateStructure(seedIngressView); len(issues) > 0 {
		t.Fatalf("seed view has issues: %+v", issues)
	}
}
