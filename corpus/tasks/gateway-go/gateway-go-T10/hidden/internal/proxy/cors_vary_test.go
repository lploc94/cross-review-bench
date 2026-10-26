package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestCORSResponsesVaryByOrigin checks that the responses of a route with a CORS policy say in
// Vary that they depend on the request's origin, next to the Vary fields the upstream sent, so
// that a shared cache does not serve one origin's answer to another. That holds for the answers
// without CORS fields too: a request from a disallowed origin, or without one, must not leave a
// cached answer that an allowed origin is then served.
func TestCORSResponsesVaryByOrigin(t *testing.T) {
	const routes = `{"routes":[{"id":"api","path_prefix":"/api","upstreams":[{"url":"http://up.test"}],
		"cors":{"allow_origins":["https://app.example.com"],"allow_methods":["GET"],"max_age":"5m"}}]}`
	tr := &fakeTransport{respond: func(n int, r *http.Request) (*http.Response, error) {
		return reply(r, 200, "[]", "Vary", "Accept-Encoding"), nil
	}}
	f := newFixture(t, routes, fixtureOptions{transport: tr})

	actual := httptest.NewRequest(http.MethodGet, "/api/orders", nil)
	actual.Header.Set("Origin", "https://app.example.com")
	w := f.do(actual)
	vary := strings.Join(w.Header().Values("Vary"), ", ")
	if !strings.Contains(vary, "Origin") {
		t.Errorf("Vary = %q on a response naming the origin, want Origin", vary)
	}
	if !strings.Contains(vary, "Accept-Encoding") {
		t.Errorf("Vary = %q; the upstream's Vary field must be kept", vary)
	}

	for _, origin := range []string{"", "https://evil.example"} {
		r := httptest.NewRequest(http.MethodGet, "/api/orders", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := f.do(r)
		if w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("origin %q was given an allow-origin field", origin)
		}
		if vary := strings.Join(w.Header().Values("Vary"), ", "); !strings.Contains(vary, "Origin") {
			t.Errorf("origin %q: Vary = %q on a response without CORS fields, want Origin", origin, vary)
		}
	}

	pre := httptest.NewRequest(http.MethodOptions, "/api/orders", nil)
	pre.Header.Set("Origin", "https://app.example.com")
	pre.Header.Set("Access-Control-Request-Method", "GET")
	pw := f.do(pre)
	if pw.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", pw.Code)
	}
	if pvary := strings.Join(pw.Header().Values("Vary"), ", "); !strings.Contains(pvary, "Origin") {
		t.Errorf("preflight Vary = %q, want Origin", pvary)
	}

	pre = httptest.NewRequest(http.MethodOptions, "/api/orders", nil)
	pre.Header.Set("Origin", "https://evil.example")
	pre.Header.Set("Access-Control-Request-Method", "GET")
	pw = f.do(pre)
	if pvary := strings.Join(pw.Header().Values("Vary"), ", "); !strings.Contains(pvary, "Origin") {
		t.Errorf("preflight from a disallowed origin: Vary = %q, want Origin", pvary)
	}
}
