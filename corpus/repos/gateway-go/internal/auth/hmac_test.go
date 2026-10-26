package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/model"
)

func TestCanonicalString(t *testing.T) {
	got, err := CanonicalString("POST", "/orders/a%2Fb", "z=1&a=2&a=1&sp=a+b&tilde=~&star=*", 1700000000, []byte(`{"x":1}`))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(`{"x":1}`))
	want := "POST\n/orders/a%2Fb\na=1&a=2&sp=a%20b&star=%2A&tilde=~&z=1\n1700000000\n" + hex.EncodeToString(sum[:])
	if got != want {
		t.Errorf("canonical:\n%q\nwant:\n%q", got, want)
	}
}

func TestCanonicalQueryIsIndependentOfOrderAndEncoding(t *testing.T) {
	a, _ := CanonicalString("GET", "/", "b=%41&a=x%20y", 1, nil)
	b, _ := CanonicalString("GET", "/", "a=x+y&b=A", 1, nil)
	if a != b {
		t.Errorf("equivalent queries canonicalise differently:\n%q\n%q", a, b)
	}
	c, _ := CanonicalString("GET", "/", "a=x+y&b=B", 1, nil)
	if a == c {
		t.Error("different values canonicalise alike")
	}
	if _, err := CanonicalString("GET", "/", "a=%zz", 1, nil); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("unparsable query: %v", err)
	}
	empty, _ := CanonicalString("GET", "/", "", 1, nil)
	if !strings.Contains(empty, "GET\n/\n\n1\n") {
		t.Errorf("empty query: %q", empty)
	}
}

func TestCanonicalStringSeparatesFields(t *testing.T) {
	// A path and query that would run together without the separators must not collide.
	a, _ := CanonicalString("GET", "/a", "b=c", 1, nil)
	b, _ := CanonicalString("GET", "/a\nb=c", "", 1, nil)
	if a == b {
		t.Error("path and query are not separated")
	}
}

func TestParseHMACAuthorization(t *testing.T) {
	sig := strings.Repeat("ab", 32)
	p, err := ParseHMACAuthorization(`hmac timestamp=1700000000, Key_ID="hk_0123456789abcdef",signature=` + sig)
	if err != nil {
		t.Fatal(err)
	}
	if p.KeyID != "hk_0123456789abcdef" || p.Timestamp != 1700000000 || hex.EncodeToString(p.Signature) != sig {
		t.Errorf("params = %+v", p)
	}
	for _, bad := range []string{
		"Bearer x",
		"HMAC",
		"HMAC key_id=hk_0123456789abcdef, signature=" + sig,
		"HMAC key_id=hk_0123456789abcdef, signature=" + sig + ", timestamp=1, timestamp=2",
		"HMAC key_id=hk_0123456789abcdef, signature=" + sig[:62] + ", timestamp=1",
		"HMAC key_id=hk_0123456789abcdef, signature=" + strings.Repeat("zz", 32) + ", timestamp=1",
		"HMAC key_id=hk_0123456789abcdef, signature=" + sig + ", timestamp=-5",
		"HMAC key_id=nope, signature=" + sig + ", timestamp=1",
		"HMAC key_id=hk_0123456789abcdef, signature=" + sig + ", timestamp=1, nonce=3",
		"HMAC key_id=hk_0123456789abcdef; signature=" + sig + "; timestamp=1",
	} {
		if _, err := ParseHMACAuthorization(bad); !errors.Is(err, ErrInvalidCredentials) {
			t.Errorf("ParseHMACAuthorization(%q) = %v", bad, err)
		}
	}
}

type hmacFixture struct {
	store *fakeStore
	cred  model.HMACCredential
	auth  *HMACAuthenticator
	clock *clock.Manual
}

func newHMACFixture() *hmacFixture {
	store := newFakeStore()
	c := store.addConsumer("signer", true)
	clk := clock.NewManual(t0)
	return &hmacFixture{
		store: store,
		cred:  store.addHMAC(c.ID),
		auth:  &HMACAuthenticator{Store: store, Clock: clk, MaxSkew: 5 * time.Minute},
		clock: clk,
	}
}

// signed builds a request for target signed at ts with the fixture's credential, the way a
// client signs: over the method, path and query exactly as it sends them.
func (f *hmacFixture) signed(t *testing.T, method, target string, body []byte, ts time.Time) *http.Request {
	t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(string(body)))
	path, query, _ := strings.Cut(target, "?")
	sig, err := Sign(f.cred.Secret, method, path, query, ts.Unix(), body)
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", AuthorizationHeader(f.cred.KeyID, sig, ts.Unix()))
	return r
}

func TestHMACAuthenticates(t *testing.T) {
	f := newHMACFixture()
	body := []byte(`{"amount":10}`)
	r := f.signed(t, "POST", "/pay/a%2Fb?b=2&a=1", body, t0)
	c, err := f.auth.Authenticate(r.Context(), r, body)
	if err != nil || c.ID != f.cred.ConsumerID {
		t.Fatalf("Authenticate = %+v, %v", c, err)
	}
}

func TestHMACRejectsTampering(t *testing.T) {
	f := newHMACFixture()
	body := []byte(`{"amount":10}`)
	cases := map[string]func(r *http.Request) (*http.Request, []byte){
		"body changed": func(r *http.Request) (*http.Request, []byte) { return r, []byte(`{"amount":1000}`) },
		"method changed": func(r *http.Request) (*http.Request, []byte) {
			r.Method = "PUT"
			return r, body
		},
		"path changed": func(r *http.Request) (*http.Request, []byte) {
			r.URL.Path = "/pay/other"
			return r, body
		},
		"query added": func(r *http.Request) (*http.Request, []byte) {
			r.URL.RawQuery = "a=1&b=2&admin=true"
			return r, body
		},
		"signature of another key": func(r *http.Request) (*http.Request, []byte) {
			other := f.store.addHMAC(f.cred.ConsumerID)
			r.Header.Set("Authorization", strings.Replace(r.Header.Get("Authorization"), f.cred.KeyID, other.KeyID, 1))
			return r, body
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			r, b := mutate(f.signed(t, "POST", "/pay/a%2Fb?b=2&a=1", body, t0))
			if _, err := f.auth.Authenticate(r.Context(), r, b); !errors.Is(err, ErrInvalidCredentials) {
				t.Errorf("err = %v, want invalid credentials", err)
			}
		})
	}
}

func TestHMACClockSkew(t *testing.T) {
	f := newHMACFixture()
	for _, c := range []struct {
		signedAt time.Time
		ok       bool
	}{
		{t0.Add(-5 * time.Minute), true},
		{t0.Add(5 * time.Minute), true},
		{t0.Add(-5*time.Minute - time.Second), false},
		{t0.Add(5*time.Minute + time.Second), false},
	} {
		r := f.signed(t, "GET", "/x", nil, c.signedAt)
		_, err := f.auth.Authenticate(r.Context(), r, nil)
		switch {
		case c.ok && err != nil:
			t.Errorf("signed at %s: %v", c.signedAt.Sub(t0), err)
		case !c.ok && !errors.Is(err, ErrStaleSignature):
			t.Errorf("signed at %s: err = %v, want stale", c.signedAt.Sub(t0), err)
		}
	}
}

func TestHMACRevokedAndDisabled(t *testing.T) {
	f := newHMACFixture()
	at := t0
	cred := f.store.hmac[f.cred.KeyID]
	cred.RevokedAt = &at
	f.store.hmac[f.cred.KeyID] = cred
	r := f.signed(t, "GET", "/x", nil, t0)
	if _, err := f.auth.Authenticate(r.Context(), r, nil); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("revoked: %v", err)
	}

	g := newHMACFixture()
	c := g.store.consumers[g.cred.ConsumerID]
	c.Enabled = false
	g.store.consumers[c.ID] = c
	r = g.signed(t, "GET", "/x", nil, t0)
	if _, err := g.auth.Authenticate(r.Context(), r, nil); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("disabled consumer: %v", err)
	}
}

func TestHMACMissingOrDuplicateHeader(t *testing.T) {
	f := newHMACFixture()
	r := httptest.NewRequest("GET", "/x", nil)
	if _, err := f.auth.Authenticate(r.Context(), r, nil); !errors.Is(err, ErrMissingCredentials) {
		t.Errorf("no header: %v", err)
	}
	r = f.signed(t, "GET", "/x", nil, t0)
	r.Header.Add("Authorization", r.Header.Get("Authorization"))
	if _, err := f.auth.Authenticate(r.Context(), r, nil); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("two headers: %v", err)
	}
}

func TestSignMatchesHMACSHA256(t *testing.T) {
	sig, err := Sign("secret", "GET", "/x", "", 42, nil)
	if err != nil {
		t.Fatal(err)
	}
	canonical, _ := CanonicalString("GET", "/x", "", 42, nil)
	m := hmac.New(sha256.New, []byte("secret"))
	m.Write([]byte(canonical))
	if want := hex.EncodeToString(m.Sum(nil)); sig != want {
		t.Errorf("Sign = %s, want %s", sig, want)
	}
}

// TestHMACSignsThePathAsSent checks paths whose bytes Go would escape differently than the
// client sent them: the signature covers the request line, not Go's re-encoding of it.
func TestHMACSignsThePathAsSent(t *testing.T) {
	f := newHMACFixture()
	for _, target := range []string{"/orders/{x}", "/a|b?q={1}", "/caf%C3%A9/x%2Fy", "/plain"} {
		r := f.signed(t, "GET", target, nil, t0)
		if _, err := f.auth.Authenticate(r.Context(), r, nil); err != nil {
			t.Errorf("%s: %v", target, err)
		}
	}
}

// TestHMACMethodIsSignedAsSent checks that a signature for GET does not authenticate a request
// sent as "get": methods are case-sensitive and Go keeps them as sent.
func TestHMACMethodIsSignedAsSent(t *testing.T) {
	f := newHMACFixture()
	r := f.signed(t, "GET", "/x", nil, t0)
	r.Method = "get"
	if _, err := f.auth.Authenticate(r.Context(), r, nil); !errors.Is(err, ErrInvalidCredentials) {
		t.Errorf("err = %v, want invalid credentials", err)
	}
	r = f.signed(t, "get", "/x", nil, t0)
	if _, err := f.auth.Authenticate(r.Context(), r, nil); err != nil {
		t.Errorf("signed and sent as get: %v", err)
	}
}
