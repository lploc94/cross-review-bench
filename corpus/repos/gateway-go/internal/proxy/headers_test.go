package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/relaywork/gateway/internal/auth"
	"github.com/relaywork/gateway/internal/model"
)

const oneRoute = `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"http://up.internal"}]}]}`

func TestHopByHopHeadersAreRemovedBothWays(t *testing.T) {
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		return reply(r, 200, "ok",
			"Connection", "X-Upstream-Conn",
			"X-Upstream-Conn", "secret-ish",
			"Keep-Alive", "timeout=5",
			"Proxy-Authenticate", "Basic",
			"Transfer-Encoding", "chunked",
			"Upgrade", "h2c",
			"X-Kept", "yes"), nil
	}}
	f := newFixture(t, oneRoute, fixtureOptions{transport: tr})

	r := httptest.NewRequest("GET", "/api/x", nil)
	r.Header.Set("Connection", "keep-alive, X-Client-Conn")
	r.Header.Set("X-Client-Conn", "1")
	r.Header.Set("Keep-Alive", "timeout=5")
	r.Header.Set("Te", "trailers")
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Proxy-Authorization", "Basic Zm9vOmJhcg==")
	r.Header.Set("Proxy-Connection", "keep-alive")
	r.Header.Set("X-Kept", "yes")
	w := f.do(r)
	if w.Code != 200 {
		t.Fatalf("status = %d", w.Code)
	}

	out := tr.sent()[0].header
	for _, name := range []string{"Connection", "X-Client-Conn", "Keep-Alive", "Te", "Upgrade", "Proxy-Authorization", "Proxy-Connection"} {
		if v, ok := out[name]; ok {
			t.Errorf("forwarded %s: %q", name, v)
		}
	}
	if out.Get("X-Kept") != "yes" {
		t.Error("an end-to-end request header was dropped")
	}
	for _, name := range []string{"Connection", "X-Upstream-Conn", "Keep-Alive", "Proxy-Authenticate", "Transfer-Encoding", "Upgrade"} {
		if v, ok := w.Header()[name]; ok {
			t.Errorf("relayed %s: %q", name, v)
		}
	}
	if w.Header().Get("X-Kept") != "yes" {
		t.Error("an end-to-end response header was dropped")
	}
}

func TestForwardedHeadersFromUntrustedPeerAreReplaced(t *testing.T) {
	tr := statusTransport(200)
	f := newFixture(t, oneRoute, fixtureOptions{transport: tr, trusted: []string{"10.0.0.0/8"}})
	r := httptest.NewRequest("GET", "http://gw.example.com/api/x", nil)
	r.RemoteAddr = "198.51.100.9:4711"
	r.Header.Set("X-Forwarded-For", "127.0.0.1")
	r.Header.Set("X-Forwarded-Proto", "https")
	r.Header.Set("X-Forwarded-Host", "admin.internal")
	r.Header.Set("Forwarded", "for=127.0.0.1")
	f.do(r)

	out := tr.sent()[0].header
	if got := out.Get("X-Forwarded-For"); got != "198.51.100.9" {
		t.Errorf("X-Forwarded-For = %q, want the peer only", got)
	}
	if got := out.Get("X-Forwarded-Proto"); got != "http" {
		t.Errorf("X-Forwarded-Proto = %q, want http", got)
	}
	if got := out.Get("X-Forwarded-Host"); got != "gw.example.com" {
		t.Errorf("X-Forwarded-Host = %q, want the request host", got)
	}
	if got := out.Get("Forwarded"); got != "" {
		t.Errorf("Forwarded = %q, want none", got)
	}
}

func TestForwardedHeadersFromTrustedProxyAreExtended(t *testing.T) {
	tr := statusTransport(200)
	lim := &fakeLimiter{decide: allowAll}
	routes := `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"http://up.internal"}],
	  "rate_limit":{"requests":10,"window":"1m"}}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr, limiter: lim, trusted: []string{"10.0.0.0/8", "::ffff:0:0/96"}})

	r := httptest.NewRequest("GET", "http://lb.internal/api/x", nil)
	r.RemoteAddr = "10.0.0.1:4711"
	r.Header.Add("X-Forwarded-For", "192.0.2.66, 203.0.113.7")
	r.Header.Add("X-Forwarded-For", "10.1.2.3")
	r.Header.Set("X-Forwarded-Proto", "HTTPS")
	r.Header.Set("X-Forwarded-Host", "shop.example.com")
	f.do(r)

	out := tr.sent()[0].header
	if got := out.Get("X-Forwarded-For"); got != "192.0.2.66, 203.0.113.7, 10.1.2.3, 10.0.0.1" {
		t.Errorf("X-Forwarded-For = %q", got)
	}
	if out.Get("X-Forwarded-Proto") != "https" || out.Get("X-Forwarded-Host") != "shop.example.com" {
		t.Errorf("proto %q, host %q", out.Get("X-Forwarded-Proto"), out.Get("X-Forwarded-Host"))
	}
	// The client is the first address from the right that no trusted proxy vouches for;
	// 192.0.2.66 could have been forged by that client.
	if got := lim.keys[0]; got != "api/ip:203.0.113.7" {
		t.Errorf("rate limit key = %q", got)
	}
}

func TestResolveClient(t *testing.T) {
	trusted := trustedProxies{netip.MustParsePrefix("10.0.0.0/8")}
	cases := []struct {
		name, remote, xff, wantIP string
	}{
		{"untrusted peer", "192.0.2.1:1", "203.0.113.7", "192.0.2.1"},
		{"trusted peer, no header", "10.0.0.1:1", "", "10.0.0.1"},
		{"all hops trusted", "10.0.0.1:1", "10.0.0.2, 10.0.0.3", "10.0.0.2"},
		{"garbage beyond the trusted hops", "10.0.0.1:1", "nonsense, 10.0.0.2", "10.0.0.2"},
		{"mapped IPv4 peer", "[::ffff:10.0.0.1]:1", "203.0.113.7", "203.0.113.7"},
		{"unparsable peer", "pipe", "203.0.113.7", "pipe"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = c.remote
			if c.xff != "" {
				r.Header.Set("X-Forwarded-For", c.xff)
			}
			if got := trusted.resolveClient(r).ip; got != c.wantIP {
				t.Errorf("client ip = %q, want %q", got, c.wantIP)
			}
		})
	}
}

func TestRequestID(t *testing.T) {
	tr := statusTransport(200)
	f := newFixture(t, oneRoute, fixtureOptions{transport: tr})

	r := httptest.NewRequest("GET", "/api/x", nil)
	r.Header.Set("X-Request-Id", "trace-42.a:b")
	w := f.do(r)
	if got := tr.sent()[0].header.Get("X-Request-Id"); got != "trace-42.a:b" || w.Header().Get("X-Request-Id") != got {
		t.Errorf("a well-formed id was not kept: upstream %q, response %q", got, w.Header().Get("X-Request-Id"))
	}

	for _, bad := range [][]string{{"has space"}, {strings.Repeat("a", 129)}, {"a", "b"}, {""}} {
		r := httptest.NewRequest("GET", "/api/x", nil)
		r.Header["X-Request-Id"] = bad
		w := f.do(r)
		got := w.Header().Get("X-Request-Id")
		if len(got) != 32 {
			t.Errorf("request id for %q = %q, want a generated one", bad, got)
		}
	}
	calls := tr.sent()
	if calls[1].header.Get("X-Request-Id") == calls[2].header.Get("X-Request-Id") {
		t.Error("generated ids repeat")
	}
}

func TestConsumerHeaderCannotBeSpoofed(t *testing.T) {
	tr := statusTransport(200)
	consumer := model.Consumer{ID: "c_0123456789abcdef", Name: "svc", Enabled: true}
	routes := `{"routes":[
	  {"id":"open","path_prefix":"/open","upstreams":[{"url":"http://up.internal"}]},
	  {"id":"keyed","path_prefix":"/keyed","auth":"api_key","upstreams":[{"url":"http://up.internal"}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr, auth: auth.Modes{"api_key": &fakeAuth{consumer: consumer}}})

	r := httptest.NewRequest("GET", "/open/x", nil)
	r.Header.Set("X-Consumer-Id", "c_ffffffffffffffff")
	f.do(r)
	r = httptest.NewRequest("GET", "/keyed/x", nil)
	r.Header.Set("X-Consumer-Id", "c_ffffffffffffffff")
	r.Header.Set("X-Api-Key", "gk_secret")
	r.Header.Set("Authorization", "Bearer gk_secret")
	f.do(r)

	calls := tr.sent()
	if v, ok := calls[0].header["X-Consumer-Id"]; ok {
		t.Errorf("unauthenticated route forwarded X-Consumer-Id %q", v)
	}
	if got := calls[1].header.Values("X-Consumer-Id"); len(got) != 1 || got[0] != consumer.ID {
		t.Errorf("X-Consumer-Id = %q, want the authenticated consumer", got)
	}
	for _, name := range []string{"X-Api-Key", "Authorization"} {
		if v := calls[1].header.Get(name); v != "" {
			t.Errorf("credential header %s forwarded: %q", name, v)
		}
	}
	if strings.Contains(f.logs.String(), "gk_secret") {
		t.Error("the access log contains the credential")
	}
}

func TestOutboundRequestShape(t *testing.T) {
	tr := statusTransport(200)
	routes := `{"routes":[
	  {"id":"strip","path_prefix":"/api","strip_prefix":true,"upstreams":[{"url":"http://up.internal:8081/base/"}]},
	  {"id":"keep","path_prefix":"/keep","upstreams":[{"url":"http://up.internal:8081"}]}]}`
	f := newFixture(t, routes, fixtureOptions{transport: tr})

	f.do(httptest.NewRequest("POST", "http://gw.example.com/api/orders/a%2Fb?b=2&a=1&a=1", strings.NewReader("payload")))
	f.do(httptest.NewRequest("GET", "/api", nil))
	r := httptest.NewRequest("GET", "/keep/x", nil)
	r.URL.ForceQuery, r.URL.Fragment = true, "frag"
	f.do(r)
	r = httptest.NewRequest("GET", "/keep/ua", nil)
	r.Header.Set("User-Agent", "client/1.0")
	f.do(r)

	calls := tr.sent()
	first := calls[0]
	if first.url != "http://up.internal:8081/base/orders/a%2Fb?b=2&a=1&a=1" {
		t.Errorf("url = %q", first.url)
	}
	if first.host != "up.internal:8081" || first.method != "POST" || first.body != "payload" || first.length != 7 {
		t.Errorf("host %q, method %q, body %q, length %d", first.host, first.method, first.body, first.length)
	}
	if v, ok := first.header["User-Agent"]; !ok || len(v) != 1 || v[0] != "" {
		t.Errorf("User-Agent = %q; the transport's own must not be sent", v)
	}
	if calls[1].url != "http://up.internal:8081/base/" {
		t.Errorf("stripped to nothing: url = %q", calls[1].url)
	}
	if calls[2].url != "http://up.internal:8081/keep/x" {
		t.Errorf("url = %q, want no query marker or fragment", calls[2].url)
	}
	if got := calls[3].header.Get("User-Agent"); got != "client/1.0" {
		t.Errorf("User-Agent = %q, want the client's", got)
	}
}

func TestHeaderTransforms(t *testing.T) {
	tr := &fakeTransport{respond: func(_ int, r *http.Request) (*http.Response, error) {
		return reply(r, 200, "ok", "Server", "upstream/1.2", "X-Internal-Trace", "t-1", "X-Old", "v"), nil
	}}
	routes := `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"http://up.internal"}],
	  "transforms":{
	    "request":{"add":{"X-Env":"prod","X-Tenant":"acme"},"remove":["x-debug"],"rename":{"X-Client-Ver":"X-Version"}},
	    "response":{"remove":["Server","X-Internal-Trace"],"rename":{"X-Old":"X-New"},"add":{"X-Request-Id":"spoofed"}}}}]}`
	if _, err := tryFixture(t, routes, fixtureOptions{transport: tr}); err == nil {
		t.Fatal("a response transform that sets X-Request-Id was accepted")
	}
	routes = strings.Replace(routes, `,"add":{"X-Request-Id":"spoofed"}`, `,"add":{"Cache-Control":"private"}`, 1)
	f, err := tryFixture(t, routes, fixtureOptions{transport: tr})
	if err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest("GET", "/api/x", nil)
	r.Header.Set("X-Debug", "1")
	r.Header.Set("X-Client-Ver", "7")
	r.Header.Set("X-Tenant", "evil")
	w := f.do(r)

	out := tr.sent()[0].header
	if out.Get("X-Env") != "prod" || out.Values("X-Tenant")[0] != "acme" || len(out.Values("X-Tenant")) != 1 {
		t.Errorf("added: X-Env %q, X-Tenant %q", out.Get("X-Env"), out.Values("X-Tenant"))
	}
	if out.Get("X-Debug") != "" || out.Get("X-Client-Ver") != "" || out.Get("X-Version") != "7" {
		t.Errorf("remove/rename: %v", out)
	}
	h := w.Header()
	if h.Get("Server") != "" || h.Get("X-Internal-Trace") != "" || h.Get("X-Old") != "" || h.Get("X-New") != "v" || h.Get("Cache-Control") != "private" {
		t.Errorf("response header = %v", h)
	}
}

// TestClientAddressHeadersOnlyFromTrustedProxies checks X-Real-Ip and X-Forwarded-Port, which
// upstreams commonly read as the client's address and port: an untrusted client cannot set them.
func TestClientAddressHeadersOnlyFromTrustedProxies(t *testing.T) {
	tr := statusTransport(200)
	f := newFixture(t, oneRoute, fixtureOptions{transport: tr, trusted: []string{"10.0.0.0/8"}})
	for _, remote := range []string{"198.51.100.9:4711", "10.0.0.1:4711"} {
		r := httptest.NewRequest("GET", "/api/x", nil)
		r.RemoteAddr = remote
		r.Header.Set("X-Real-Ip", "127.0.0.1")
		r.Header.Set("X-Forwarded-Port", "443")
		f.do(r)
	}
	calls := tr.sent()
	for _, name := range []string{"X-Real-Ip", "X-Forwarded-Port"} {
		if v := calls[0].header.Get(name); v != "" {
			t.Errorf("untrusted peer: %s = %q forwarded", name, v)
		}
	}
	if calls[1].header.Get("X-Real-Ip") != "127.0.0.1" || calls[1].header.Get("X-Forwarded-Port") != "443" {
		t.Errorf("trusted proxy: header %v", calls[1].header)
	}
}
