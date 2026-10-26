package model

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"time"
)

// API keys look like "gk_<prefix>.<secret>": the 12-hex-digit prefix finds the stored record,
// and the secret, 32 random bytes in unpadded base64url, makes the key unguessable. Only the
// SHA-256 of the whole key is stored, so a leaked database does not leak usable keys.
const (
	apiKeyScheme      = "gk_"
	apiKeyPrefixLen   = 12
	apiKeySecretBytes = 32
	// MaxAPIKeyLength bounds what the gateway will parse as an API key.
	MaxAPIKeyLength = len(apiKeyScheme) + apiKeyPrefixLen + 1 + 43
)

// APIKey is the stored form of an API key. The key itself is shown once, when it is issued.
type APIKey struct {
	Prefix     string     `json:"prefix"`
	ConsumerID string     `json:"consumer_id"`
	Hash       [32]byte   `json:"-"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

// Active reports whether the key has not been revoked.
func (k APIKey) Active() bool { return k.RevokedAt == nil }

// TouchInterval is how stale an API key's last-used time may get: a key used more often is
// written at most once per interval.
const TouchInterval = time.Minute

// NewAPIKey generates a key and returns it with its lookup prefix and hash.
func NewAPIKey() (key, prefix string, hash [32]byte) {
	prefix = randomHex(apiKeyPrefixLen / 2)
	secret := make([]byte, apiKeySecretBytes)
	_, _ = rand.Read(secret)
	key = apiKeyScheme + prefix + "." + base64.RawURLEncoding.EncodeToString(secret)
	return key, prefix, HashAPIKey(key)
}

// ParseAPIKey returns the lookup prefix of a presented key, or false when the string cannot be
// a key this gateway issued.
func ParseAPIKey(key string) (prefix string, ok bool) {
	if len(key) != MaxAPIKeyLength {
		return "", false
	}
	rest, ok := strings.CutPrefix(key, apiKeyScheme)
	if !ok {
		return "", false
	}
	prefix, secret, ok := strings.Cut(rest, ".")
	if !ok || !isLowerHex(prefix, apiKeyPrefixLen) {
		return "", false
	}
	if _, err := base64.RawURLEncoding.DecodeString(secret); err != nil {
		return "", false
	}
	return prefix, true
}

// ValidKeyPrefix reports whether s has the shape of an API key prefix.
func ValidKeyPrefix(s string) bool { return isLowerHex(s, apiKeyPrefixLen) }

// HashAPIKey returns the SHA-256 of key, the form in which keys are stored.
func HashAPIKey(key string) [32]byte { return sha256.Sum256([]byte(key)) }

// HMAC credentials pair a public key id ("hk_" and 16 hex digits) with a secret: 32 random bytes
// in unpadded base64url. Clients use the secret's text, as shown, as the HMAC key. The gateway
// must know the secret to verify signatures, so it is stored as issued; like an API key, it is
// shown to the operator once.
const (
	hmacKeyIDScheme    = "hk_"
	hmacKeyIDHexLen    = 16
	hmacSecretBytes    = 32
	hmacKeyIDMaxLength = len(hmacKeyIDScheme) + hmacKeyIDHexLen
)

// HMACCredential is the stored form of an HMAC signing secret.
type HMACCredential struct {
	KeyID      string     `json:"key_id"`
	ConsumerID string     `json:"consumer_id"`
	Secret     string     `json:"-"`
	CreatedAt  time.Time  `json:"created_at"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

// Active reports whether the credential has not been revoked.
func (c HMACCredential) Active() bool { return c.RevokedAt == nil }

// NewHMACCredential generates a key id and a secret.
func NewHMACCredential() (keyID, secret string) {
	b := make([]byte, hmacSecretBytes)
	_, _ = rand.Read(b)
	return hmacKeyIDScheme + randomHex(hmacKeyIDHexLen/2), base64.RawURLEncoding.EncodeToString(b)
}

// ValidHMACKeyID reports whether id has the shape NewHMACCredential produces.
func ValidHMACKeyID(id string) bool {
	if len(id) != hmacKeyIDMaxLength {
		return false
	}
	rest, ok := strings.CutPrefix(id, hmacKeyIDScheme)
	return ok && isLowerHex(rest, hmacKeyIDHexLen)
}
