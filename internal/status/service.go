// Package status exposes a read-only view of ArgoCD applications and runs the
// background poller that advances order states.
package status

import (
	"context"

	"console/internal/argocd"
	"console/pkg/models"
)

// Service is the read-only ArgoCD view for the /applications endpoints.
type Service struct {
	argo argocd.Port
}

// New builds a status service.
func New(argo argocd.Port) *Service { return &Service{argo: argo} }

const labelManagedBy = "managed-by"
const labelTeam = "idp.team"

// ListApplications returns portal-managed apps visible to the user.
func (s *Service) ListApplications(ctx context.Context, u *models.User) ([]argocd.Application, error) {
	apps, err := s.argo.ListApplications(ctx, map[string]string{labelManagedBy: "portal"})
	if err != nil {
		return nil, err
	}
	if u.IsAdmin() || u.IsSupport() {
		return apps, nil
	}
	out := make([]argocd.Application, 0, len(apps))
	for _, a := range apps {
		if u.InTeam(a.Labels[labelTeam]) {
			out = append(out, a)
		}
	}
	return out, nil
}

// GetApplication returns one app if the user may see it.
func (s *Service) GetApplication(ctx context.Context, u *models.User, name string) (*argocd.Application, error) {
	a, err := s.argo.GetApplication(ctx, name)
	if err != nil {
		return nil, err
	}
	if !u.IsAdmin() && !u.IsSupport() && !u.InTeam(a.Labels[labelTeam]) {
		return nil, models.ErrNotFound // hide existence from other teams
	}
	return a, nil
}
