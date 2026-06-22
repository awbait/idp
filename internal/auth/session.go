package auth

import (
	"context"
	"crypto/cipher"
	"encoding/json"
	"time"

	"console/internal/cache"
	"console/pkg/models"
	"github.com/google/uuid"
)

// Session is the server-side session stored in Redis (key session:<id>).
// The value is encrypted at rest with AES-256-GCM keyed from SESSION_SECRET
// (see seal.go), so OIDC tokens and the user profile are never written to the
// cache in plaintext.
type Session struct {
	User         *models.User `json:"user"`
	AccessToken  string       `json:"access_token,omitempty"`
	RefreshToken string       `json:"refresh_token,omitempty"`
	IDToken      string       `json:"id_token,omitempty"`
	Expiry       time.Time    `json:"expiry,omitempty"`
}

// SessionStore persists sessions in the cache backend, encrypting each value.
type SessionStore struct {
	cache cache.Cache
	ttl   time.Duration
	aead  cipher.AEAD
}

// NewSessionStore builds a session store that encrypts values with a key
// derived from secret. The AEAD setup cannot fail for the fixed-size derived
// key, so a failure here is a programming error and panics at wiring time.
func NewSessionStore(c cache.Cache, ttl time.Duration, secret string) *SessionStore {
	aead, err := newAEAD(secret)
	if err != nil {
		panic("auth: session cipher init: " + err.Error())
	}
	return &SessionStore{cache: c, ttl: ttl, aead: aead}
}

func sessionKey(id string) string { return "session:" + id }

// Create stores a new session and returns its id.
func (s *SessionStore) Create(ctx context.Context, sess *Session) (string, error) {
	id := uuid.NewString()
	b, err := s.marshal(sess)
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
	b, err := s.marshal(sess)
	if err != nil {
		return err
	}
	return s.cache.Set(ctx, sessionKey(id), b, s.ttl)
}

// Get loads a session by id. A value that fails to decrypt (tampered, sealed
// with a different SESSION_SECRET, or legacy plaintext) is treated as a missing
// session, so the caller falls back to a fresh login rather than erroring.
func (s *SessionStore) Get(ctx context.Context, id string) (*Session, error) {
	b, ok, err := s.cache.Get(ctx, sessionKey(id))
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, models.ErrNotFound
	}
	plain, err := open(s.aead, b)
	if err != nil {
		return nil, models.ErrNotFound
	}
	var sess Session
	if err := json.Unmarshal(plain, &sess); err != nil {
		return nil, models.ErrNotFound
	}
	return &sess, nil
}

// marshal serializes and encrypts a session for storage.
func (s *SessionStore) marshal(sess *Session) ([]byte, error) {
	b, err := json.Marshal(sess)
	if err != nil {
		return nil, err
	}
	return seal(s.aead, b)
}

// Delete removes a session.
func (s *SessionStore) Delete(ctx context.Context, id string) error {
	return s.cache.Delete(ctx, sessionKey(id))
}
