package store

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/model"
	"github.com/relaywork/gateway/internal/testredis"
)

var t0 = time.Date(2025, time.June, 2, 12, 0, 0, 0, time.UTC)

type env struct {
	store  *Store
	rdb    *redis.Client
	clock  *clock.Manual
	prefix string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	rdb, prefix := testredis.New(t)
	clk := clock.NewManual(t0)
	return &env{store: New(rdb, prefix, clk), rdb: rdb, clock: clk, prefix: prefix}
}

func (e *env) consumer(t *testing.T, name string) model.Consumer {
	t.Helper()
	c, err := e.store.CreateConsumer(context.Background(), model.ConsumerInput{Name: name, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestConsumerCRUD(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	c := e.consumer(t, "billing")
	if !model.ValidConsumerID(c.ID) || !c.Enabled || !c.CreatedAt.Equal(t0) {
		t.Fatalf("created = %+v", c)
	}
	got, err := e.store.GetConsumer(ctx, c.ID)
	if err != nil || got != c {
		t.Fatalf("GetConsumer = %+v, %v; want %+v", got, err, c)
	}

	e.clock.Advance(time.Minute)
	name, off := "billing-v2", false
	upd, err := e.store.UpdateConsumer(ctx, c.ID, model.ConsumerPatch{Name: &name, Enabled: &off})
	if err != nil {
		t.Fatal(err)
	}
	if upd.Name != name || upd.Enabled || !upd.UpdatedAt.Equal(t0.Add(time.Minute)) || !upd.CreatedAt.Equal(t0) {
		t.Errorf("updated = %+v", upd)
	}
	// The old name is free again.
	e.consumer(t, "billing")

	if err := e.store.DeleteConsumer(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.GetConsumer(ctx, c.ID); !errors.Is(err, model.ErrNotFound) {
		t.Errorf("GetConsumer after delete: %v", err)
	}
	if err := e.store.DeleteConsumer(ctx, c.ID); !errors.Is(err, model.ErrNotFound) {
		t.Errorf("second delete: %v", err)
	}
	// The deleted consumer's name is free.
	e.consumer(t, "billing-v2")
}

func TestConsumerNamesAreUniqueIgnoringCase(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	a := e.consumer(t, "Orders")
	if _, err := e.store.CreateConsumer(ctx, model.ConsumerInput{Name: "orders"}); !errors.Is(err, model.ErrConflict) {
		t.Errorf("create with a taken name: %v", err)
	}
	b := e.consumer(t, "payments")
	taken := "ORDERS"
	if _, err := e.store.UpdateConsumer(ctx, b.ID, model.ConsumerPatch{Name: &taken}); !errors.Is(err, model.ErrConflict) {
		t.Errorf("rename to a taken name: %v", err)
	}
	if got, _ := e.store.GetConsumer(ctx, b.ID); got.Name != "payments" {
		t.Errorf("a failed rename changed the name to %q", got.Name)
	}
	// Changing only the case of one's own name is allowed.
	same := "ORDERS"
	if upd, err := e.store.UpdateConsumer(ctx, a.ID, model.ConsumerPatch{Name: &same}); err != nil || upd.Name != "ORDERS" {
		t.Errorf("recase own name: %+v, %v", upd, err)
	}
}

func TestConcurrentCreateWithSameNameHasOneWinner(t *testing.T) {
	e := newEnv(t)
	const racers = 16
	start := make(chan struct{})
	errs := make(chan error, racers)
	var wg sync.WaitGroup
	for range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := e.store.CreateConsumer(context.Background(), model.ConsumerInput{Name: "contested", Enabled: true})
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	won := 0
	for err := range errs {
		switch {
		case err == nil:
			won++
		case !errors.Is(err, model.ErrConflict):
			t.Errorf("unexpected error: %v", err)
		}
	}
	if won != 1 {
		t.Errorf("%d creates succeeded, want 1", won)
	}
	_, total, err := e.store.ListConsumers(context.Background(), 0, 0)
	if err != nil || total != 1 {
		t.Errorf("total = %d, %v", total, err)
	}
}

func TestListConsumersPages(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	var ids []string
	for _, n := range []string{"a", "b", "c", "d", "e"} {
		ids = append(ids, e.consumer(t, n).ID)
		e.clock.Advance(time.Second)
	}
	page, total, err := e.store.ListConsumers(ctx, 1, 3)
	if err != nil {
		t.Fatal(err)
	}
	if total != 5 || len(page) != 3 || page[0].ID != ids[1] || page[2].ID != ids[3] {
		t.Errorf("page = %v, total %d", page, total)
	}
	page, _, _ = e.store.ListConsumers(ctx, 4, 3)
	if len(page) != 1 || page[0].ID != ids[4] {
		t.Errorf("last page = %v", page)
	}
	if _, _, err := e.store.ListConsumers(ctx, 0, MaxPageSize+1); err == nil {
		t.Error("an oversized limit was accepted")
	}
}

func TestUpdateAndGetRejectUnknownConsumers(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	on := true
	for _, id := range []string{model.NewConsumerID(), "not-an-id"} {
		if _, err := e.store.GetConsumer(ctx, id); !errors.Is(err, model.ErrNotFound) {
			t.Errorf("GetConsumer(%q): %v", id, err)
		}
		if _, err := e.store.UpdateConsumer(ctx, id, model.ConsumerPatch{Enabled: &on}); !errors.Is(err, model.ErrNotFound) {
			t.Errorf("UpdateConsumer(%q): %v", id, err)
		}
	}
	if _, err := e.store.UpdateConsumer(ctx, model.NewConsumerID(), model.ConsumerPatch{}); err == nil {
		t.Error("an empty patch was accepted")
	}
	if _, err := e.store.CreateConsumer(ctx, model.ConsumerInput{Name: "bad name"}); err == nil {
		t.Error("an invalid name was accepted")
	}
}

func TestAPIKeyLifecycle(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	c := e.consumer(t, "svc")
	key, rec, err := e.store.IssueAPIKey(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	prefix, ok := model.ParseAPIKey(key)
	if !ok || prefix != rec.Prefix || rec.Hash != model.HashAPIKey(key) {
		t.Fatalf("issued %q with record %+v", key, rec)
	}
	stored, err := e.store.APIKey(ctx, prefix)
	if err != nil || stored.ConsumerID != c.ID || stored.Hash != rec.Hash || !stored.Active() || stored.LastUsedAt != nil {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
	// Only the hash is stored: the key's secret part appears in no stored value.
	secret := key[strings.Index(key, ".")+1:]
	keys, err := testredis.Keys(ctx, e.rdb, e.prefix)
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range keys {
		if e.rdb.Type(ctx, k).Val() != "hash" {
			continue
		}
		for field, v := range e.rdb.HGetAll(ctx, k).Val() {
			if strings.Contains(v, secret) {
				t.Errorf("%s %s holds the plaintext key", k, field)
			}
		}
	}

	list, err := e.store.ListAPIKeys(ctx, c.ID)
	if err != nil || len(list) != 1 || list[0].Prefix != prefix {
		t.Fatalf("ListAPIKeys = %v, %v", list, err)
	}

	e.clock.Advance(time.Hour)
	if err := e.store.RevokeAPIKey(ctx, c.ID, prefix); err != nil {
		t.Fatal(err)
	}
	stored, _ = e.store.APIKey(ctx, prefix)
	if stored.Active() || !stored.RevokedAt.Equal(t0.Add(time.Hour)) {
		t.Errorf("after revoke: %+v", stored)
	}
	if err := e.store.RevokeAPIKey(ctx, c.ID, prefix); !errors.Is(err, model.ErrConflict) {
		t.Errorf("second revoke: %v", err)
	}
}

func TestRevokeChecksOwnership(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	owner, other := e.consumer(t, "owner"), e.consumer(t, "other")
	_, rec, err := e.store.IssueAPIKey(ctx, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.store.RevokeAPIKey(ctx, other.ID, rec.Prefix); !errors.Is(err, model.ErrNotFound) {
		t.Errorf("revoke through another consumer: %v", err)
	}
	if k, _ := e.store.APIKey(ctx, rec.Prefix); !k.Active() {
		t.Error("another consumer revoked the key")
	}
	if err := e.store.RevokeAPIKey(ctx, owner.ID, "0123456789ab"); !errors.Is(err, model.ErrNotFound) {
		t.Errorf("revoke of an unknown prefix: %v", err)
	}
	if _, _, err := e.store.IssueAPIKey(ctx, model.NewConsumerID()); !errors.Is(err, model.ErrNotFound) {
		t.Errorf("issue for an unknown consumer: %v", err)
	}
}

func TestTouchAPIKeyIsThrottledAndNeverRecreates(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	c := e.consumer(t, "svc")
	_, rec, err := e.store.IssueAPIKey(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	lastUsed := func() *time.Time {
		k, err := e.store.APIKey(ctx, rec.Prefix)
		if err != nil {
			t.Fatal(err)
		}
		return k.LastUsedAt
	}
	if err := e.store.TouchAPIKey(ctx, rec.Prefix); err != nil {
		t.Fatal(err)
	}
	if lu := lastUsed(); lu == nil || !lu.Equal(t0) {
		t.Fatalf("last used = %v", lu)
	}
	e.clock.Advance(model.TouchInterval - time.Millisecond)
	_ = e.store.TouchAPIKey(ctx, rec.Prefix)
	if lu := lastUsed(); !lu.Equal(t0) {
		t.Errorf("touched again within the interval: %v", lu)
	}
	e.clock.Advance(time.Millisecond)
	_ = e.store.TouchAPIKey(ctx, rec.Prefix)
	if lu := lastUsed(); !lu.Equal(t0.Add(model.TouchInterval)) {
		t.Errorf("not touched after the interval: %v", lu)
	}

	if err := e.store.DeleteConsumer(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	e.clock.Advance(time.Hour)
	if err := e.store.TouchAPIKey(ctx, rec.Prefix); err != nil {
		t.Fatal(err)
	}
	if n := e.rdb.Exists(ctx, e.store.apiKeyKey(rec.Prefix)).Val(); n != 0 {
		t.Error("touching a deleted key recreated it")
	}
}

func TestDeleteConsumerRemovesCredentials(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	c := e.consumer(t, "svc")
	keep := e.consumer(t, "keep")
	_, rec, _ := e.store.IssueAPIKey(ctx, c.ID)
	cred, err := e.store.CreateHMACCredential(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, keptKey, _ := e.store.IssueAPIKey(ctx, keep.ID)

	if err := e.store.DeleteConsumer(ctx, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.APIKey(ctx, rec.Prefix); !errors.Is(err, model.ErrNotFound) {
		t.Errorf("API key survived its consumer: %v", err)
	}
	if _, err := e.store.HMACCredential(ctx, cred.KeyID); !errors.Is(err, model.ErrNotFound) {
		t.Errorf("HMAC secret survived its consumer: %v", err)
	}
	if _, err := e.store.APIKey(ctx, keptKey.Prefix); err != nil {
		t.Errorf("another consumer's key was deleted: %v", err)
	}
	keys, _ := testredis.Keys(ctx, e.rdb, e.prefix)
	for _, k := range keys {
		if strings.Contains(k, c.ID) {
			t.Errorf("key %s left behind", k)
		}
	}
}

func TestHMACCredentialLifecycle(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	c := e.consumer(t, "signer")
	cred, err := e.store.CreateHMACCredential(ctx, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !model.ValidHMACKeyID(cred.KeyID) || cred.Secret == "" || cred.ConsumerID != c.ID {
		t.Fatalf("created = %+v", cred)
	}
	got, err := e.store.HMACCredential(ctx, cred.KeyID)
	if err != nil || got.Secret != cred.Secret || !got.Active() {
		t.Fatalf("HMACCredential = %+v, %v", got, err)
	}
	list, err := e.store.ListHMACCredentials(ctx, c.ID)
	if err != nil || len(list) != 1 || list[0].Secret != "" {
		t.Fatalf("list = %+v, %v; secrets must not be listed", list, err)
	}
	if err := e.store.RevokeHMACCredential(ctx, c.ID, cred.KeyID); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.store.HMACCredential(ctx, cred.KeyID); got.Active() {
		t.Error("revoked credential is active")
	}
	if err := e.store.RevokeHMACCredential(ctx, c.ID, cred.KeyID); !errors.Is(err, model.ErrConflict) {
		t.Errorf("second revoke: %v", err)
	}
	if _, err := e.store.ListHMACCredentials(ctx, model.NewConsumerID()); !errors.Is(err, model.ErrNotFound) {
		t.Errorf("list for unknown consumer: %v", err)
	}
}

func TestPing(t *testing.T) {
	e := newEnv(t)
	if err := e.store.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// TestOpenErrorsDoNotLeakThePassword checks malformed URLs: the error is logged at startup, so
// it says only that the URL is invalid.
func TestOpenErrorsDoNotLeakThePassword(t *testing.T) {
	for _, raw := range []string{
		"redis://user:s3cretpw@[::1",
		"redis://:s3cretpw@host:port/0",
		"redis://:s3cretpw@host/notanumber",
		"rediss ://:s3cretpw@host",
		"redis://:s3cretpw@host/0?frobnicate=1",
		"redis://:pass/word@localhost:6379/0",
		"redis://:1234/S3cretRest@localhost:6379/0",
		"redis://:s3cret%zz@localhost:6379/0",
	} {
		_, err := Open(context.Background(), raw)
		if err == nil || err.Error() != "parse REDIS_URL: invalid URL" {
			t.Errorf("Open(%q) error %v", raw, err)
		}
	}
}
