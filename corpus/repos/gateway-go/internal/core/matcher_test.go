package core

import (
	"errors"
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/config"
	"github.com/relaywork/gateway/internal/logging"
)

var t0 = time.Date(2025, time.June, 2, 12, 0, 0, 0, time.UTC)

// newRuntime returns a runtime on a manual clock with routes applied from a routes-file body.
func newRuntime(t *testing.T, routesJSON string) (*Runtime, *clock.Manual) {
	t.Helper()
	clk := clock.NewManual(t0)
	rt, err := NewRuntime(RuntimeOptions{Clock: clk, Logger: logging.Discard()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Close)
	if routesJSON != "" {
		apply(t, rt, routesJSON)
	}
	return rt, clk
}

func apply(t *testing.T, rt *Runtime, routesJSON string) {
	t.Helper()
	routes, err := config.ParseRoutes([]byte(routesJSON))
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.Apply(routes); err != nil {
		t.Fatal(err)
	}
}

const matchRoutes = `{"routes":[
  {"id":"root",        "path_prefix":"/",            "upstreams":[{"url":"http://root"}]},
  {"id":"api",         "path_prefix":"/api",         "upstreams":[{"url":"http://api"}]},
  {"id":"api-v2",      "path_prefix":"/api/v2/",     "upstreams":[{"url":"http://v2"}]},
  {"id":"users-get",   "path":"/api/users",          "methods":["GET","HEAD"], "upstreams":[{"url":"http://users"}]},
  {"id":"login",       "path":"/login",              "methods":["POST"], "upstreams":[{"url":"http://login"}]},
  {"id":"shop-api",    "host":"shop.example.com", "path_prefix":"/api", "upstreams":[{"url":"http://shop"}]},
  {"id":"shop-admin",  "host":"shop.example.com", "path":"/admin", "methods":["GET"], "upstreams":[{"url":"http://shop-admin"}]}
]}`

func TestMatchPrecedence(t *testing.T) {
	rt, _ := newRuntime(t, matchRoutes)
	table := rt.Table()
	cases := []struct {
		host, path, method, want string
	}{
		{"gw.example.com", "/", "GET", "root"},
		{"gw.example.com", "/apis", "GET", "root"}, // a prefix matches whole segments only
		{"gw.example.com", "/api", "GET", "api"},
		{"gw.example.com", "/api/orders/7", "DELETE", "api"},
		{"gw.example.com", "/api/v2", "GET", "api"}, // "/api/v2/" only matches below it
		{"gw.example.com", "/api/v2/items", "GET", "api-v2"},
		{"gw.example.com", "/api/users", "GET", "users-get"},      // exact beats prefix
		{"gw.example.com", "/api/users", "POST", "api"},           // the exact route does not take POST
		{"gw.example.com", "/api/users/1", "GET", "api"},          // exact means exact
		{"SHOP.Example.com:8443", "/api/cart", "GET", "shop-api"}, // host routes first; case and port ignored
		{"shop.example.com.", "/api", "PUT", "shop-api"},
		{"shop.example.com", "/admin", "POST", "root"}, // host route declines the method; host-less routes still apply
		{"shop.example.com", "/other", "GET", "root"},
		{"", "/api/x", "GET", "api"},
	}
	for _, c := range cases {
		r, err := table.Match(c.host, c.path, c.method)
		if err != nil {
			t.Errorf("Match(%q, %q, %s): %v", c.host, c.path, c.method, err)
			continue
		}
		if r.ID != c.want {
			t.Errorf("Match(%q, %q, %s) = %s, want %s", c.host, c.path, c.method, r.ID, c.want)
		}
	}
}

func TestMatchMethodNotAllowed(t *testing.T) {
	rt, _ := newRuntime(t, `{"routes":[
	  {"id":"a","path":"/x","methods":["GET"],"upstreams":[{"url":"http://a"}]},
	  {"id":"b","path":"/x","methods":["PUT","DELETE"],"upstreams":[{"url":"http://b"}]},
	  {"id":"c","path_prefix":"/x","methods":["GET"],"upstreams":[{"url":"http://c"}]}
	]}`)
	_, err := rt.Table().Match("h", "/x", "POST")
	var mna *MethodNotAllowedError
	if !errors.As(err, &mna) {
		t.Fatalf("err = %v, want MethodNotAllowedError", err)
	}
	if want := []string{"DELETE", "GET", "PUT"}; !slices.Equal(mna.Allow, want) {
		t.Errorf("Allow = %v, want %v", mna.Allow, want)
	}
	if r, err := rt.Table().Match("h", "/x", "DELETE"); err != nil || r.ID != "b" {
		t.Errorf("DELETE /x = %v, %v", r, err)
	}
}

func TestMatchNoRoute(t *testing.T) {
	rt, _ := newRuntime(t, `{"routes":[{"id":"a","path_prefix":"/a","upstreams":[{"url":"http://a"}]}]}`)
	if _, err := rt.Table().Match("h", "/b", "GET"); !errors.Is(err, ErrNoRoute) {
		t.Errorf("err = %v, want ErrNoRoute", err)
	}
	empty, _ := newRuntime(t, "")
	if _, err := empty.Table().Match("h", "/", "GET"); !errors.Is(err, ErrNoRoute) {
		t.Errorf("empty table: err = %v", err)
	}
}

func TestForwardPath(t *testing.T) {
	cases := []struct {
		prefix, request, wantPath, wantRaw string
		strip                              bool
	}{
		{"/api", "/api/orders", "/orders", "", true},
		{"/api", "/api", "", "", true},
		{"/api/", "/api/orders", "/orders", "", true},
		{"/", "/orders", "/orders", "", true},
		{"/api", "/api/orders", "/api/orders", "", false},
		{"/api", "/api/a%2Fb", "/a/b", "/a%2Fb", true},
		{"/café", "/caf%C3%A9/x%2Fy", "/x/y", "", true}, // prefix escaped differently in the raw path
		{"/api", "/api%2Fx", "/x", "", true},            // the prefix ends inside an escaped segment
	}
	for _, c := range cases {
		strip := "false"
		if c.strip {
			strip = "true"
		}
		rt, _ := newRuntime(t, `{"routes":[{"id":"a","path_prefix":"`+c.prefix+`","strip_prefix":`+strip+`,"upstreams":[{"url":"http://a"}]}]}`)
		r, _ := rt.Table().Route("a")
		u, err := url.Parse(c.request)
		if err != nil {
			t.Fatal(err)
		}
		p, raw := r.ForwardPath(u)
		if p != c.wantPath || raw != c.wantRaw {
			t.Errorf("prefix %q strip %v, request %q: ForwardPath = %q, %q; want %q, %q", c.prefix, c.strip, c.request, p, raw, c.wantPath, c.wantRaw)
		}
	}
}

func TestHeaderTransformApply(t *testing.T) {
	rt, _ := newRuntime(t, `{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://a"}],
	  "transforms":{"request":{"rename":{"X-Old":"X-New"},"remove":["X-Debug"],"add":{"X-Gateway":"edge","X-New":"override"}}}}]}`)
	r, _ := rt.Table().Route("a")
	h := map[string][]string{"X-Old": {"1", "2"}, "X-Debug": {"on"}, "X-Gateway": {"client"}, "Accept": {"*/*"}}
	r.Request.Apply(h)
	if _, ok := h["X-Old"]; ok {
		t.Error("renamed header still present")
	}
	if _, ok := h["X-Debug"]; ok {
		t.Error("removed header still present")
	}
	if got := h["X-New"]; len(got) != 1 || got[0] != "override" {
		t.Errorf("X-New = %v; add runs after rename and replaces", got)
	}
	if got := h["X-Gateway"]; len(got) != 1 || got[0] != "edge" {
		t.Errorf("X-Gateway = %v; add replaces client values", got)
	}
	if h["Accept"][0] != "*/*" {
		t.Error("untouched header changed")
	}
	if !r.Response.Empty() {
		t.Error("response transform should be empty")
	}
}
