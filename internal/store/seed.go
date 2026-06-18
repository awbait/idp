package store

import (
	"context"
	_ "embed"
	"errors"

	"github.com/google/uuid"
	"console/pkg/models"
)

// Canonical ingress-gateway view document (formerly
// web/public/schemas/ingress-gateway.ui.json), seeded as an approved publication.
//
//go:embed seed/ingress-gateway.view.json
var seedIngressView []byte

// seedCategories is the initial catalog category list; afterwards managed
// by the admin via API.
var seedCategories = []models.Category{
	{ID: "databases", Label: "Базы данных", Sort: 10},
	{ID: "network", Label: "Сеть", Sort: 20},
	// Default category for auto-discovered charts (CATALOG_AUTODISCOVER);
	// the admin moves them to the right one during moderation.
	{ID: "uncategorized", Label: "Без категории", Sort: 99},
}

// SeedPublications populates the base categories and the approved
// ingress-gateway publication if they do not exist yet. Idempotent: called on
// every start for both backends (Postgres and memory); existing records are
// left untouched, so admin edits survive a restart.
func SeedPublications(ctx context.Context, s Store) error {
	for _, c := range seedCategories {
		cat := c
		if err := s.CreateCategory(ctx, &cat); err != nil && !errors.Is(err, models.ErrConflict) {
			return err
		}
	}

	_, err := s.GetPublicationByChart(ctx, "platform", "ingress-gateway")
	if err == nil {
		return nil // already exists, do not overwrite
	}
	if !errors.Is(err, models.ErrNotFound) {
		return err
	}
	pub := &models.ChartPublication{
		ID:               uuid.Must(uuid.NewV7()).String(),
		ChartProject:     "platform",
		ChartName:        "ingress-gateway",
		CategoryID:       "network",
		OwnerTeam:        "core",
		CreatedBy:        "seed",
		CreatedByName:    "Seed",
		Status:           models.PubApproved,
		ViewJSON:         seedIngressView,
		ApprovedViewJSON: seedIngressView,
		// Snapshot of the approved version: catalog/profile show this data, not
		// the live one from Harbor. Approved at 3.2.0 (no icon) - a newer version
		// with an icon in Harbor is visible only in "Manage" as an available update.
		ApprovedViewVersion: "3.2.0",
		ApprovedDescription: "Helm chart for Istio-based ingress gateway (Gateway API, routes, NetworkPolicy, AuthorizationPolicy, OIDC)",
		ApprovedIconURL:     "",
	}
	if err := s.CreatePublication(ctx, pub); err != nil && !errors.Is(err, models.ErrConflict) {
		return err
	}
	return nil
}
