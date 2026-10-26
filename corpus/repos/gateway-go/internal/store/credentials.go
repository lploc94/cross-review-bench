package store

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/relaywork/gateway/internal/model"
)

// maxCollisionRetries bounds the attempts at a fresh random prefix or key id when a generated
// one is taken. With 48 random bits a single collision is already very unlikely.
const maxCollisionRetries = 5

// addCredentialScript stores a new API key or HMAC secret for an existing consumer.
// KEYS: credential, consumer, consumer's credential set. ARGV: member name for the set, then
// field/value pairs.
var addCredentialScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[2]) == 0 then
  return -1
end
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
redis.call('SADD', KEYS[3], ARGV[1])
return 1
`)

// revokeScript marks a credential of the given consumer revoked.
// KEYS: credential. ARGV: consumer id, now.
var revokeScript = redis.NewScript(`
if redis.call('HGET', KEYS[1], 'consumer_id') ~= ARGV[1] then
  return -1
end
if redis.call('HEXISTS', KEYS[1], 'revoked_at') == 1 then
  return 0
end
redis.call('HSET', KEYS[1], 'revoked_at', ARGV[2])
return 1
`)

// touchScript records a key's use unless it was recorded less than ARGV[2] ms ago. It never
// recreates a key deleted in the meantime.
// KEYS: API key. ARGV: now, interval.
var touchScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
local last = tonumber(redis.call('HGET', KEYS[1], 'last_used_at') or '0')
if tonumber(ARGV[1]) - last < tonumber(ARGV[2]) then
  return 0
end
redis.call('HSET', KEYS[1], 'last_used_at', ARGV[1])
return 1
`)

// IssueAPIKey creates an API key for the consumer with id. The returned key is the only copy
// of the plaintext; the store keeps its hash.
func (s *Store) IssueAPIKey(ctx context.Context, consumerID string) (key string, rec model.APIKey, err error) {
	if !model.ValidConsumerID(consumerID) {
		return "", model.APIKey{}, consumerNotFound(consumerID)
	}
	now := s.clock.Now().UTC().Truncate(time.Millisecond)
	for range maxCollisionRetries {
		key, prefix, hash := model.NewAPIKey()
		n, err := addCredentialScript.Run(ctx, s.rdb,
			[]string{s.apiKeyKey(prefix), s.consumerKey(consumerID), s.consumerKeysKey(consumerID)},
			prefix, "consumer_id", consumerID, "hash", hex.EncodeToString(hash[:]), "created_at", formatTime(now)).Int64()
		if err != nil {
			return "", model.APIKey{}, fmt.Errorf("issue API key: %w", err)
		}
		if n == 0 {
			continue // prefix taken; draw another
		}
		if err := scriptResult(n, consumerNotFound(consumerID), nil); err != nil {
			return "", model.APIKey{}, err
		}
		return key, model.APIKey{Prefix: prefix, ConsumerID: consumerID, Hash: hash, CreatedAt: now}, nil
	}
	return "", model.APIKey{}, errors.New("issue API key: no free prefix found")
}

// APIKey returns the stored key with prefix, or model.ErrNotFound.
func (s *Store) APIKey(ctx context.Context, prefix string) (model.APIKey, error) {
	if !model.ValidKeyPrefix(prefix) {
		return model.APIKey{}, keyNotFound(prefix)
	}
	key := s.apiKeyKey(prefix)
	h, err := s.rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return model.APIKey{}, fmt.Errorf("get API key: %w", err)
	}
	if len(h) == 0 {
		return model.APIKey{}, keyNotFound(prefix)
	}
	return decodeAPIKey(key, prefix, h)
}

func keyNotFound(prefix string) error {
	return fmt.Errorf("API key %q: %w", prefix, model.ErrNotFound)
}

// ListAPIKeys returns the keys of a consumer, oldest first, revoked ones included.
func (s *Store) ListAPIKeys(ctx context.Context, consumerID string) ([]model.APIKey, error) {
	if _, err := s.GetConsumer(ctx, consumerID); err != nil {
		return nil, err
	}
	prefixes, err := s.rdb.SMembers(ctx, s.consumerKeysKey(consumerID)).Result()
	if err != nil {
		return nil, fmt.Errorf("list API keys: %w", err)
	}
	hashes, err := s.getAll(ctx, prefixes, s.apiKeyKey)
	if err != nil {
		return nil, fmt.Errorf("list API keys: %w", err)
	}
	keys := make([]model.APIKey, 0, len(prefixes))
	for i, h := range hashes {
		if len(h) == 0 {
			continue
		}
		k, err := decodeAPIKey(s.apiKeyKey(prefixes[i]), prefixes[i], h)
		if err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b model.APIKey) int {
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.Prefix, b.Prefix)
	})
	return keys, nil
}

// RevokeAPIKey revokes the consumer's key with prefix. Revoking a revoked key is a conflict.
func (s *Store) RevokeAPIKey(ctx context.Context, consumerID, prefix string) error {
	if !model.ValidKeyPrefix(prefix) {
		return keyNotFound(prefix)
	}
	n, err := revokeScript.Run(ctx, s.rdb, []string{s.apiKeyKey(prefix)}, consumerID, formatTime(s.clock.Now())).Int64()
	if err != nil {
		return fmt.Errorf("revoke API key: %w", err)
	}
	return scriptResult(n, keyNotFound(prefix), fmt.Errorf("%w: API key %q is already revoked", model.ErrConflict, prefix))
}

// TouchAPIKey records that the key with prefix was used now. Writes are throttled to one per
// model.TouchInterval per key.
func (s *Store) TouchAPIKey(ctx context.Context, prefix string) error {
	err := touchScript.Run(ctx, s.rdb, []string{s.apiKeyKey(prefix)},
		formatTime(s.clock.Now()), model.TouchInterval.Milliseconds()).Err()
	if err != nil {
		return fmt.Errorf("touch API key: %w", err)
	}
	return nil
}

func decodeAPIKey(key, prefix string, h map[string]string) (model.APIKey, error) {
	k := model.APIKey{Prefix: prefix, ConsumerID: h["consumer_id"]}
	raw, err := hex.DecodeString(h["hash"])
	if err != nil || len(raw) != len(k.Hash) {
		return model.APIKey{}, corrupt(key, errors.New("invalid hash"))
	}
	copy(k.Hash[:], raw)
	if k.CreatedAt, err = parseTime(h["created_at"]); err != nil {
		return model.APIKey{}, corrupt(key, err)
	}
	if k.LastUsedAt, err = parseOptionalTime(h["last_used_at"]); err != nil {
		return model.APIKey{}, corrupt(key, err)
	}
	if k.RevokedAt, err = parseOptionalTime(h["revoked_at"]); err != nil {
		return model.APIKey{}, corrupt(key, err)
	}
	if k.ConsumerID == "" {
		return model.APIKey{}, corrupt(key, errors.New("missing consumer_id"))
	}
	return k, nil
}

// CreateHMACCredential creates an HMAC signing secret for the consumer with id. The returned
// credential carries the secret, which is shown to the operator once.
func (s *Store) CreateHMACCredential(ctx context.Context, consumerID string) (model.HMACCredential, error) {
	if !model.ValidConsumerID(consumerID) {
		return model.HMACCredential{}, consumerNotFound(consumerID)
	}
	now := s.clock.Now().UTC().Truncate(time.Millisecond)
	for range maxCollisionRetries {
		keyID, secret := model.NewHMACCredential()
		n, err := addCredentialScript.Run(ctx, s.rdb,
			[]string{s.hmacKey(keyID), s.consumerKey(consumerID), s.consumerHMACKey(consumerID)},
			keyID, "consumer_id", consumerID, "secret", secret, "created_at", formatTime(now)).Int64()
		if err != nil {
			return model.HMACCredential{}, fmt.Errorf("create HMAC secret: %w", err)
		}
		if n == 0 {
			continue
		}
		if err := scriptResult(n, consumerNotFound(consumerID), nil); err != nil {
			return model.HMACCredential{}, err
		}
		return model.HMACCredential{KeyID: keyID, ConsumerID: consumerID, Secret: secret, CreatedAt: now}, nil
	}
	return model.HMACCredential{}, errors.New("create HMAC secret: no free key id found")
}

// HMACCredential returns the credential with keyID, secret included, or model.ErrNotFound.
func (s *Store) HMACCredential(ctx context.Context, keyID string) (model.HMACCredential, error) {
	if !model.ValidHMACKeyID(keyID) {
		return model.HMACCredential{}, hmacNotFound(keyID)
	}
	key := s.hmacKey(keyID)
	h, err := s.rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return model.HMACCredential{}, fmt.Errorf("get HMAC secret: %w", err)
	}
	if len(h) == 0 {
		return model.HMACCredential{}, hmacNotFound(keyID)
	}
	return decodeHMAC(key, keyID, h)
}

func hmacNotFound(keyID string) error {
	return fmt.Errorf("HMAC key %q: %w", keyID, model.ErrNotFound)
}

// ListHMACCredentials returns the HMAC credentials of a consumer, oldest first, without their
// secrets.
func (s *Store) ListHMACCredentials(ctx context.Context, consumerID string) ([]model.HMACCredential, error) {
	if _, err := s.GetConsumer(ctx, consumerID); err != nil {
		return nil, err
	}
	ids, err := s.rdb.SMembers(ctx, s.consumerHMACKey(consumerID)).Result()
	if err != nil {
		return nil, fmt.Errorf("list HMAC secrets: %w", err)
	}
	hashes, err := s.getAll(ctx, ids, s.hmacKey)
	if err != nil {
		return nil, fmt.Errorf("list HMAC secrets: %w", err)
	}
	creds := make([]model.HMACCredential, 0, len(ids))
	for i, h := range hashes {
		if len(h) == 0 {
			continue
		}
		c, err := decodeHMAC(s.hmacKey(ids[i]), ids[i], h)
		if err != nil {
			return nil, err
		}
		c.Secret = ""
		creds = append(creds, c)
	}
	slices.SortFunc(creds, func(a, b model.HMACCredential) int {
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.KeyID, b.KeyID)
	})
	return creds, nil
}

// RevokeHMACCredential revokes the consumer's HMAC credential with keyID.
func (s *Store) RevokeHMACCredential(ctx context.Context, consumerID, keyID string) error {
	if !model.ValidHMACKeyID(keyID) {
		return hmacNotFound(keyID)
	}
	n, err := revokeScript.Run(ctx, s.rdb, []string{s.hmacKey(keyID)}, consumerID, formatTime(s.clock.Now())).Int64()
	if err != nil {
		return fmt.Errorf("revoke HMAC secret: %w", err)
	}
	return scriptResult(n, hmacNotFound(keyID), fmt.Errorf("%w: HMAC key %q is already revoked", model.ErrConflict, keyID))
}

func decodeHMAC(key, keyID string, h map[string]string) (model.HMACCredential, error) {
	c := model.HMACCredential{KeyID: keyID, ConsumerID: h["consumer_id"], Secret: h["secret"]}
	var err error
	if c.CreatedAt, err = parseTime(h["created_at"]); err != nil {
		return model.HMACCredential{}, corrupt(key, err)
	}
	if c.RevokedAt, err = parseOptionalTime(h["revoked_at"]); err != nil {
		return model.HMACCredential{}, corrupt(key, err)
	}
	if c.ConsumerID == "" || c.Secret == "" {
		return model.HMACCredential{}, corrupt(key, errors.New("missing consumer_id or secret"))
	}
	return c, nil
}

// getAll fetches the hashes of ids in one round trip.
func (s *Store) getAll(ctx context.Context, ids []string, keyOf func(string) string) ([]map[string]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.MapStringStringCmd, len(ids))
	for i, id := range ids {
		cmds[i] = pipe.HGetAll(ctx, keyOf(id))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}
	out := make([]map[string]string, len(ids))
	for i, cmd := range cmds {
		out[i] = cmd.Val()
	}
	return out, nil
}
