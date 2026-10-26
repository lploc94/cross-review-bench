// Package store keeps the gateway's shared state in Redis: consumers, their API keys and HMAC
// secrets, and the rate-limit counters. Every key starts with a configurable prefix, so several
// gateways (or test packages) can share one Redis database.
//
// Operations that touch several keys run as Lua scripts, so that they are atomic. Scripts
// derive some key names from their arguments, which needs a single Redis instance (or a
// primary with replicas), not Redis Cluster.
package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/relaywork/gateway/internal/clock"
)

// Store is the Redis-backed store. It is safe for concurrent use.
type Store struct {
	rdb    redis.UniversalClient
	prefix string
	clock  clock.Clock
}

// New returns a store that uses rdb and prefixes every key with prefix. Times it records, and
// the current time its scripts use, come from clk.
func New(rdb redis.UniversalClient, prefix string, clk clock.Clock) *Store {
	return &Store{rdb: rdb, prefix: prefix, clock: clk}
}

// Open connects to the Redis server at url and checks that it answers.
func Open(ctx context.Context, url string) (*redis.Client, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		// The details of a parse error quote parts of the URL, which may be the password.
		return nil, errInvalidRedisURL
	}
	rdb := redis.NewClient(opts)
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		rdb.Close()
		return nil, fmt.Errorf("connect to redis: %w", err)
	}
	return rdb, nil
}

// errInvalidRedisURL reports a REDIS_URL that cannot be parsed. It says nothing more, since
// any detail of the parse error may quote the password, and the error is logged.
var errInvalidRedisURL = errors.New("parse REDIS_URL: invalid URL")

// Ping checks that Redis answers.
func (s *Store) Ping(ctx context.Context) error {
	return s.rdb.Ping(ctx).Err()
}

// key joins parts into a key under the store's prefix.
func (s *Store) key(parts ...string) string {
	return s.prefix + strings.Join(parts, ":")
}

// Key names. Each function documents the type of the value stored under it.

// consumerKey is a hash: id, name, enabled ("1" or "0"), created_at, updated_at.
func (s *Store) consumerKey(id string) string { return s.key("consumer", id) }

// consumersKey is a sorted set of consumer ids scored by creation time.
func (s *Store) consumersKey() string { return s.key("consumers") }

// namesKey is a hash from lower-cased consumer name to consumer id; it keeps names unique.
func (s *Store) namesKey() string { return s.key("consumer-names") }

// consumerKeysKey is a set of the API key prefixes of a consumer.
func (s *Store) consumerKeysKey(id string) string { return s.key("consumer", id, "keys") }

// consumerHMACKey is a set of the HMAC key ids of a consumer.
func (s *Store) consumerHMACKey(id string) string { return s.key("consumer", id, "hmac") }

// apiKeyKey is a hash: consumer_id, hash (hex SHA-256), created_at, last_used_at, revoked_at.
func (s *Store) apiKeyKey(prefix string) string { return s.key("apikey", prefix) }

// hmacKey is a hash: consumer_id, secret, created_at, revoked_at.
func (s *Store) hmacKey(keyID string) string { return s.key("hmac", keyID) }

// rateLimitKey is a counter for one route, consumer and window.
func (s *Store) rateLimitKey(route, consumer string, windowStartMS int64) string {
	return s.key("rl", route, consumer, strconv.FormatInt(windowStartMS, 10))
}

// Times are stored as Unix milliseconds.

func formatTime(t time.Time) string { return strconv.FormatInt(t.UnixMilli(), 10) }

func parseTime(s string) (time.Time, error) {
	ms, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid stored time %q", s)
	}
	return time.UnixMilli(ms).UTC(), nil
}

// parseOptionalTime parses a time that may be absent ("").
func parseOptionalTime(s string) (*time.Time, error) {
	if s == "" {
		return nil, nil
	}
	t, err := parseTime(s)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// errCorrupt reports a stored record that cannot be decoded.
var errCorrupt = errors.New("corrupt record")

func corrupt(key string, err error) error {
	return fmt.Errorf("%w %s: %v", errCorrupt, key, err)
}

// scriptResult maps the status a write script returns to an error: 1 is success, 0 a conflict
// and -1 a missing record.
func scriptResult(n int64, notFound, conflict error) error {
	switch n {
	case 1:
		return nil
	case 0:
		return conflict
	case -1:
		return notFound
	}
	return fmt.Errorf("unexpected script result %d", n)
}
