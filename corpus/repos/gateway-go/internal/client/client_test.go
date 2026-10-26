package client

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/api"
	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/config"
	"github.com/relaywork/gateway/internal/core"
	"github.com/relaywork/gateway/internal/logging"
	"github.com/relaywork/gateway/internal/model"
	"github.com/relaywork/gateway/internal/store"
	"github.com/relaywork/gateway/internal/testredis"
)

const token = "client-test-token-0123456789abcdef01"

func TestNewValidatesArguments(t *testing.T) {
	for _, base := range []string{"", "127.0.0.1:9090", "ftp://host", "http://", "::"} {
		if _, err := New(base, token, nil); err == nil {
			t.Errorf("New(%q) accepted", base)
		}
	}
	if _, err := New("http://127.0.0.1:9090", "", nil); err == nil {
		t.Error("New accepted an empty token")
	}
}

// recorder is an admin API stand-in that records the request and answers with status and body.
func recorder(t *testing.T, status int, body string, seen *http.Request, seenBody *string) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = *r.Clone(context.Background())
		b, _ := io.ReadAll(r.Body)
		*seenBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	c, err := New(srv.URL+"/gw/", token, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestRequestShape(t *testing.T) {
	var seen http.Request
	var body string
	c := recorder(t, 200, `{"id":"c_0123456789abcdef","name":"n","enabled":false}`, &seen, &body)
	name, off := "n", false
	got, err := c.UpdateConsumer(context.Background(), "odd/id ?", &name, &off)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "c_0123456789abcdef" || got.Enabled {
		t.Errorf("decoded %+v", got)
	}
	if seen.Method != "PATCH" || seen.URL.EscapedPath() != "/gw/admin/v1/consumers/odd%2Fid%20%3F" {
		t.Errorf("%s %s", seen.Method, seen.URL.EscapedPath())
	}
	if seen.Header.Get("Authorization") != "Bearer "+token || seen.Header.Get("Content-Type") != "application/json" {
		t.Errorf("header %v", seen.Header)
	}
	if body != `{"enabled":false,"name":"n"}` {
		t.Errorf("body %s", body)
	}

	if _, err := c.ListConsumers(context.Background(), 20, 10); err != nil {
		t.Fatal(err)
	}
	if seen.URL.RawQuery != "limit=10&offset=20" || body != "" {
		t.Errorf("query %q, body %q", seen.URL.RawQuery, body)
	}
}

func TestErrorResponses(t *testing.T) {
	var seen http.Request
	var body string
	c := recorder(t, 422, `{"error":{"code":"validation_failed","message":"the request is invalid","fields":[{"field":"name","message":"must not be empty"}],"request_id":"r1"}}`, &seen, &body)
	_, err := c.CreateConsumer(context.Background(), "", true)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 422 || apiErr.Code != "validation_failed" || apiErr.RequestID != "r1" {
		t.Fatalf("err = %#v", err)
	}
	if !strings.Contains(err.Error(), "name: must not be empty") {
		t.Errorf("Error() = %q", err)
	}

	c = recorder(t, 404, `{"error":{"code":"not_found","message":"consumer c_1: not found"}}`, &seen, &body)
	if err := c.DeleteConsumer(context.Background(), "c_1"); !errors.Is(err, model.ErrNotFound) || errors.Is(err, model.ErrConflict) {
		t.Errorf("404: %v", err)
	}
	c = recorder(t, 502, `<html>bad gateway</html>`, &seen, &body)
	if err := c.DeleteConsumer(context.Background(), "c_1"); !errors.As(err, &apiErr) || apiErr.Code != "http_error" || apiErr.Status != 502 {
		t.Errorf("non-JSON error: %v", err)
	}
	c = recorder(t, 200, `not json`, &seen, &body)
	if _, err := c.GetConsumer(context.Background(), "c_1"); err == nil || !strings.Contains(err.Error(), "decode response") {
		t.Errorf("bad body: %v", err)
	}
}

// TestAgainstAdminAPI runs the client against the real admin API and store.
func TestAgainstAdminAPI(t *testing.T) {
	rdb, prefix := testredis.New(t)
	clk := clock.NewManual(time.Date(2025, time.June, 2, 12, 0, 0, 0, time.UTC))
	rt, err := core.NewRuntime(core.RuntimeOptions{Clock: clk, Logger: logging.Discard()})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	routes, err := config.ParseRoutes([]byte(`{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://a.internal"}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Apply(routes); err != nil {
		t.Fatal(err)
	}
	srv, err := api.New(api.Options{
		Store: store.New(rdb, prefix, clk), Routes: rt, AdminToken: token,
		Reload: func() error { return nil }, Clock: clk, Logger: logging.Discard(),
	})
	if err != nil {
		t.Fatal(err)
	}
	hs := httptest.NewServer(srv)
	defer hs.Close()
	c, err := New(hs.URL, token, hs.Client())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	cons, err := c.CreateConsumer(ctx, "mobile", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.CreateConsumer(ctx, "Mobile", true); !errors.Is(err, model.ErrConflict) {
		t.Errorf("duplicate: %v", err)
	}
	key, err := c.IssueKey(ctx, cons.ID)
	if err != nil || key.Key == "" || key.APIKey.ConsumerID != cons.ID {
		t.Fatalf("IssueKey = %+v, %v", key, err)
	}
	keys, err := c.ListKeys(ctx, cons.ID)
	if err != nil || len(keys) != 1 || keys[0].Prefix != key.APIKey.Prefix {
		t.Errorf("ListKeys = %+v, %v", keys, err)
	}
	if err := c.RevokeKey(ctx, cons.ID, key.APIKey.Prefix); err != nil {
		t.Error(err)
	}
	secret, err := c.CreateHMACSecret(ctx, cons.ID)
	if err != nil || secret.Secret == "" {
		t.Fatalf("CreateHMACSecret = %+v, %v", secret, err)
	}
	secrets, err := c.ListHMACSecrets(ctx, cons.ID)
	if err != nil || len(secrets) != 1 || secrets[0].Secret != "" {
		t.Errorf("ListHMACSecrets = %+v, %v", secrets, err)
	}
	if err := c.RevokeHMACSecret(ctx, cons.ID, secret.KeyID); err != nil {
		t.Error(err)
	}
	page, err := c.ListConsumers(ctx, 0, 0)
	if err != nil || page.Total != 1 || page.Limit != 100 {
		t.Errorf("ListConsumers = %+v, %v", page, err)
	}
	rs, err := c.Routes(ctx)
	if err != nil || len(rs) != 1 || !strings.Contains(string(rs[0]), `"id":"a"`) {
		t.Errorf("Routes = %s, %v", rs, err)
	}
	if n, err := c.ReloadRoutes(ctx); err != nil || n != 1 {
		t.Errorf("ReloadRoutes = %d, %v", n, err)
	}
	if err := c.DeleteConsumer(ctx, cons.ID); err != nil {
		t.Error(err)
	}
	if _, err := c.GetConsumer(ctx, cons.ID); !errors.Is(err, model.ErrNotFound) {
		t.Errorf("after delete: %v", err)
	}
	bad, _ := New(hs.URL, "wrong-token", hs.Client())
	var apiErr *APIError
	if _, err := bad.Routes(ctx); !errors.As(err, &apiErr) || apiErr.Status != 401 {
		t.Errorf("wrong token: %v", err)
	}
}
