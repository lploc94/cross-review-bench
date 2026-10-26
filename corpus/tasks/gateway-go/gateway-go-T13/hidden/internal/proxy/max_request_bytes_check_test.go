package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestRouteRequestLimitCheck covers max_request_bytes: declared and chunked oversize bodies,
// and bodies exactly at the limit.
func TestRouteRequestLimitCheck(t *testing.T) {
	const routes = `{"routes":[{"id":"upload","path_prefix":"/upload","upstreams":[{"url":"http://up.test"}],
	  "max_request_bytes":16,"retry":{"attempts":3,"non_idempotent":true}}]}`
	exact := strings.Repeat("e", 16)

	t.Run("declared oversize never reaches the upstream", func(t *testing.T) {
		f := newFixture(t, routes, fixtureOptions{})
		w := f.do(httptest.NewRequest(http.MethodPost, "/upload/x", strings.NewReader(strings.Repeat("d", 17))))
		if w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "body_too_large") {
			t.Fatalf("status %d, body %s; want 413 body_too_large", w.Code, w.Body.String())
		}
	})

	t.Run("chunked oversize is cut off and sent once", func(t *testing.T) {
		tr := statusTransport(503, 200)
		f := newFixture(t, routes, fixtureOptions{transport: tr})
		r := httptest.NewRequest(http.MethodPost, "/upload/x", strings.NewReader(strings.Repeat("c", 17)))
		r.ContentLength = -1
		w := f.do(r)
		if w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "body_too_large") {
			t.Fatalf("status %d, body %s; want 413 body_too_large", w.Code, w.Body.String())
		}
		if n := len(tr.sent()); n > 1 {
			t.Fatalf("upstream attempts %d; want at most 1", n)
		}
	})

	t.Run("exact limit passes, declared and chunked", func(t *testing.T) {
		tr := statusTransport(200)
		f := newFixture(t, routes, fixtureOptions{transport: tr})
		if w := f.do(httptest.NewRequest(http.MethodPost, "/upload/x", strings.NewReader(exact))); w.Code != http.StatusOK {
			t.Fatalf("declared exact limit: status %d", w.Code)
		}
		r := httptest.NewRequest(http.MethodPost, "/upload/x", strings.NewReader(exact))
		r.ContentLength = -1
		if w := f.do(r); w.Code != http.StatusOK {
			t.Fatalf("chunked exact limit: status %d", w.Code)
		}
		for i, c := range tr.sent() {
			if c.body != exact {
				t.Fatalf("request %d reached the upstream as %q", i+1, c.body)
			}
		}
	})
}
