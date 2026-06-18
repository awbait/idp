package auth

import (
	"context"

	"console/pkg/models"
)

type ctxKey int

const userKey ctxKey = 0

// WithUser stores the authenticated user in the context.
func WithUser(ctx context.Context, u *models.User) context.Context {
	return context.WithValue(ctx, userKey, u)
}

// UserFrom returns the authenticated user, or nil if unauthenticated.
func UserFrom(ctx context.Context) *models.User {
	u, _ := ctx.Value(userKey).(*models.User)
	return u
}
