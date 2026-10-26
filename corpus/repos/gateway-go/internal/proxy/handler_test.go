package proxy

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	"github.com/relaywork/gateway/internal/auth"
	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/core"
	"github.com/relaywork/gateway/internal/logging"
	"github.com/relaywork/gateway/internal/model"
)

func allowAll(n int) (core.RateLimitDecision, error) {
	return core.RateLimitDecision{Allowed: true, Limit: 10, Remaining: 10 - n, Reset: time.Minute}, nil
}

func TestNewValidatesOptions(t *testing.T) {
	if _, err := New(Options{}); err == nil {
		t.Error("New accepted empty options")
	}
	rt, err := core.NewRuntime(core.RuntimeOptions{Clock: clock.Real{}, Logger: logging.Discard()})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	o := Options{Routes: rt, Transport: statusTransport(200), Clock: clock.Real{}, Logger: logging.Discard(), BodyBufferLimit: -1}
	if _, err := New(o); err == nil {
		t.Error("New accepted a negative body buffer limit")
	}
}

func TestRouteNotFoundAndMethodNotAllowed(t *testing.T) {
	routes := `{"routes":[
	  {"id":"read","path":"/items","methods":["GET","HEAD"],"upstreams":[{"url":"http://up.internal"}]},
	  {"id":"write","path":"/items","methods":["POST"],"upstreams":[{"url":"http://up.internal"}]}]}`
	f := newFixture(t, routes, fixtureOptions{})

	w := f.get("/nothing")
	e := errorOf(t, w)
	if w.Code != 404 || e.Code != codeRouteNotFound || e.RequestID == "" || e.RequestID != w.Header().Get("X-Request-Id") {
		t.Errorf("404: status %d, error %+v", w.Code, e)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Error("gateway errors must not be cached")
	}

	w = f.do(httptest.NewRequest("DELETE", "/items", nil))
	if w.Code != 405 || errorOf(t, w).Code != codeMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD, POST" {
		t.Errorf("405: status %d, Allow %q, body %s", w.Code, w.Header().Get("Allow"), w.Body)
	}
	if !f.has(`gateway_requests_total{route="unmatched",class="4xx"} 2`) {
		t.Error("unmatched requests are not counted")
	}
}

func TestUncleanPathIsRejected(t *testing.T) {
	f := newFixture(t, oneRoute, fixtureOptions{})
	for _, p := range []string{"/api/../admin", "/api//x", "/api/./x"} {
		w := f.do(httptest.NewRequest("GET", p, nil))
		if w.Code != 400 || errorOf(t, w).Code != codeBadRequest {
			t.Errorf("%s: status %d", p, w.Code)
		}
	}
}

func TestRateLimitHeadersAndRejection(t *testing.T) {
	tr := statusTransport(200)
	lim := &fakeLimiter{decide: func(n int) (core.RateLimitDecision, error) {
		return core.RateLimitDecision{Allowed: n <= 2, Limit: 2, Remaining: max(2-n, 0), Reset: 1500 * time.Millisecond}, nil
	}}
	consumer := model.Consumer{ID: "c_0123456789abcdef", Enabled: true}
	routes := `{"routes":[{"id":"api","path_prefix":"/api","auth":"api_key","upstreams":[{"url":"http://up.internal"}],
	  "rate_limit":{"requests":2,"window":"1m"}}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr, limiter: lim, auth: auth.Modes{"api_key": &fakeAuth{consumer: consumer}}})
	req := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/api/x", nil)
		r.Header.Set("X-Api-Key", "k")
		return f.do(r)
	}

	w := req()
	if w.Code != 200 || w.Header().Get("RateLimit-Limit") != "2" || w.Header().Get("RateLimit-Remaining") != "1" || w.Header().Get("RateLimit-Reset") != "2" {
		t.Errorf("allowed: status %d, header %v", w.Code, w.Header())
	}
	req()
	w = req()
	if w.Code != 429 || errorOf(t, w).Code != codeRateLimited {
		t.Fatalf("over the limit: status %d", w.Code)
	}
	if w.Header().Get("Retry-After") != "2" || w.Header().Get("RateLimit-Remaining") != "0" {
		t.Errorf("429 header %v", w.Header())
	}
	if len(tr.sent()) != 2 {
		t.Errorf("the upstream got %d requests, want 2", len(tr.sent()))
	}
	if lim.keys[0] != "api/consumer:"+consumer.ID {
		t.Errorf("limiter key = %q, want the consumer", lim.keys[0])
	}
	if !f.has(`gateway_rate_limit_rejections_total{route="api"} 1`) {
		t.Error("the rejection was not counted")
	}
}

func TestRateLimiterFailureFailsOpen(t *testing.T) {
	tr := statusTransport(200)
	lim := &fakeLimiter{decide: func(int) (core.RateLimitDecision, error) {
		return core.RateLimitDecision{}, errors.New("redis: connection refused")
	}}
	routes := `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"http://up.internal"}],"rate_limit":{"requests":1,"window":"1s"}}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr, limiter: lim})
	w := f.get("/api/x")
	if w.Code != 200 || w.Header().Get("RateLimit-Limit") != "" {
		t.Errorf("status %d, header %v", w.Code, w.Header())
	}
	if !f.has(`gateway_rate_limit_errors_total{route="api"} 1`) {
		t.Error("the limiter failure was not counted")
	}
}

func TestCeilSeconds(t *testing.T) {
	for d, want := range map[time.Duration]int64{0: 1, time.Millisecond: 1, time.Second: 1, 1001 * time.Millisecond: 2, time.Minute: 60} {
		if got := ceilSeconds(d); got != want {
			t.Errorf("ceilSeconds(%s) = %d, want %d", d, got, want)
		}
	}
}

func TestAuthenticationFailures(t *testing.T) {
	routes := `{"routes":[
	  {"id":"keyed","path_prefix":"/keyed","auth":"api_key","upstreams":[{"url":"http://up.internal"}]},
	  {"id":"signed","path_prefix":"/signed","auth":"hmac","upstreams":[{"url":"http://up.internal"}]}]}`
	cases := []struct {
		name      string
		authErr   error
		path      string
		header    string
		modes     bool
		status    int
		code      string
		challenge string
	}{
		{"missing", nil, "/keyed/x", "", true, 401, codeMissingCreds, "Bearer"},
		{"invalid", auth.ErrInvalidCredentials, "/keyed/x", "k", true, 401, codeInvalidCreds, "Bearer"},
		{"stale", auth.ErrStaleSignature, "/signed/x", "k", true, 401, codeStaleSignature, "HMAC"},
		{"store down", errors.New("redis: i/o timeout"), "/keyed/x", "k", true, 503, codeAuthUnavailable, ""},
		{"mode not configured", nil, "/keyed/x", "k", false, 500, codeAuthUnavailable, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var modes auth.Modes
			if c.modes {
				a := &fakeAuth{err: c.authErr, consumer: model.Consumer{ID: "c_0123456789abcdef"}}
				modes = auth.Modes{"api_key": a, "hmac": a}
			}
			f := newFixture(t, routes, fixtureOptions{auth: modes})
			r := httptest.NewRequest("GET", c.path, nil)
			if c.header != "" {
				r.Header.Set("X-Api-Key", c.header)
			}
			w := f.do(r)
			if w.Code != c.status || errorOf(t, w).Code != c.code {
				t.Errorf("status %d, body %s", w.Code, w.Body)
			}
			if got := w.Header().Get("WWW-Authenticate"); (c.challenge == "") != (got == "") || !strings.HasPrefix(got, c.challenge) {
				t.Errorf("WWW-Authenticate = %q", got)
			}
		})
	}
}

func TestBodySigningModes(t *testing.T) {
	tr := statusTransport(503, 200)
	signer := &fakeAuth{needsBody: true, consumer: model.Consumer{ID: "c_0123456789abcdef"}}
	routes := `{"routes":[{"id":"signed","path_prefix":"/signed","auth":"hmac","retry":{"attempts":2,"backoff":"1ms"},
	  "upstreams":[{"url":"http://up.internal"}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr, auth: auth.Modes{"hmac": signer}, bodyLimit: 16})

	r := httptest.NewRequest("PUT", "/signed/x", strings.NewReader("signed body"))
	r.Header.Set("Authorization", "HMAC ...")
	if w := f.do(r); w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	if string(signer.gotBody) != "signed body" {
		t.Errorf("the authenticator got %q", signer.gotBody)
	}
	for i, c := range tr.sent() {
		if c.body != "signed body" {
			t.Errorf("attempt %d sent %q; the buffered body must be replayed", i+1, c.body)
		}
	}

	for _, length := range []int64{17, -1} {
		r = httptest.NewRequest("PUT", "/signed/x", strings.NewReader(strings.Repeat("y", 17)))
		r.ContentLength = length
		r.Header.Set("Authorization", "HMAC ...")
		w := f.do(r)
		if w.Code != 413 || errorOf(t, w).Code != codeBodyTooLarge {
			t.Errorf("length %d: status %d", length, w.Code)
		}
	}
}

func TestHeadResponseHasNoBody(t *testing.T) {
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		resp := reply(r, 200, "")
		resp.Header.Set("Content-Length", "1234")
		resp.ContentLength = 1234
		return resp, nil
	}}
	f := newFixture(t, oneRoute, fixtureOptions{transport: tr})
	w := f.do(httptest.NewRequest("HEAD", "/api/x", nil))
	if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != "1234" {
		t.Errorf("status %d, body %d bytes, Content-Length %q", w.Code, w.Body.Len(), w.Header().Get("Content-Length"))
	}
}

func TestGatewayHeadersOverrideUpstream(t *testing.T) {
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		return reply(r, 201, "made", "X-Request-Id", "upstream-id", "Location", "/api/x/1"), nil
	}}
	f := newFixture(t, oneRoute, fixtureOptions{transport: tr})
	r := httptest.NewRequest("POST", "/api/x", strings.NewReader("{}"))
	r.Header.Set("X-Request-Id", "client-id")
	w := f.do(r)
	if w.Code != 201 || w.Body.String() != "made" || w.Header().Get("Location") != "/api/x/1" {
		t.Errorf("status %d, body %q, header %v", w.Code, w.Body, w.Header())
	}
	if got := w.Header().Values("X-Request-Id"); len(got) != 1 || got[0] != "client-id" {
		t.Errorf("X-Request-Id = %q", got)
	}
}

// TestEventStreamIsFlushedPerWrite reads the first event while the upstream still holds the
// stream open: the gateway must not buffer it.
func TestEventStreamIsFlushedPerWrite(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	routes := `{"routes":[{"id":"events","path":"/events","upstreams":[{"url":"` + upstream.URL + `"}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: transport})
	gw := httptest.NewServer(f.h)
	defer gw.Close()
	defer close(release)

	resp, err := http.Get(gw.URL + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil || line != "data: first\n" {
		t.Fatalf("first line %q, %v", line, err)
	}
}

func TestFlushesEachWrite(t *testing.T) {
	cases := []struct {
		contentType string
		length      int64
		want        bool
	}{
		{"text/event-stream", 10, true},
		{"text/event-stream; charset=utf-8", 10, true},
		{"application/json", -1, true},
		{"application/json", 10, false},
		{"", 0, false},
	}
	for _, c := range cases {
		resp := &http.Response{Header: http.Header{"Content-Type": {c.contentType}}, ContentLength: c.length}
		if got := flushesEachWrite(resp); got != c.want {
			t.Errorf("%q length %d: %v", c.contentType, c.length, got)
		}
	}
}

func TestBrokenUpstreamBodyAbortsTheResponse(t *testing.T) {
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		resp := reply(r, 200, "")
		resp.Body = io.NopCloser(io.MultiReader(strings.NewReader("partial"), iotest.ErrReader(io.ErrUnexpectedEOF)))
		resp.ContentLength = 100
		return resp, nil
	}}
	f := newFixture(t, oneRoute, fixtureOptions{transport: tr})
	w := httptest.NewRecorder()
	func() {
		defer func() {
			if p := recover(); p != http.ErrAbortHandler {
				t.Errorf("panic = %v, want http.ErrAbortHandler", p)
			}
		}()
		f.h.ServeHTTP(w, httptest.NewRequest("GET", "/api/x", nil))
	}()
	if w.Body.String() != "partial" {
		t.Errorf("body %q", w.Body)
	}
	if !strings.Contains(f.logs.String(), "upstream response broke off") {
		t.Error("the truncation was not logged")
	}
	if !f.has(`gateway_requests_total{route="api",class="2xx"} 1`) {
		t.Error("the aborted request was not counted")
	}
}

func TestAccessLog(t *testing.T) {
	tr := statusTransport(200)
	consumer := model.Consumer{ID: "c_0123456789abcdef"}
	routes := `{"routes":[{"id":"keyed","path_prefix":"/keyed","auth":"api_key","upstreams":[{"url":"http://up.internal"}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr, auth: auth.Modes{"api_key": &fakeAuth{consumer: consumer}}})
	r := httptest.NewRequest("GET", "/keyed/x?token=abc", nil)
	r.Header.Set("Authorization", "Bearer gk_0123456789ab.supersecret")
	f.do(r)
	log := f.logs.String()
	for _, want := range []string{`"msg":"request"`, `"route":"keyed"`, `"status":200`, `"consumer_id":"c_0123456789abcdef"`, `"upstream":"http://up.internal"`, `"attempts":1`} {
		if !strings.Contains(log, want) {
			t.Errorf("access log lacks %s: %s", want, log)
		}
	}
	for _, secret := range []string{"supersecret", "token=abc"} {
		if strings.Contains(log, secret) {
			t.Errorf("access log contains %q", secret)
		}
	}
}

func TestStatusClass(t *testing.T) {
	for status, want := range map[int]string{200: "2xx", 302: "3xx", 404: "4xx", 499: "4xx", 503: "5xx", 0: "other", 600: "other"} {
		if got := statusClass(status); got != want {
			t.Errorf("statusClass(%d) = %q, want %q", status, got, want)
		}
	}
}

// TestTrailersAreRelayedBothWays sends a chunked request with a trailer through the gateway to a
// real upstream, which answers with a declared and an undeclared trailer.
func TestTrailersAreRelayedBothWays(t *testing.T) {
	gotTrailer := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		gotTrailer <- r.Trailer.Get("X-Checksum")
		w.Header().Set("Trailer", "X-Result")
		io.WriteString(w, "body")
		w.Header().Set("X-Result", "done")
		w.Header().Set(http.TrailerPrefix+"X-Late", "late")
	}))
	defer upstream.Close()
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()

	for _, c := range []struct{ name, retry string }{{"streamed", ""}, {"buffered for retries", `,"retry":{"attempts":2}`}} {
		t.Run(c.name, func(t *testing.T) {
			routes := `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"` + upstream.URL + `"}]` + c.retry + `}]}`
			f := newFixture(t, routes, fixtureOptions{transport: transport})
			gw := httptest.NewServer(f.h)
			defer gw.Close()

			req, err := http.NewRequest("PUT", gw.URL+"/api/x", io.NopCloser(strings.NewReader("payload")))
			if err != nil {
				t.Fatal(err)
			}
			req.ContentLength = -1
			req.Trailer = http.Header{"X-Checksum": {"abc123"}}
			resp, err := gw.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			if got := <-gotTrailer; got != "abc123" {
				t.Errorf("the upstream got request trailer %q", got)
			}
			if string(body) != "body" || resp.Trailer.Get("X-Result") != "done" || resp.Trailer.Get("X-Late") != "late" {
				t.Errorf("status %d, body %q, trailer %v", resp.StatusCode, body, resp.Trailer)
			}
		})
	}
}

// TestClientGoneMidResponseAbortsWithoutBlamingTheUpstream cancels the client (as a half-close
// does, while it may still read) after the first part of a stream. The response must be aborted,
// not ended as if complete, and the upstream must not be blamed for the read error that follows.
func TestClientGoneMidResponseAbortsWithoutBlamingTheUpstream(t *testing.T) {
	reading := make(chan struct{})
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		resp := reply(r, 200, "", "Content-Type", "text/event-stream")
		resp.ContentLength = -1
		first := true
		resp.Body = io.NopCloser(readerFunc(func(p []byte) (int, error) {
			if first {
				first = false
				return copy(p, "data: 1\n\n"), nil
			}
			close(reading)
			<-r.Context().Done()
			return 0, r.Context().Err()
		}))
		return resp, nil
	}}
	f := newFixture(t, oneRoute, fixtureOptions{transport: tr})
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("GET", "/api/x", nil).WithContext(ctx)
	go func() {
		<-reading
		cancel()
	}()
	w := httptest.NewRecorder()
	func() {
		defer func() {
			if p := recover(); p != http.ErrAbortHandler {
				t.Errorf("panic = %v, want http.ErrAbortHandler: a truncated stream must not look complete", p)
			}
		}()
		f.h.ServeHTTP(w, r)
	}()
	if w.Body.String() != "data: 1\n\n" {
		t.Errorf("body %q", w.Body)
	}
	if strings.Contains(f.logs.String(), "upstream response broke off") {
		t.Errorf("a client disconnect was logged as an upstream failure: %s", f.logs)
	}
}

// TestClientGoneBeforeHeadersAbortsTheConnection checks a client that goes away while the
// upstream has not answered: nothing may be sent that looks like an empty 200, and the request
// is logged and counted as 499.
func TestClientGoneBeforeHeadersAbortsTheConnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		cancel()
		<-r.Context().Done()
		return nil, r.Context().Err()
	}}
	f := newFixture(t, oneRoute, fixtureOptions{transport: tr})
	w := httptest.NewRecorder()
	func() {
		defer func() {
			if p := recover(); p != http.ErrAbortHandler {
				t.Errorf("panic = %v, want http.ErrAbortHandler", p)
			}
		}()
		f.h.ServeHTTP(w, httptest.NewRequest("GET", "/api/x", nil).WithContext(ctx))
	}()
	if w.Body.Len() != 0 || len(w.Header()) > 1 {
		t.Errorf("wrote a response: header %v, body %q", w.Header(), w.Body)
	}
	if !strings.Contains(f.logs.String(), `"status":499`) {
		t.Errorf("access log: %s", f.logs)
	}
	if !f.has(`gateway_requests_total{route="api",class="4xx"} 1`) {
		t.Error("the request was not counted")
	}
}

type readerFunc func([]byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }

// TestEmptyBodyWithTrailersReachesTheUpstream sends a chunked request whose body is empty but
// which carries a trailer.
func TestEmptyBodyWithTrailersReachesTheUpstream(t *testing.T) {
	gotTrailer := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		gotTrailer <- r.Trailer.Get("X-Sum")
	}))
	defer upstream.Close()
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	for _, c := range []struct{ name, retry string }{{"streamed", ""}, {"buffered for retries", `,"retry":{"attempts":2}`}} {
		t.Run(c.name, func(t *testing.T) {
			routes := `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"` + upstream.URL + `"}]` + c.retry + `}]}`
			f := newFixture(t, routes, fixtureOptions{transport: transport})
			gw := httptest.NewServer(f.h)
			defer gw.Close()
			req, _ := http.NewRequest("PUT", gw.URL+"/api/x", io.NopCloser(strings.NewReader("")))
			req.ContentLength = -1
			req.Trailer = http.Header{"X-Sum": {"0"}}
			resp, err := gw.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 200 {
				t.Fatalf("status %d", resp.StatusCode)
			}
			if got := <-gotTrailer; got != "0" {
				t.Errorf("the upstream got trailer %q", got)
			}
		})
	}
}

// TestReplayableBodiesCanBeResent checks that the transport may resend a buffered body, also
// when trailers make its length unknown.
func TestReplayableBodiesCanBeResent(t *testing.T) {
	tr := statusTransport(200)
	f := newFixture(t, retryRoute(""), fixtureOptions{transport: tr})
	r := httptest.NewRequest("PUT", "/api/x", strings.NewReader("payload"))
	r.Trailer = http.Header{"X-Sum": {"1"}}
	f.do(r)
	f.do(httptest.NewRequest("PUT", "/api/x", strings.NewReader("payload")))
	for i, c := range tr.sent() {
		if !c.getBody || c.body != "payload" {
			t.Errorf("request %d: GetBody set %v, body %q", i+1, c.getBody, c.body)
		}
	}
}

// TestRequestTrailersFollowTheHeaderRules sends trailers that the header rules would not let
// through: they must not reach the upstream either.
func TestRequestTrailersFollowTheHeaderRules(t *testing.T) {
	for _, retry := range []string{"", `,"retry":{"attempts":2}`} {
		t.Run("retry="+strconv.FormatBool(retry != ""), func(t *testing.T) { testRequestTrailers(t, retry) })
	}
}

func testRequestTrailers(t *testing.T, retry string) {
	gotTrailer := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		gotTrailer <- r.Trailer
	}))
	defer upstream.Close()
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	routes := `{"routes":[{"id":"api","path_prefix":"/api","auth":"api_key","upstreams":[{"url":"` + upstream.URL + `"}]` + retry + `,
	  "transforms":{"request":{"remove":["X-Debug"],"rename":{"X-Old":"X-New"},"add":{"X-Env":"prod"}}}}]}`
	consumer := model.Consumer{ID: "c_0123456789abcdef", Enabled: true}
	f := newFixture(t, routes, fixtureOptions{transport: transport, auth: auth.Modes{"api_key": &fakeAuth{consumer: consumer}}})
	gw := httptest.NewServer(f.h)
	defer gw.Close()

	req, _ := http.NewRequest("PUT", gw.URL+"/api/x", io.NopCloser(strings.NewReader("payload")))
	req.ContentLength = -1
	req.Header.Set("X-Api-Key", "k")
	req.Header.Set("Connection", "X-Conn-Listed")
	forged := map[string]string{
		"X-Consumer-Id": "c_ffffffffffffffff", "X-Api-Key": "k2", "Authorization": "Bearer other",
		"X-Forwarded-For": "127.0.0.1", "X-Request-Id": "forged-id", "X-Real-Ip": "127.0.0.1",
		"X-Conn-Listed": "1", "X-Debug": "1", "X-Env": "dev", "Keep-Alive": "timeout=1",
		"Host": "evil.example", // framing fields are not allowed in trailers (RFC 9110 section 6.5.1)
	}
	req.Trailer = http.Header{"X-Sum": {"abc"}, "X-Old": {"v"}}
	for k, v := range forged {
		req.Trailer.Set(k, v)
	}
	resp, err := gw.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	got := <-gotTrailer
	if got.Get("X-Sum") != "abc" || got.Get("X-New") != "v" {
		t.Errorf("allowed trailers missing: %v", got)
	}
	for k := range forged {
		if v := got.Get(k); v != "" {
			t.Errorf("trailer %s = %q reached the upstream", k, v)
		}
	}
	if got.Get("X-Old") != "" {
		t.Error("the rename was not applied to the trailer")
	}
}

// TestResponseTrailersFollowTheHeaderRules checks response trailers against the route's response
// transform and the hop-by-hop rules.
func TestResponseTrailersFollowTheHeaderRules(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Connection", "X-Conn-Listed")
		w.Header().Set("Trailer", "Server, X-Internal, X-Old, X-Conn-Listed, X-Request-Id, X-Sum")
		io.WriteString(w, "body")
		for _, k := range []string{"Server", "X-Internal", "X-Old", "X-Conn-Listed", "X-Request-Id", "X-Sum"} {
			w.Header().Set(k, "t-"+k)
		}
		w.Header().Set(http.TrailerPrefix+"X-Late", "late")
		w.Header().Set(http.TrailerPrefix+"Keep-Alive", "timeout=1")
		w.Header().Set(http.TrailerPrefix+"Content-Length", "99")
		w.Header().Set(http.TrailerPrefix+"Host", "evil.example")
	}))
	defer upstream.Close()
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	routes := `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"` + upstream.URL + `"}],
	  "transforms":{"response":{"remove":["Server","X-Internal"],"rename":{"X-Old":"X-New"}}}}]}`
	f := newFixture(t, routes, fixtureOptions{transport: transport})
	gw := httptest.NewServer(f.h)
	defer gw.Close()

	resp, err := gw.Client().Get(gw.URL + "/api/x")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	tr := resp.Trailer
	if string(body) != "body" || tr.Get("X-Sum") != "t-X-Sum" || tr.Get("X-New") != "t-X-Old" || tr.Get("X-Late") != "late" {
		t.Errorf("body %q, trailer %v", body, tr)
	}
	for _, k := range []string{"Server", "X-Internal", "X-Old", "X-Conn-Listed", "X-Request-Id", "Keep-Alive", "Content-Length", "Host"} {
		if v := tr.Get(k); v != "" {
			t.Errorf("trailer %s = %q reached the client", k, v)
		}
	}
}
