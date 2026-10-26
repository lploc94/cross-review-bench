package auth

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/relaywork/gateway/internal/model"
)

var t0 = time.Date(2025, time.June, 2, 12, 0, 0, 0, time.UTC)

// fakeStore is an in-memory CredentialStore.
type fakeStore struct {
	mu        sync.Mutex
	consumers map[string]model.Consumer
	keys      map[string]model.APIKey
	hmac      map[string]model.HMACCredential
	touches   int
	failWith  error // returned by every call when set
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		consumers: make(map[string]model.Consumer),
		keys:      make(map[string]model.APIKey),
		hmac:      make(map[string]model.HMACCredential),
	}
}

func (f *fakeStore) addConsumer(name string, enabled bool) model.Consumer {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := model.Consumer{ID: model.NewConsumerID(), Name: name, Enabled: enabled, CreatedAt: t0, UpdatedAt: t0}
	f.consumers[c.ID] = c
	return c
}

func (f *fakeStore) issueKey(consumerID string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	key, prefix, hash := model.NewAPIKey()
	f.keys[prefix] = model.APIKey{Prefix: prefix, ConsumerID: consumerID, Hash: hash, CreatedAt: t0}
	return key
}

func (f *fakeStore) addHMAC(consumerID string) model.HMACCredential {
	f.mu.Lock()
	defer f.mu.Unlock()
	id, secret := model.NewHMACCredential()
	c := model.HMACCredential{KeyID: id, ConsumerID: consumerID, Secret: secret, CreatedAt: t0}
	f.hmac[id] = c
	return c
}

func (f *fakeStore) APIKey(_ context.Context, prefix string) (model.APIKey, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failWith != nil {
		return model.APIKey{}, f.failWith
	}
	k, ok := f.keys[prefix]
	if !ok {
		return model.APIKey{}, fmt.Errorf("key %s: %w", prefix, model.ErrNotFound)
	}
	return k, nil
}

func (f *fakeStore) TouchAPIKey(_ context.Context, prefix string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touches++
	k := f.keys[prefix]
	now := t0
	k.LastUsedAt = &now
	f.keys[prefix] = k
	return nil
}

func (f *fakeStore) HMACCredential(_ context.Context, keyID string) (model.HMACCredential, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failWith != nil {
		return model.HMACCredential{}, f.failWith
	}
	c, ok := f.hmac[keyID]
	if !ok {
		return model.HMACCredential{}, fmt.Errorf("hmac %s: %w", keyID, model.ErrNotFound)
	}
	return c, nil
}

func (f *fakeStore) GetConsumer(_ context.Context, id string) (model.Consumer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failWith != nil {
		return model.Consumer{}, f.failWith
	}
	c, ok := f.consumers[id]
	if !ok {
		return model.Consumer{}, fmt.Errorf("consumer %s: %w", id, model.ErrNotFound)
	}
	return c, nil
}

func (f *fakeStore) revokeKey(prefix string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := f.keys[prefix]
	at := t0
	k.RevokedAt = &at
	f.keys[prefix] = k
}

var errRedisDown = errors.New("dial tcp: connection refused")
