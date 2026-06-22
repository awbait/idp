package auth

import (
	"bytes"
	"context"
	"testing"
	"time"

	"console/internal/cache"
	"console/pkg/models"
)

func TestSessionStoreSaveRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := NewSessionStore(cache.NewMemory(), time.Hour, "unit-test-secret")

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

func TestSessionStoreEncryptsAtRest(t *testing.T) {
	ctx := context.Background()
	c := cache.NewMemory()
	store := NewSessionStore(c, time.Hour, "unit-test-secret")

	id, err := store.Create(ctx, &Session{
		User:        &models.User{Username: "alice"},
		AccessToken: "super-secret-access-token",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	raw, ok, err := c.Get(ctx, sessionKey(id))
	if err != nil || !ok {
		t.Fatalf("raw get: ok=%v err=%v", ok, err)
	}
	// The stored blob must not leak the token or username in plaintext.
	for _, leak := range [][]byte{[]byte("super-secret-access-token"), []byte("alice"), []byte("access_token")} {
		if bytes.Contains(raw, leak) {
			t.Fatalf("session stored in plaintext, leaks %q", leak)
		}
	}
}

func TestSessionStoreRejectsForeignAndPlaintext(t *testing.T) {
	ctx := context.Background()
	c := cache.NewMemory()
	store := NewSessionStore(c, time.Hour, "the-real-secret")

	id, err := store.Create(ctx, &Session{User: &models.User{Username: "alice"}})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// A store with a different secret cannot decrypt the value -> missing session.
	other := NewSessionStore(c, time.Hour, "a-different-secret")
	if _, err := other.Get(ctx, id); err != models.ErrNotFound {
		t.Fatalf("foreign-key Get: want ErrNotFound, got %v", err)
	}

	// Legacy/tampered plaintext does not authenticate -> missing session.
	_ = c.Set(ctx, sessionKey("legacy"), []byte(`{"user":{"username":"mallory"}}`), time.Hour)
	if _, err := store.Get(ctx, "legacy"); err != models.ErrNotFound {
		t.Fatalf("plaintext Get: want ErrNotFound, got %v", err)
	}
}
