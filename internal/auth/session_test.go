package auth

import (
	"context"
	"testing"
	"time"

	"idp/internal/cache"
	"idp/pkg/models"
)

func TestSessionStoreSaveRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := NewSessionStore(cache.NewMemory(), time.Hour)

	id, err := store.Create(ctx, &Session{
		User:         &models.User{Username: "alice"},
		RefreshToken: "rt-old",
		Expiry:       time.Unix(1000, 0),
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Simulate a silent refresh persisting rotated tokens in place.
	sess, err := store.Get(ctx, id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	sess.AccessToken = "at-new"
	sess.RefreshToken = "rt-new"
	sess.Expiry = time.Unix(2000, 0)
	if err := store.Save(ctx, id, sess); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := store.Get(ctx, id)
	if err != nil {
		t.Fatalf("Get after Save: %v", err)
	}
	if got.AccessToken != "at-new" || got.RefreshToken != "rt-new" {
		t.Errorf("tokens not persisted: access=%q refresh=%q", got.AccessToken, got.RefreshToken)
	}
	if !got.Expiry.Equal(time.Unix(2000, 0)) {
		t.Errorf("expiry not persisted: %v", got.Expiry)
	}
	if got.User == nil || got.User.Username != "alice" {
		t.Errorf("user not preserved: %+v", got.User)
	}
}
