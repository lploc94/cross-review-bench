package auth

import (
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/logging"
	"github.com/relaywork/gateway/internal/model"
)

func newAPIKeyAuth(store *fakeStore) (*APIKeyAuthenticator, *clock.Manual) {
	clk := clock.NewManual(t0)
	return &APIKeyAuthenticator{Store: store, Clock: clk, Logger: logging.Discard()}, clk
}

func TestAPIKeyAuthenticates(t *testing.T) {
	store := newFakeStore()
	c := store.addConsumer("svc", true)
	key := store.issueKey(c.ID)
	a, _ := newAPIKeyAuth(store)

	for _, set := range []func(h map[string][]string){
		func(h map[string][]string) { h["Authorization"] = []string{"Bearer " + key} },
		func(h map[string][]string) { h["Authorization"] = []string{"bearer  " + key + " "} },
		func(h map[string][]string) { h["X-Api-Key"] = []string{key} },
	} {
		r := httptest.NewRequest("GET", "/x", nil)
		set(r.Header)
		got, err := a.Authenticate(r.Context(), r, nil)
		if err != nil || got.ID != c.ID {
			t.Errorf("Authenticate = %+v, %v", got, err)
		}
	}
}

func TestAPIKeyRejections(t *testing.T) {
	store := newFakeStore()
	c := store.addConsumer("svc", true)
	key := store.issueKey(c.ID)
	disabled := store.addConsumer("off", false)
	disabledKey := store.issueKey(disabled.ID)
	revokedKey := store.issueKey(c.ID)
	revokedPrefix, _ := model.ParseAPIKey(revokedKey)
	store.revokeKey(revokedPrefix)
	orphan := store.issueKey(model.NewConsumerID())
	// Same prefix, different secret: found by prefix, rejected by the hash comparison.
	forged := key[:strings.Index(key, ".")+1] + strings.Repeat("A", len(key)-strings.Index(key, ".")-1)
	unknown, _, _ := model.NewAPIKey()

	cases := []struct {
		name    string
		headers map[string]string
		want    error
	}{
		{"no credentials", nil, ErrMissingCredentials},
		{"empty X-Api-Key", map[string]string{"X-Api-Key": " "}, ErrMissingCredentials},
		{"wrong scheme", map[string]string{"Authorization": "Basic " + key}, ErrInvalidCredentials},
		{"malformed", map[string]string{"X-Api-Key": "not-a-key"}, ErrInvalidCredentials},
		{"unknown prefix", map[string]string{"X-Api-Key": unknown}, ErrInvalidCredentials},
		{"forged secret", map[string]string{"X-Api-Key": forged}, ErrInvalidCredentials},
		{"revoked", map[string]string{"X-Api-Key": revokedKey}, ErrInvalidCredentials},
		{"disabled consumer", map[string]string{"X-Api-Key": disabledKey}, ErrInvalidCredentials},
		{"deleted consumer", map[string]string{"X-Api-Key": orphan}, ErrInvalidCredentials},
		{"both headers", map[string]string{"X-Api-Key": key, "Authorization": "Bearer " + key}, ErrInvalidCredentials},
	}
	a, _ := newAPIKeyAuth(store)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/x", nil)
			for k, v := range tc.headers {
				r.Header.Set(k, v)
			}
			_, err := a.Authenticate(r.Context(), r, nil)
			if !errors.Is(err, tc.want) {
				t.Errorf("err = %v, want %v", err, tc.want)
			}
			if !IsAuthError(err) {
				t.Errorf("IsAuthError(%v) = false", err)
			}
			if err != nil && strings.Contains(err.Error(), key[16:]) {
				t.Error("the error text contains the key's secret")
			}
		})
	}
}

func TestAPIKeyStoreFailureIsNotAnAuthVerdict(t *testing.T) {
	store := newFakeStore()
	key := store.issueKey(store.addConsumer("svc", true).ID)
	store.failWith = errRedisDown
	a, _ := newAPIKeyAuth(store)
	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("X-Api-Key", key)
	_, err := a.Authenticate(r.Context(), r, nil)
	if !errors.Is(err, errRedisDown) || IsAuthError(err) {
		t.Errorf("err = %v; a store failure must not look like bad credentials", err)
	}
}

func TestAPIKeyTouchIsThrottled(t *testing.T) {
	store := newFakeStore()
	key := store.issueKey(store.addConsumer("svc", true).ID)
	a, clk := newAPIKeyAuth(store)
	auth := func() {
		r := httptest.NewRequest("GET", "/x", nil)
		r.Header.Set("X-Api-Key", key)
		if _, err := a.Authenticate(r.Context(), r, nil); err != nil {
			t.Fatal(err)
		}
	}
	auth() // never used: touch
	auth() // used just now: no touch
	clk.Advance(model.TouchInterval)
	auth() // stale: touch
	if store.touches != 2 {
		t.Errorf("touches = %d, want 2", store.touches)
	}
}

func TestStripHeaders(t *testing.T) {
	a, _ := newAPIKeyAuth(newFakeStore())
	if got := a.StripHeaders(); len(got) != 2 || got[0] != "Authorization" || got[1] != "X-Api-Key" {
		t.Errorf("api key StripHeaders = %v", got)
	}
	if a.NeedsBody() {
		t.Error("API keys do not need the body")
	}
	h := &HMACAuthenticator{}
	if got := h.StripHeaders(); len(got) != 1 || got[0] != "Authorization" || !h.NeedsBody() {
		t.Errorf("hmac StripHeaders = %v, NeedsBody = %v", got, h.NeedsBody())
	}
}
