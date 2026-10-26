package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/auth"
	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/config"
	"github.com/relaywork/gateway/internal/core"
	"github.com/relaywork/gateway/internal/logging"
	"github.com/relaywork/gateway/internal/metrics"
	"github.com/relaywork/gateway/internal/model"
)

var t0 = time.Date(2025, time.June, 2, 12, 0, 0, 0, time.UTC)

// fixture is a proxy handler over a route table built from a routes-file body. The runtime
// (breakers, health checks) runs on rtClock; the handler on the clock the options name.
type fixture struct {
	t       *testing.T
	rt      *core.Runtime
	rtClock *clock.Manual
	h       *Handler
	reg     *metrics.Registry
	logs    *syncBuffer
}

type fixtureOptions struct {
	transport http.RoundTripper // default: a transport that fails the test when used
	clock     clock.Clock       // default: the real clock
	auth      auth.Modes
	limiter   core.RateLimiter
	trusted   []string
	bodyLimit int64 // default: 1 MiB
}

func newFixture(t *testing.T, routesJSON string, o fixtureOptions) *fixture {
	t.Helper()
	f, err := tryFixture(t, routesJSON, o)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// tryFixture is newFixture returning the error of a routes body the gateway rejects.
func tryFixture(t *testing.T, routesJSON string, o fixtureOptions) (*fixture, error) {
	t.Helper()
	f := &fixture{t: t, rtClock: clock.NewManual(t0), reg: metrics.NewRegistry(), logs: &syncBuffer{}}
	logger := logging.New(f.logs, slog.LevelDebug)
	rt, err := core.NewRuntime(core.RuntimeOptions{Clock: f.rtClock, Logger: logger, Metrics: f.reg})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)
	routes, err := config.ParseRoutes([]byte(routesJSON))
	if err != nil {
		return nil, err
	}
	if err := rt.Apply(routes); err != nil {
		return nil, err
	}
	f.rt = rt

	if o.transport == nil {
		o.transport = &fakeTransport{respond: func(int, *http.Request) (*http.Response, error) {
			t.Error("the upstream was called")
			return nil, errors.New("unexpected upstream call")
		}}
	}
	if o.clock == nil {
		o.clock = clock.Real{}
	}
	if o.bodyLimit == 0 {
		o.bodyLimit = 1 << 20
	}
	var trusted []netip.Prefix
	for _, p := range o.trusted {
		trusted = append(trusted, netip.MustParsePrefix(p))
	}
	h, err := New(Options{
		Routes:          rt,
		Auth:            o.auth,
		RateLimiter:     o.limiter,
		Transport:       o.transport,
		Clock:           o.clock,
		Rand:            zeroRand{},
		Logger:          logger,
		Metrics:         f.reg,
		TrustedProxies:  trusted,
		BodyBufferLimit: o.bodyLimit,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.h = h
	return f, nil
}

// do serves r and returns the recorded response.
func (f *fixture) do(r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w
}

// get serves a GET of target.
func (f *fixture) get(target string) *httptest.ResponseRecorder {
	return f.do(httptest.NewRequest(http.MethodGet, target, nil))
}

// has reports whether the metrics exposition contains line.
func (f *fixture) has(line string) bool {
	f.t.Helper()
	var out strings.Builder
	if err := f.reg.WriteText(&out); err != nil {
		f.t.Fatal(err)
	}
	return strings.Contains(out.String(), line)
}

// zeroRand makes backoff jitter deterministic: every delay is half the full backoff.
type zeroRand struct{}

func (zeroRand) Int64N(int64) int64 { return 0 }

// syncBuffer is a bytes.Buffer safe for the concurrent writes of a logger.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// sent is a request as it reached the fake transport.
type sent struct {
	method string
	url    string // with the escaped path
	host   string
	header http.Header
	body   string
	length int64
	// getBody reports whether the request could be replayed by the transport.
	getBody bool
}

// fakeTransport answers outbound requests with respond, numbering calls from 1.
type fakeTransport struct {
	mu      sync.Mutex
	calls   []sent
	respond func(n int, r *http.Request) (*http.Response, error)
}

func (f *fakeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	var body []byte
	if r.Body != nil {
		body, _ = io.ReadAll(r.Body)
		r.Body.Close()
	}
	f.mu.Lock()
	f.calls = append(f.calls, sent{
		method:  r.Method,
		url:     r.URL.String(),
		host:    r.Host,
		header:  r.Header.Clone(),
		body:    string(body),
		length:  r.ContentLength,
		getBody: r.GetBody != nil,
	})
	n := len(f.calls)
	f.mu.Unlock()
	return f.respond(n, r)
}

func (f *fakeTransport) sent() []sent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sent(nil), f.calls...)
}

// statusTransport answers every call with the next status of the list, repeating the last.
func statusTransport(statuses ...int) *fakeTransport {
	return &fakeTransport{respond: func(n int, r *http.Request) (*http.Response, error) {
		s := statuses[min(n, len(statuses))-1]
		return reply(r, s, "status "+http.StatusText(s)), nil
	}}
}

// reply builds an upstream response with body and header pairs.
func reply(r *http.Request, status int, body string, headerPairs ...string) *http.Response {
	h := make(http.Header)
	for i := 0; i+1 < len(headerPairs); i += 2 {
		h.Add(headerPairs[i], headerPairs[i+1])
	}
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", "text/plain")
	}
	return &http.Response{
		StatusCode:    status,
		Status:        http.StatusText(status),
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        h,
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
		Request:       r,
	}
}

// fakeAuth authenticates every request as consumer, or fails with err.
type fakeAuth struct {
	consumer  model.Consumer
	err       error
	needsBody bool
	gotBody   []byte
}

func (a *fakeAuth) Authenticate(_ context.Context, r *http.Request, body []byte) (model.Consumer, error) {
	a.gotBody = body
	if a.err != nil {
		return model.Consumer{}, a.err
	}
	if r.Header.Get("Authorization") == "" && r.Header.Get("X-Api-Key") == "" {
		return model.Consumer{}, auth.ErrMissingCredentials
	}
	return a.consumer, nil
}

func (a *fakeAuth) NeedsBody() bool        { return a.needsBody }
func (a *fakeAuth) StripHeaders() []string { return []string{"Authorization", "X-Api-Key"} }

// fakeLimiter records the keys it is asked about and answers with decide.
type fakeLimiter struct {
	mu     sync.Mutex
	keys   []string
	decide func(n int) (core.RateLimitDecision, error)
}

func (l *fakeLimiter) Allow(_ context.Context, route, consumer string, p core.RateLimitPolicy) (core.RateLimitDecision, error) {
	l.mu.Lock()
	l.keys = append(l.keys, route+"/"+consumer)
	n := len(l.keys)
	l.mu.Unlock()
	return l.decide(n)
}

// errorOf decodes a gateway error response.
func errorOf(t *testing.T, w *httptest.ResponseRecorder) errorDetail {
	t.Helper()
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var body errorBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body %q: %v", w.Body.String(), err)
	}
	return body.Error
}
