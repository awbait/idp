package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
)

// newAEAD derives an AES-256-GCM cipher from an arbitrary-length secret by
// hashing it to a fixed 32-byte key, so any SESSION_SECRET string is usable.
// It never fails for a 32-byte key, but returns the error for completeness.
func newAEAD(secret string) (cipher.AEAD, error) {
	key := sha256.Sum256([]byte(secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// seal encrypts plaintext and returns nonce||ciphertext (the random nonce is
// prepended so open can recover it).
func seal(aead cipher.AEAD, plaintext []byte) ([]byte, error) {
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, plaintext, nil), nil
}

// open reverses seal. It returns an error for any payload that does not
// authenticate under this key - tampered data, a value sealed with another
// key, or legacy plaintext written before encryption was enabled.
func open(aead cipher.AEAD, blob []byte) ([]byte, error) {
	ns := aead.NonceSize()
	if len(blob) < ns {
		return nil, errors.New("auth: session blob too short")
	}
	return aead.Open(nil, blob[:ns], blob[ns:], nil)
}
