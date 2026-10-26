package proxy

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"testing/iotest"
	"time"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/core"
)

func retryRoute(extra string) string {
	return `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"http://up.internal"}],
	  "retry":{"attempts":3,"backoff":"1ms"` + extra + `}}]}`
}

func TestRetriesOnlyIdempotentMethods(t *testing.T) {
	for _, c := range []struct {
		method       string
		wantStatus   int
		wantAttempts int
	}{
		{"GET", 200, 2},
		{"HEAD", 200, 2},
		{"OPTIONS", 200, 2},
		{"PUT", 200, 2},
		{"DELETE", 200, 2},
		{"POST", 503, 1},
		{"PATCH", 503, 1},
	} {
		tr := statusTransport(503, 200)
		f := newFixture(t, retryRoute(""), fixtureOptions{transport: tr})
		w := f.do(httptest.NewRequest(c.method, "/api/x", strings.NewReader("body")))
		if w.Code != c.wantStatus || len(tr.sent()) != c.wantAttempts {
			t.Errorf("%s: status %d after %d attempts, want %d after %d", c.method, w.Code, len(tr.sent()), c.wantStatus, c.wantAttempts)
		}
	}
}

func TestNonIdempotentRetriesAreOptIn(t *testing.T) {
	tr := statusTransport(502, 503, 200)
	f := newFixture(t, retryRoute(`,"non_idempotent":true`), fixtureOptions{transport: tr})
	w := f.do(httptest.NewRequest("POST", "/api/x", strings.NewReader(`{"n":1}`)))
	if w.Code != 200 || len(tr.sent()) != 3 {
		t.Fatalf("status %d after %d attempts", w.Code, len(tr.sent()))
	}
	for i, call := range tr.sent() {
		if call.body != `{"n":1}` || call.length != 7 {
			t.Errorf("attempt %d sent body %q (length %d)", i+1, call.body, call.length)
		}
	}
	if !f.has(`gateway_retries_total{route="api"} 2`) {
		t.Error("retries were not counted")
	}
}

func TestRetryGivesUpAfterAttemptsAndRelaysLastResponse(t *testing.T) {
	tr := &fakeTransport{respond: func(n int, r *http.Request) (*http.Response, error) {
		return reply(r, 503, "attempt "+string(rune('0'+n))), nil
	}}
	f := newFixture(t, retryRoute(""), fixtureOptions{transport: tr})
	w := f.get("/api/x")
	if w.Code != 503 || w.Body.String() != "attempt 3" || len(tr.sent()) != 3 {
		t.Errorf("status %d, body %q after %d attempts", w.Code, w.Body.String(), len(tr.sent()))
	}
}

func TestRetryOnlyOnListedStatuses(t *testing.T) {
	tr := statusTransport(500, 200)
	f := newFixture(t, retryRoute(`,"on_status":[502]`), fixtureOptions{transport: tr})
	if w := f.get("/api/x"); w.Code != 500 || len(tr.sent()) != 1 {
		t.Errorf("status %d after %d attempts; 500 is not in on_status", w.Code, len(tr.sent()))
	}
}

func TestOversizedBodyIsSentOnceWithoutRetry(t *testing.T) {
	big := strings.Repeat("x", 64)
	for _, chunked := range []bool{false, true} {
		tr := statusTransport(503, 200)
		f := newFixture(t, retryRoute(""), fixtureOptions{transport: tr, bodyLimit: 16})
		r := httptest.NewRequest("PUT", "/api/x", strings.NewReader(big))
		if chunked {
			r.ContentLength = -1
		}
		w := f.do(r)
		calls := tr.sent()
		if w.Code != 503 || len(calls) != 1 {
			t.Errorf("chunked %v: status %d after %d attempts, want one attempt", chunked, w.Code, len(calls))
			continue
		}
		if calls[0].body != big {
			t.Errorf("chunked %v: upstream got %d bytes, want the whole body", chunked, len(calls[0].body))
		}
	}
}

func TestRequestBodyReadErrorIsBadRequest(t *testing.T) {
	f := newFixture(t, retryRoute(""), fixtureOptions{})
	r := httptest.NewRequest("PUT", "/api/x", iotest.ErrReader(errors.New("client reset")))
	r.ContentLength = -1
	w := f.do(r)
	if w.Code != 400 || errorOf(t, w).Code != codeBadRequest {
		t.Errorf("status %d, body %s", w.Code, w.Body)
	}
}

func TestRetryPrefersUntriedUpstreams(t *testing.T) {
	tr := &fakeTransport{respond: func(n int, r *http.Request) (*http.Response, error) {
		return reply(r, 503, ""), nil
	}}
	routes := `{"routes":[{"id":"api","path_prefix":"/api","retry":{"attempts":3,"backoff":"1ms"},
	  "upstreams":[{"url":"http://a.internal","weight":5},{"url":"http://b.internal","weight":1}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr})
	for range 4 {
		f.get("/api/x")
	}
	calls := tr.sent()
	for i := 0; i < len(calls); i += 3 {
		if calls[i].host == calls[i+1].host {
			t.Errorf("request %d: the first retry went back to %s", i/3+1, calls[i].host)
		}
	}
}

func TestRetryOnConnectErrorReachesLiveUpstream(t *testing.T) {
	live := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "live")
	}))
	defer live.Close()
	dead := deadURL(t)
	routes := `{"routes":[{"id":"api","path_prefix":"/api","retry":{"attempts":2,"backoff":"1ms"},
	  "upstreams":[{"url":"` + dead + `"},{"url":"` + live.URL + `"}]}]}`
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	f := newFixture(t, routes, fixtureOptions{transport: transport})
	for range 4 {
		if w := f.get("/api/x"); w.Code != 200 || w.Body.String() != "live" {
			t.Fatalf("status %d, body %q", w.Code, w.Body)
		}
	}
}

func TestConnectErrorIsBadGateway(t *testing.T) {
	routes := `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"` + deadURL(t) + `"}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: &http.Transport{}})
	w := f.get("/api/x")
	if w.Code != 502 || errorOf(t, w).Code != codeUpstreamUnreachable {
		t.Errorf("status %d, body %s", w.Code, w.Body)
	}
	if !strings.Contains(f.logs.String(), `"status":502`) {
		t.Errorf("access log: %s", f.logs)
	}
}

func TestClassify(t *testing.T) {
	bg := context.Background()
	timedOut, cancel := context.WithCancelCause(bg)
	cancel(errUpstreamTimeout)
	gone, cancelGone := context.WithCancel(bg)
	cancelGone()
	dial := &net.OpError{Op: "dial", Err: errors.New("no route to host")}
	read := &net.OpError{Op: "read", Err: syscall.ECONNRESET}
	cases := []struct {
		name               string
		attempt, client    context.Context
		err                error
		wantClass          core.ErrorClass
		wantClientCanceled bool
	}{
		{"timeout", timedOut, bg, errors.New("context canceled"), core.ErrTimeout, false},
		{"client gone", gone, gone, errors.New("context canceled"), "", true},
		{"dial", bg, bg, dial, core.ErrConnect, false},
		{"refused", bg, bg, syscall.ECONNREFUSED, core.ErrConnect, false},
		{"dns", bg, bg, &net.DNSError{Err: "no such host", Name: "up.internal"}, core.ErrConnect, false},
		{"reset", bg, bg, read, core.ErrReset, false},
		{"eof", bg, bg, io.ErrUnexpectedEOF, core.ErrReset, false},
	}
	for _, c := range cases {
		class, canceled := classify(c.attempt, c.client, c.err)
		if class != c.wantClass || canceled != c.wantClientCanceled {
			t.Errorf("%s: classify = %q, %v", c.name, class, canceled)
		}
	}
}

func TestUpstreamTimeoutIsGatewayTimeout(t *testing.T) {
	clk := clock.NewManual(t0)
	started := make(chan struct{})
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		close(started)
		<-r.Context().Done()
		return nil, r.Context().Err()
	}}
	routes := `{"routes":[{"id":"api","path_prefix":"/api","timeout":"2s","upstreams":[{"url":"http://up.internal"}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr, clock: clk})

	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- f.get("/api/slow") }()
	<-started
	clk.BlockUntil(1)
	clk.Advance(2*time.Second - time.Millisecond)
	select {
	case w := <-done:
		t.Fatalf("answered before the timeout: %d", w.Code)
	case <-time.After(20 * time.Millisecond):
	}
	clk.Advance(time.Millisecond)
	w := <-done
	if w.Code != 504 || errorOf(t, w).Code != codeUpstreamTimeout {
		t.Errorf("status %d, body %s", w.Code, w.Body)
	}
}

// TestTimeoutCoversHeadersOnly checks that a response whose headers arrived in time streams to
// the end, even when the body takes longer than the route's timeout.
func TestTimeoutCoversHeadersOnly(t *testing.T) {
	clk := clock.NewManual(t0)
	pr, pw := io.Pipe()
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		resp := reply(r, 200, "")
		resp.Body, resp.ContentLength = pr, -1
		return resp, nil
	}}
	routes := `{"routes":[{"id":"api","path_prefix":"/api","timeout":"1s","upstreams":[{"url":"http://up.internal"}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr, clock: clk})
	done := make(chan *httptest.ResponseRecorder)
	go func() { done <- f.get("/api/stream") }()

	io.WriteString(pw, "part one,") // returns once the handler is relaying the body
	if n := clk.Waiters(); n != 0 {
		t.Errorf("%d timers still pending while the body streams; the timeout must stop at the headers", n)
	}
	clk.Advance(time.Hour)
	io.WriteString(pw, "part two")
	pw.Close()
	w := <-done
	if w.Code != 200 || w.Body.String() != "part one,part two" {
		t.Errorf("status %d, body %q", w.Code, w.Body)
	}
}

// TestTimeoutWithStalledRequestBody: a client that sends part of a streamed body and stops must not
// hold the attempt past the route's timeout. The transport gives up an attempt only once the read
// of the body it is sending returns, so the gateway has to interrupt that read.
func TestTimeoutWithStalledRequestBody(t *testing.T) {
	clk := clock.NewManual(t0)
	arrived, release := make(chan struct{}), make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(arrived)
		<-release // does not answer within the test
	}))
	t.Cleanup(up.Close)
	t.Cleanup(func() { close(release) })
	routes := `{"routes":[{"id":"api","path_prefix":"/api","timeout":"2s","upstreams":[{"url":"` + up.URL + `"}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: &http.Transport{}, clock: clk})
	gw := httptest.NewServer(f.h)
	t.Cleanup(gw.Close)

	conn, err := net.Dial("tcp", gw.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	// Part of a chunked body, and then nothing more.
	if _, err := io.WriteString(conn, "POST /api/upload HTTP/1.1\r\nHost: gw\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n"); err != nil {
		t.Fatal(err)
	}
	<-arrived
	clk.BlockUntil(1)
	clk.Advance(2 * time.Second)

	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("no response after the route's timeout: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusGatewayTimeout || !resp.Close {
		t.Errorf("status %d, close %v; want 504 and the connection closed", resp.StatusCode, resp.Close)
	}
}

func TestCircuitBreakerOpensAndRecovers(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		if fail.Load() {
			return reply(r, 500, "down"), nil
		}
		return reply(r, 200, "up"), nil
	}}
	routes := `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"http://up.internal"}],
	  "circuit_breaker":{"failure_ratio":0.5,"min_requests":2,"window":4,"open_duration":"10s"}}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr})
	f.get("/api/x")
	f.get("/api/x")

	w := f.get("/api/x")
	if w.Code != 503 || errorOf(t, w).Code != codeCircuitOpen {
		t.Fatalf("open breaker: status %d, body %s", w.Code, w.Body)
	}
	if n := len(tr.sent()); n != 2 {
		t.Errorf("the upstream was called %d times, want 2: an open breaker must not call it", n)
	}

	fail.Store(false)
	f.rtClock.Advance(10 * time.Second)
	if w := f.get("/api/x"); w.Code != 200 {
		t.Errorf("half-open probe: status %d", w.Code)
	}
	if w := f.get("/api/x"); w.Code != 200 {
		t.Errorf("closed again: status %d", w.Code)
	}
}

func TestClientErrorsDoNotTripTheBreaker(t *testing.T) {
	tr := statusTransport(404)
	routes := `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"http://up.internal"}],
	  "circuit_breaker":{"min_requests":2,"window":2}}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr})
	for range 5 {
		if w := f.get("/api/x"); w.Code != 404 {
			t.Fatalf("status %d", w.Code)
		}
	}
}

func TestRetrySkipsOpenBreaker(t *testing.T) {
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		if r.URL.Host == "a.internal" {
			return reply(r, 503, "a"), nil
		}
		return reply(r, 200, "b"), nil
	}}
	routes := `{"routes":[{"id":"api","path_prefix":"/api","retry":{"attempts":2,"backoff":"1ms"},
	  "circuit_breaker":{"min_requests":1,"window":1},
	  "upstreams":[{"url":"http://a.internal"},{"url":"http://b.internal"}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr})
	for range 6 {
		if w := f.get("/api/x"); w.Code != 200 {
			t.Fatalf("status %d", w.Code)
		}
	}
	aCalls := 0
	for _, c := range tr.sent() {
		if c.host == "a.internal" {
			aCalls++
		}
	}
	if aCalls != 1 {
		t.Errorf("a.internal was called %d times; its breaker opened after the first failure", aCalls)
	}
}

func TestNoHealthyUpstream(t *testing.T) {
	probes := make(chan struct{}, 4)
	health := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		probes <- struct{}{}
	}))
	defer health.Close()
	routes := `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"` + health.URL + `"}],
	  "health_check":{"path":"/healthz","interval":"5s","unhealthy_threshold":1}}]}`
	f := newFixture(t, routes, fixtureOptions{})
	<-probes
	f.rtClock.BlockUntil(1) // the checker recorded the failure and waits for the next round
	w := f.get("/api/x")
	if w.Code != 503 || errorOf(t, w).Code != codeNoHealthyUpstream {
		t.Errorf("status %d, body %s", w.Code, w.Body)
	}
}

func TestJoinPath(t *testing.T) {
	cases := []struct {
		base, path, raw, want, wantRaw string
	}{
		{"http://u", "/x", "", "/x", ""},
		{"http://u", "", "", "/", ""},
		{"http://u/base", "", "", "/base", ""},
		{"http://u/base/", "/x", "", "/base/x", ""},
		{"http://u/b%20c", "/x/y", "/x%2Fy", "/b c/x/y", "/b%20c/x%2Fy"},
		{"http://u/b%2Fc", "/x", "", "/b/c/x", "/b%2Fc/x"},          // the base's escaping survives
		{"http://u/b%2Fc/", "/x y", "", "/b/c/x y", "/b%2Fc/x%20y"}, // and the forwarded path is escaped
		{"http://u/b%2Fc", "/a{b}|c", "/a{b}|c", "/b/c/a{b}|c", "/b%2Fc/a%7Bb%7D%7Cc"},
		{"http://u/b%3Bc", "/a{b", "/a{b", "/b;c/a{b", "/b%3Bc/a%7Bb"},
		{"http://u/b%2F", "/api/a/b", "/api/a%2Fb", "/b//api/a/b", "/b%2F/api/a%2Fb"}, // an escaped slash ends the base
		{"http://u/b%2F", "/api/a{b}", "/api/a{b}", "/b//api/a{b}", "/b%2F/api/a%7Bb%7D"},
		{"http://u/b%2F/", "/x", "", "/b//x", "/b%2F/x"}, // a literal slash after it is trimmed
	}
	for _, c := range cases {
		u := mustURL(t, c.base)
		got, raw := joinPath(u, c.path, c.raw)
		if got != c.want || raw != c.wantRaw {
			t.Errorf("joinPath(%s, %q, %q) = %q, %q; want %q, %q", c.base, c.path, c.raw, got, raw, c.want, c.wantRaw)
		}
		// The raw form must encode the joined path, or net/url drops it and escapes the path again.
		if wire, want := (&url.URL{Path: got, RawPath: raw}).EscapedPath(), (&url.URL{Path: c.want, RawPath: c.wantRaw}).EscapedPath(); wire != want {
			t.Errorf("joinPath(%s, %q, %q) is sent as %q; want %q", c.base, c.path, c.raw, wire, want)
		}
	}
}

// deadURL returns the URL of a port nothing listens on.
func deadURL(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return "http://" + addr
}

func mustURL(t *testing.T, s string) *url.URL {
	t.Helper()
	u, err := url.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
