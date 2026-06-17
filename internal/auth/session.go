package auth

import (
	"context"
	"encoding/json"
	"time"

	"idp/internal/cache"
	"idp/pkg/models"
	"github.com/google/uuid"
)

// Session is the server-side session stored in Redis (key session:<id>).
// In production the value should be encrypted with SESSION_SECRET; the
// skeleton stores plain JSON (TODO: wrap with secretbox/AES-GCM).
type Session struct {
	User         *models.User `json:"user"`
	AccessToken  string       `json:"access_token,omitempty"`
	RefreshToken string       `json:"refresh_token,omitempty"`
	IDToken      string       `json:"id_token,omitempty"`
	Expiry       time.Time    `json:"expiry,omitempty"`
}

// SessionStore persists sessions in the cache backend.
type SessionStore struct {
	cache cache.Cache
	ttl   time.Duration
}

// NewSessionStore builds a session store.
func NewSessionStore(c cache.Cache, ttl time.Duration) *SessionStore {
	return &SessionStore{cache: c, ttl: ttl}
}

func sessionKey(id string) string { return "session:" + id }

// Create stores a new session and returns its id.
func (s *SessionStore) Create(ctx context.Context, sess *Session) (string, error) {
	id := uuid.NewString()
	b, err := json.Marshal(sess)
	if err != nil {
		return "", err
	}
	if err := s.cache.Set(ctx, sessionKey(id), b, s.ttl); err != nil {
		return "", err
	}
	return id, nil
}

// Save overwrites an existing session in place and refreshes its TTL. Used to
// persist silently-refreshed tokens (and extend the session lifetime) without
// minting a new id.
func (s *SessionStore) Save(ctx context.Context, id string, sess *Session) error {
	b, err := json.Marshal(sess)
	if err != nil {
		return err
	}
	return s.cache.Set(ctx, sessionKey(id), b, s.ttl)
}

// Get loads a session by id.
func (s *SessionStore) Get(ctx context.Context, id string) (*Session, error) {
	b, ok, err := s.cache.Get(ctx, sessionKey(id))
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, models.ErrNotFound
	}
	var sess Session
	if err := json.Unmarshal(b, &sess); err != nil {
		return nil, err
	}
	return &sess, nil
}

// Delete removes a session.
func (s *SessionStore) Delete(ctx context.Context, id string) error {
	return s.cache.Delete(ctx, sessionKey(id))
}
