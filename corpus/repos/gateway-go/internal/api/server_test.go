package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/config"
	"github.com/relaywork/gateway/internal/core"
	"github.com/relaywork/gateway/internal/logging"
	"github.com/relaywork/gateway/internal/metrics"
	"github.com/relaywork/gateway/internal/store"
	"github.com/relaywork/gateway/internal/testredis"
)

const token = "test-admin-token-0123456789abcdef0123"

var t0 = time.Date(2025, time.June, 2, 12, 0, 0, 0, time.UTC)

const twoRoutes = `{"routes":[
  {"id":"orders","path_prefix":"/orders","upstreams":[{"url":"http://orders.internal"}]},
  {"id":"users","path":"/users","methods":["GET"],"upstreams":[{"url":"http://users-a.internal","weight":3},{"url":"http://users-b.internal"}],
   "circuit_breaker":{}}]}`

// pingStore is a Store whose Ping fails with err. Its other methods are not implemented; a
// test that reaches one panics, which the server turns into a 500.
type pingStore struct {
	Store
	err error
}

func (s pingStore) Ping(context.Context) error { return s.err }

type testServer struct {
	*httptest.Server
	rt  *core.Runtime
	reg *metrics.Registry
}

type serverOptions struct {
	store  Store
	routes string
	reload func() error
}

func newServer(t *testing.T, o serverOptions) *testServer {
	t.Helper()
	rt, err := core.NewRuntime(core.RuntimeOptions{Clock: clock.NewManual(t0), Logger: logging.Discard()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)
	if o.routes != "" {
		routes, err := config.ParseRoutes([]byte(o.routes))
		if err != nil {
			t.Fatal(err)
		}
		if err := rt.Apply(routes); err != nil {
			t.Fatal(err)
		}
	}
	if o.store == nil {
		o.store = pingStore{}
	}
	reg := metrics.NewRegistry()
	s, err := New(Options{Store: o.store, Routes: rt, AdminToken: token, Reload: o.reload, Clock: clock.NewManual(t0), Logger: logging.Discard(), Metrics: reg})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return &testServer{Server: srv, rt: rt, reg: reg}
}

// redisServer is a server over a real store in the test's own Redis key space.
func redisServer(t *testing.T) *testServer {
	t.Helper()
	rdb, prefix := testredis.New(t)
	return newServer(t, serverOptions{store: store.New(rdb, prefix, clock.NewManual(t0)), routes: twoRoutes})
}

type response struct {
	status int
	header http.Header
	body   []byte
}

// call sends a request with the admin token unless the headers set Authorization themselves.
func (s *testServer) call(t *testing.T, method, path, body string, headers ...string) response {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, s.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(headers); i += 2 {
		if headers[i+1] == "" {
			req.Header.Del(headers[i])
			continue
		}
		req.Header.Add(headers[i], headers[i+1])
	}
	resp, err := s.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response{status: resp.StatusCode, header: resp.Header, body: b}
}

func (r response) decode(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		t.Fatalf("decode %s: %v", r.body, err)
	}
}

func (r response) errorCode(t *testing.T) string {
	t.Helper()
	var e errorBody
	r.decode(t, &e)
	if e.Error.RequestID == "" || e.Error.RequestID != r.header.Get("X-Request-Id") {
		t.Errorf("error request_id %q, header %q", e.Error.RequestID, r.header.Get("X-Request-Id"))
	}
	return e.Error.Code
}

func TestNewValidatesOptions(t *testing.T) {
	rt, _ := core.NewRuntime(core.RuntimeOptions{Clock: clock.Real{}, Logger: logging.Discard()})
	defer rt.Close()
	if _, err := New(Options{Store: pingStore{}, Routes: rt, Clock: clock.Real{}, Logger: logging.Discard()}); err == nil {
		t.Error("New accepted an empty admin token")
	}
	if _, err := New(Options{AdminToken: token}); err == nil {
		t.Error("New accepted missing dependencies")
	}
}

func TestAdminTokenIsRequired(t *testing.T) {
	s := newServer(t, serverOptions{routes: twoRoutes})
	for _, c := range []struct {
		name   string
		values []string
	}{
		{"none", nil},
		{"wrong token", []string{"Bearer " + token + "x"}},
		{"token prefix", []string{"Bearer " + token[:20]}},
		{"basic scheme", []string{"Basic " + token}},
		{"empty bearer", []string{"Bearer "}},
		{"two headers", []string{"Bearer " + token, "Bearer " + token}},
	} {
		headers := []string{"Authorization", ""}
		for _, v := range c.values {
			headers = append(headers, "Authorization", v)
		}
		r := s.call(t, "GET", "/admin/v1/routes", "", headers...)
		if r.status != 401 || r.errorCode(t) != "unauthorized" || !strings.HasPrefix(r.header.Get("WWW-Authenticate"), "Bearer") {
			t.Errorf("%s: status %d, body %s", c.name, r.status, r.body)
		}
	}
	if r := s.call(t, "GET", "/admin/v1/routes", "", "Authorization", "", "Authorization", "bearer  "+token+" "); r.status != 200 {
		t.Errorf("valid token: status %d", r.status)
	}
	for _, path := range []string{"/healthz", "/readyz", "/metrics"} {
		if r := s.call(t, "GET", path, "", "Authorization", ""); r.status != 200 {
			t.Errorf("%s without a token: status %d", path, r.status)
		}
	}
}

func TestUnknownEndpointsAnswerJSON(t *testing.T) {
	s := newServer(t, serverOptions{routes: twoRoutes})
	r := s.call(t, "GET", "/admin/v1/nothing", "")
	if r.status != 404 || r.errorCode(t) != "not_found" {
		t.Errorf("404: status %d, body %s", r.status, r.body)
	}
	r = s.call(t, "DELETE", "/admin/v1/routes", "")
	if r.status != 405 || r.errorCode(t) != "method_not_allowed" || !strings.Contains(r.header.Get("Allow"), "GET") {
		t.Errorf("405: status %d, Allow %q, body %s", r.status, r.header.Get("Allow"), r.body)
	}
}

func TestRoutes(t *testing.T) {
	s := newServer(t, serverOptions{routes: twoRoutes})
	var list struct {
		Routes []struct {
			ID             string                `json:"id"`
			UpstreamStatus []core.UpstreamStatus `json:"upstream_status"`
		} `json:"routes"`
	}
	r := s.call(t, "GET", "/admin/v1/routes", "")
	r.decode(t, &list)
	if r.status != 200 || len(list.Routes) != 2 {
		t.Fatalf("status %d, body %s", r.status, r.body)
	}

	var one struct {
		ID             string                `json:"id"`
		Path           string                `json:"path"`
		Timeout        string                `json:"timeout"`
		UpstreamStatus []core.UpstreamStatus `json:"upstream_status"`
	}
	r = s.call(t, "GET", "/admin/v1/routes/users", "")
	r.decode(t, &one)
	if one.ID != "users" || one.Path != "/users" || one.Timeout != "30s" || len(one.UpstreamStatus) != 2 {
		t.Errorf("route = %+v", one)
	}
	if u := one.UpstreamStatus[0]; u.URL != "http://users-a.internal" || u.Weight != 3 || !u.Healthy || u.Breaker != "closed" {
		t.Errorf("upstream status = %+v", u)
	}
	if r := s.call(t, "GET", "/admin/v1/routes/none", ""); r.status != 404 || r.errorCode(t) != "not_found" {
		t.Errorf("unknown route: status %d", r.status)
	}
}

func TestReloadRoutes(t *testing.T) {
	if r := newServer(t, serverOptions{}).call(t, "POST", "/admin/v1/routes/reload", ""); r.status != 501 || r.errorCode(t) != "not_implemented" {
		t.Errorf("reload disabled: status %d", r.status)
	}

	var next error
	reloads := 0
	s := newServer(t, serverOptions{routes: twoRoutes, reload: func() error { reloads++; return next }})
	r := s.call(t, "POST", "/admin/v1/routes/reload", "")
	var ok struct{ Routes int }
	r.decode(t, &ok)
	if r.status != 200 || ok.Routes != 2 || reloads != 1 {
		t.Errorf("reload: status %d, body %s", r.status, r.body)
	}

	next = fmt.Errorf("routes file routes.json: %w", errors.Join(
		&config.RouteError{Route: "orders", Field: "timeout", Message: "must be positive"},
		&config.RouteError{Route: "users", Field: "upstreams", Message: "must not be empty"}))
	r = s.call(t, "POST", "/admin/v1/routes/reload", "")
	var e errorBody
	r.decode(t, &e)
	if r.status != 422 || e.Error.Code != "invalid_routes" || len(e.Error.Details) != 2 ||
		!strings.Contains(e.Error.Details[0], "orders") || !strings.Contains(e.Error.Details[1], "upstreams") {
		t.Errorf("rejected reload: status %d, body %s", r.status, r.body)
	}
}

func TestHealthAndReadiness(t *testing.T) {
	s := newServer(t, serverOptions{routes: twoRoutes})
	var rep healthReport
	r := s.call(t, "GET", "/admin/v1/health", "")
	r.decode(t, &rep)
	if r.status != 200 || rep != (healthReport{Status: "ok", Redis: "ok", Routes: 2}) {
		t.Errorf("health: status %d, %+v", r.status, rep)
	}
	if r := s.call(t, "GET", "/readyz", ""); r.status != 200 || string(r.body) != "ready\n" {
		t.Errorf("readyz: status %d", r.status)
	}

	down := newServer(t, serverOptions{routes: twoRoutes, store: pingStore{err: errors.New("dial tcp: connection refused")}})
	r = down.call(t, "GET", "/admin/v1/health", "")
	r.decode(t, &rep)
	if r.status != 503 || rep.Status != "degraded" || !strings.Contains(rep.Redis, "refused") {
		t.Errorf("degraded health: status %d, %+v", r.status, rep)
	}
	if r := down.call(t, "GET", "/readyz", ""); r.status != 503 {
		t.Errorf("readyz without redis: status %d", r.status)
	}
	if r := newServer(t, serverOptions{}).call(t, "GET", "/readyz", ""); r.status != 503 {
		t.Errorf("readyz without routes: status %d", r.status)
	}
	if r := down.call(t, "GET", "/healthz", ""); r.status != 200 {
		t.Errorf("healthz is liveness only: status %d", r.status)
	}
}

func TestPanicsBecomeInternalErrors(t *testing.T) {
	s := newServer(t, serverOptions{routes: twoRoutes}) // pingStore does not implement ListConsumers
	r := s.call(t, "GET", "/admin/v1/consumers", "")
	if r.status != 500 || r.errorCode(t) != "internal" {
		t.Errorf("status %d, body %s", r.status, r.body)
	}
	if !strings.Contains(metricsText(t, s), `gateway_admin_requests_total{pattern="GET /admin/v1/consumers",status="500"} 1`) {
		t.Errorf("the 500 was not counted:\n%s", metricsText(t, s))
	}
}

func metricsText(t *testing.T, s *testServer) string {
	t.Helper()
	var b strings.Builder
	if err := s.reg.WriteText(&b); err != nil {
		t.Fatal(err)
	}
	return b.String()
}
