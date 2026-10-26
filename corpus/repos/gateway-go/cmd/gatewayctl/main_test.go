package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/auth"
	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/model"
)

const token = "ctl-test-token-0123456789abcdef0123456"

// ctl runs gatewayctl with args against the admin API at adminURL.
func ctl(t *testing.T, adminURL string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	getenv := func(name string) string {
		switch name {
		case "GATEWAY_ADMIN_URL":
			return adminURL
		case "GATEWAY_ADMIN_TOKEN":
			return token
		}
		return ""
	}
	var out, errOut strings.Builder
	code = run(context.Background(), args, getenv, &out, &errOut)
	return code, out.String(), errOut.String()
}

// fakeAdmin answers admin API requests from a table of "METHOD path" to status and body.
func fakeAdmin(t *testing.T, replies replies) (url string, requests *[]string) {
	t.Helper()
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("request without the admin token: %v", r.Header)
		}
		b, _ := io.ReadAll(r.Body)
		key := r.Method + " " + r.URL.EscapedPath()
		parts := []string{key}
		for _, p := range []string{r.URL.RawQuery, string(b)} {
			if p != "" {
				parts = append(parts, p)
			}
		}
		seen = append(seen, strings.Join(parts, " "))
		reply, ok := replies[key]
		if !ok {
			reply.status, reply.body = 404, `{"error":{"code":"not_found","message":"no such admin endpoint"}}`
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(reply.status)
		io.WriteString(w, reply.body)
	}))
	t.Cleanup(srv.Close)
	return srv.URL, &seen
}

// replies maps "METHOD escaped-path" to the status and body the fake admin API answers with.
type replies map[string]struct {
	status int
	body   string
}

func TestUsage(t *testing.T) {
	if code, _, stderr := ctl(t, ""); code != 2 || !strings.Contains(stderr, "usage: gatewayctl") {
		t.Errorf("no command: code %d", code)
	}
	if code, _, _ := ctl(t, "", "help"); code != 0 {
		t.Errorf("help: code %d", code)
	}
	if code, _, stderr := ctl(t, "", "frobnicate"); code != 2 || !strings.Contains(stderr, `unknown command "frobnicate"`) {
		t.Errorf("unknown command: code %d, %s", code, stderr)
	}
	if code, _, stderr := ctl(t, "", "consumer"); code != 2 || !strings.Contains(stderr, "takes 1 argument(s), got 0") {
		t.Errorf("missing argument: code %d, %s", code, stderr)
	}
	if code, _, _ := ctl(t, "", "consumers", "-bogus"); code != 2 {
		t.Errorf("unknown flag: code %d", code)
	}
}

func TestTokenIsRequired(t *testing.T) {
	var out, errOut strings.Builder
	code := run(context.Background(), []string{"routes"}, func(string) string { return "" }, &out, &errOut)
	if code != 2 || !strings.Contains(errOut.String(), "GATEWAY_ADMIN_TOKEN is required") {
		t.Errorf("code %d, %s", code, errOut.String())
	}
}

func TestConsumersTableAndPaging(t *testing.T) {
	url, seen := fakeAdmin(t, replies{
		"GET /admin/v1/consumers": {200, `{"consumers":[{"id":"c_0123456789abcdef","name":"billing","enabled":true,"created_at":"2025-06-02T12:00:00Z"}],"total":3,"offset":1,"limit":1}`},
	})
	code, stdout, stderr := ctl(t, url, "consumers", "-offset", "1", "-limit", "1")
	if code != 0 {
		t.Fatalf("code %d, %s", code, stderr)
	}
	if !strings.Contains(stdout, "c_0123456789abcdef  billing  true") || !strings.Contains(stderr, "2 of 3 consumers shown; next page: -offset 2") {
		t.Errorf("stdout:\n%s\nstderr:\n%s", stdout, stderr)
	}
	if (*seen)[0] != "GET /admin/v1/consumers limit=1&offset=1" {
		t.Errorf("request %q", (*seen)[0])
	}
}

func TestConsumerUpdateFlags(t *testing.T) {
	url, seen := fakeAdmin(t, replies{
		"PATCH /admin/v1/consumers/c_1": {200, `{"id":"c_1","name":"","enabled":false}`},
	})
	if code, _, _ := ctl(t, url, "consumer-update", "c_1"); code != 2 {
		t.Errorf("nothing to change: code %d", code)
	}
	if code, _, _ := ctl(t, url, "consumer-update", "-enable", "-disable", "c_1"); code != 2 {
		t.Errorf("-enable with -disable: code %d", code)
	}
	if code, _, stderr := ctl(t, url, "consumer-update", "-disable", "c_1"); code != 0 {
		t.Fatalf("code %d, %s", code, stderr)
	}
	if code, _, _ := ctl(t, url, "consumer-update", "-name", "", "c_1"); code != 0 {
		t.Fatalf("an explicit empty name is sent for the API to reject")
	}
	want := []string{`PATCH /admin/v1/consumers/c_1 {"enabled":false}`, `PATCH /admin/v1/consumers/c_1 {"name":""}`}
	if len(*seen) != 2 || (*seen)[0] != want[0] || (*seen)[1] != want[1] {
		t.Errorf("requests %q", *seen)
	}
}

func TestKeyIssuePrintsOnlyTheKeyOnStdout(t *testing.T) {
	url, _ := fakeAdmin(t, replies{
		"POST /admin/v1/consumers/c_1/keys": {201, `{"key":"gk_0123456789ab.secretpart","api_key":{"prefix":"0123456789ab","consumer_id":"c_1"}}`},
	})
	code, stdout, stderr := ctl(t, url, "key-issue", "c_1")
	if code != 0 || stdout != "gk_0123456789ab.secretpart\n" || !strings.Contains(stderr, "shown only now") {
		t.Errorf("code %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}

func TestAPIErrorsExitOne(t *testing.T) {
	url, _ := fakeAdmin(t, replies{
		"POST /admin/v1/consumers": {409, `{"error":{"code":"conflict","message":"consumer name \"billing\" is taken"}}`},
	})
	code, _, stderr := ctl(t, url, "consumer-create", "billing")
	if code != 1 || !strings.Contains(stderr, "409 conflict") {
		t.Errorf("code %d, stderr %q", code, stderr)
	}
	if code, _, stderr := ctl(t, url, "consumer-delete", "c_gone"); code != 1 || !strings.Contains(stderr, "404 not_found") {
		t.Errorf("code %d, stderr %q", code, stderr)
	}
}

func TestSign(t *testing.T) {
	dir := t.TempDir()
	bodyFile := filepath.Join(dir, "body.json")
	if err := os.WriteFile(bodyFile, []byte(`{"amount":10}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// sign is offline: it needs neither the admin URL nor the token.
	var out, errOut strings.Builder
	code := run(context.Background(), []string{"sign", "-key-id", "hk_0123456789abcdef", "-secret", "s3cret",
		"-method", "post", "-path", "/orders/a%2Fb", "-query", "b=2&a=1", "-body-file", bodyFile, "-timestamp", "1700000000"},
		func(string) string { return "" }, &out, &errOut)
	if code != 0 {
		t.Fatalf("code %d, %s", code, errOut.String())
	}
	sig, _ := auth.Sign("s3cret", "POST", "/orders/a%2Fb", "b=2&a=1", 1700000000, []byte(`{"amount":10}`))
	if want := "Authorization: " + auth.AuthorizationHeader("hk_0123456789abcdef", sig, 1700000000) + "\n"; out.String() != want {
		t.Errorf("output %q, want %q", out.String(), want)
	}

	for _, args := range [][]string{
		{"sign", "-secret", "s", "-path", "/x"},
		{"sign", "-key-id", "hk_0123456789abcdef", "-secret", "s", "-path", "x"},
		{"sign", "-key-id", "hk_0123456789abcdef", "-secret", "s", "-path", "/x?a=1"},
	} {
		if code, _, _ := ctl(t, "", args...); code == 0 {
			t.Errorf("%q succeeded", args)
		}
	}
}

// oneSecret is a credential store holding one enabled consumer with one HMAC secret.
type oneSecret struct{ keyID, secret string }

func (s oneSecret) APIKey(context.Context, string) (model.APIKey, error) {
	return model.APIKey{}, model.ErrNotFound
}
func (s oneSecret) TouchAPIKey(context.Context, string) error { return nil }
func (s oneSecret) HMACCredential(_ context.Context, keyID string) (model.HMACCredential, error) {
	if keyID != s.keyID {
		return model.HMACCredential{}, model.ErrNotFound
	}
	return model.HMACCredential{KeyID: keyID, ConsumerID: "c_0123456789abcdef", Secret: s.secret}, nil
}
func (s oneSecret) GetConsumer(_ context.Context, id string) (model.Consumer, error) {
	return model.Consumer{ID: id, Name: "svc", Enabled: true}, nil
}

// TestSignedRequestsAuthenticate checks that what sign prints is accepted by the gateway for the
// request sent exactly as given to sign.
func TestSignedRequestsAuthenticate(t *testing.T) {
	const keyID, secret = "hk_0123456789abcdef", "s3cret"
	ts := time.Now().Unix()
	authn := &auth.HMACAuthenticator{Store: oneSecret{keyID, secret}, Clock: clock.Real{}, MaxSkew: time.Minute}
	for _, c := range []struct{ method, path, query string }{
		{"GET", "/orders/{x}", ""},
		{"get", "/orders", ""}, // signed as GET, which clients send
		{"DELETE", "/a|b/c%2Fd", "q={1}&p=a+b"},
	} {
		code, stdout, stderr := ctl(t, "", "sign", "-key-id", keyID, "-secret", secret, "-method", c.method,
			"-path", c.path, "-query", c.query, "-timestamp", strconv.FormatInt(ts, 10))
		if code != 0 {
			t.Fatalf("sign: code %d, %s", code, stderr)
		}
		target := c.path
		if c.query != "" {
			target += "?" + c.query
		}
		r := httptest.NewRequest(strings.ToUpper(c.method), target, nil)
		r.Header.Set("Authorization", strings.TrimSpace(strings.TrimPrefix(stdout, "Authorization: ")))
		if _, err := authn.Authenticate(r.Context(), r, nil); err != nil {
			t.Errorf("%s %s: %v", c.method, target, err)
		}
	}
}
