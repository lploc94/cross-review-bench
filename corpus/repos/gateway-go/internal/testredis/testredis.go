// Package testredis gives each test its own key space in the Redis database REDIS_URL names.
//
// go test runs packages in parallel against the same database, so tests never flush it: each
// test gets a random key prefix, the store writes under it, and the cleanup deletes exactly the
// keys under that prefix.
package testredis

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// New returns a client for REDIS_URL and a key prefix of the test's own, such as
// "test:3f9a0c2b7d14:". Without REDIS_URL the test is skipped. The keys under the prefix are
// deleted and the client closed when the test ends.
func New(t testing.TB) (*redis.Client, string) {
	t.Helper()
	url := os.Getenv("REDIS_URL")
	if url == "" {
		t.Skip("REDIS_URL is not set")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatalf("parse REDIS_URL: %v", err)
	}
	rdb := redis.NewClient(opts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		rdb.Close()
		t.Fatalf("connect to redis: %v", err)
	}
	var b [6]byte
	_, _ = rand.Read(b[:])
	prefix := "test:" + hex.EncodeToString(b[:]) + ":"
	t.Cleanup(func() {
		defer rdb.Close()
		if err := DeletePrefix(context.Background(), rdb, prefix); err != nil {
			t.Errorf("testredis: clean up %s: %v", prefix, err)
		}
	})
	return rdb, prefix
}

// DeletePrefix deletes every key that starts with prefix.
func DeletePrefix(ctx context.Context, rdb *redis.Client, prefix string) error {
	iter := rdb.Scan(ctx, 0, escapeGlob(prefix)+"*", 500).Iterator()
	var batch []string
	for iter.Next(ctx) {
		batch = append(batch, iter.Val())
		if len(batch) == 500 {
			if err := rdb.Unlink(ctx, batch...).Err(); err != nil {
				return err
			}
			batch = batch[:0]
		}
	}
	if err := iter.Err(); err != nil {
		return err
	}
	if len(batch) > 0 {
		return rdb.Unlink(ctx, batch...).Err()
	}
	return nil
}

// Keys returns the keys under prefix, for tests that check what the store wrote.
func Keys(ctx context.Context, rdb *redis.Client, prefix string) ([]string, error) {
	var keys []string
	iter := rdb.Scan(ctx, 0, escapeGlob(prefix)+"*", 500).Iterator()
	for iter.Next(ctx) {
		keys = append(keys, iter.Val())
	}
	return keys, iter.Err()
}

// escapeGlob escapes the characters SCAN MATCH treats as patterns.
func escapeGlob(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '*', '?', '[', ']', '\\':
			out = append(out, '\\')
		}
		out = append(out, s[i])
	}
	return string(out)
}
