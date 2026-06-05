package store

import (
	"context"
	_ "embed"
	"errors"

	"idp/pkg/models"
	"github.com/google/uuid"
)

// Канонический view-документ ingress-gateway (бывший
// web/public/schemas/ingress-gateway.ui.json), сидируется как approved-публикация.
//
//go:embed seed/ingress-gateway.view.json
var seedIngressView []byte

// seedCategories — стартовый список категорий каталога; дальше управляется
// админом через API.
var seedCategories = []models.Category{
	{ID: "databases", Label: "Базы данных", Sort: 10},
	{ID: "network", Label: "Сеть", Sort: 20},
}

// SeedPublications заполняет базовые категории и approved-публикацию
// ingress-gateway, если их ещё нет. Идемпотентен: вызывается на каждом старте
// для обоих бэкендов (Postgres и memory); существующие записи не трогает,
// поэтому правки админа переживают рестарт.
func SeedPublications(ctx context.Context, s Store) error {
	for _, c := range seedCategories {
		cat := c
		if err := s.CreateCategory(ctx, &cat); err != nil && !errors.Is(err, models.ErrConflict) {
			return err
		}
	}

	_, err := s.GetPublicationByChart(ctx, "platform", "ingress-gateway")
	if err == nil {
		return nil // уже есть — не перезаписываем
	}
	if !errors.Is(err, models.ErrNotFound) {
		return err
	}
	pub := &models.ChartPublication{
		ID:            uuid.Must(uuid.NewV7()).String(),
		ChartProject:  "platform",
		ChartName:     "ingress-gateway",
		CategoryID:    "network",
		OwnerTeam:     "core",
		CreatedBy:     "seed",
		CreatedByName: "Seed",
		Status:        models.PubApproved,
		ViewJSON:      seedIngressView,
		ApprovedViewJSON: seedIngressView,
	}
	if err := s.CreatePublication(ctx, pub); err != nil && !errors.Is(err, models.ErrConflict) {
		return err
	}
	return nil
}
