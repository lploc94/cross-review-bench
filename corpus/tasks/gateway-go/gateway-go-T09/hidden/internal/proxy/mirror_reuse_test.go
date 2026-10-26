package proxy

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestMirrorReusesShadowConnections checks that copies sent one after another to the shadow
// upstream share one keep-alive connection: the shadow's answer, a success or a 5xx, is thrown
// away, but its connection goes back to the transport's pool instead of being torn down after
// every copy.
func TestMirrorReusesShadowConnections(t *testing.T) {
	var conns, answers atomic.Int32
	shadow := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if answers.Add(1)%2 == 0 {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_, _ = io.WriteString(w, strings.Repeat("s", 4096))
	}))
	shadow.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			conns.Add(1)
		}
	}
	shadow.Start()
	t.Cleanup(shadow.Close)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "upstream")
	}))
	t.Cleanup(up.Close)
	f := newFixture(t, `{"routes":[{"id":"a","path_prefix":"/","upstreams":[{"url":"`+up.URL+`"}],
		"mirror":{"url":"`+shadow.URL+`","percent":100}}]}`, fixtureOptions{transport: &http.Transport{}})

	const copies = 5
	for i := 1; i <= copies; i++ {
		if w := f.get("/x"); w.Code != http.StatusOK || w.Body.String() != "upstream" {
			t.Fatalf("client got %d %q", w.Code, w.Body.String())
		}
		// The next copy starts once this one is done with the shadow's answer.
		deadline := time.Now().Add(10 * time.Second)
		for len(f.h.mirrorSlots) != 0 {
			if time.Now().After(deadline) {
				t.Fatalf("copy %d did not finish", i)
			}
			time.Sleep(time.Millisecond)
		}
	}
	if n := conns.Load(); n != 1 {
		t.Fatalf("the shadow saw %d connections for %d copies sent one after another; want one, reused", n, copies)
	}
}
