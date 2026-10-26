package core

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/config"
	"github.com/relaywork/gateway/internal/logging"
	"github.com/relaywork/gateway/internal/metrics"
)

func routeOf(t *testing.T, rt *Runtime, id string) *Route {
	t.Helper()
	r, ok := rt.Table().Route(id)
	if !ok {
		t.Fatalf("route %q not in the table", id)
	}
	return r
}

func TestApplyKeepsBreakerWhenSettingsUnchanged(t *testing.T) {
	const breaker = `"circuit_breaker":{"failure_ratio":1,"min_requests":1,"window":1}`
	rt, _ := newRuntime(t, `{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://u1"},{"url":"http://u2"}],`+breaker+`}]}`)
	before := routeOf(t, rt, "a")
	tk, _ := before.Upstreams[0].Breaker.Allow()
	tk.Done(Failure)
	if before.Upstreams[0].Breaker.State() != Open {
		t.Fatal("breaker did not open")
	}

	// Same breaker settings, new weight and an extra route: the open breaker carries over.
	apply(t, rt, `{"routes":[
	  {"id":"a","path":"/a","upstreams":[{"url":"http://u1","weight":5},{"url":"http://u2"}],`+breaker+`},
	  {"id":"b","path":"/b","upstreams":[{"url":"http://u1"}]}]}`)
	after := routeOf(t, rt, "a")
	if after == before {
		t.Fatal("Apply reused the compiled route")
	}
	if after.Upstreams[0].Breaker != before.Upstreams[0].Breaker || after.Upstreams[0].Weight != 5 {
		t.Error("breaker state was lost although its settings did not change")
	}
	if routeOf(t, rt, "b").Upstreams[0].Breaker != nil {
		t.Error("route b has no breaker configured, and upstream state is per route")
	}

	// Changed settings: a fresh, closed breaker.
	apply(t, rt, `{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://u1"},{"url":"http://u2"}],
	  "circuit_breaker":{"failure_ratio":0.9,"min_requests":1,"window":1}}]}`)
	if b := routeOf(t, rt, "a").Upstreams[0].Breaker; b == before.Upstreams[0].Breaker || b.State() != Closed {
		t.Error("changed breaker settings kept the old breaker")
	}
}

func TestReloadRejectsInvalidFileAndKeepsTable(t *testing.T) {
	reg := metrics.NewRegistry()
	clk := clock.NewManual(t0)
	rt, err := NewRuntime(RuntimeOptions{Clock: clk, Logger: logging.Discard(), Metrics: reg})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()

	path := filepath.Join(t.TempDir(), "routes.json")
	write := func(s string) {
		if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://u1"}]}]}`)
	if err := rt.Reload(path); err != nil {
		t.Fatal(err)
	}
	live := rt.Table()

	write(`{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://u1"}]},{"id":"b","path":"/a","upstreams":[{"url":"http://u2"}]}]}`)
	err = rt.Reload(path)
	if err == nil || !strings.Contains(err.Error(), `route "b": path: matches the same requests as route "a"`) {
		t.Fatalf("Reload = %v, want the tie reported", err)
	}
	if rt.Table() != live {
		t.Error("an invalid file replaced the live table")
	}

	write(`{"routes":[`)
	if err := rt.Reload(path); err == nil || rt.Table() != live {
		t.Error("a truncated file replaced the live table")
	}
	write(`{"routes":[{"id":"c","path":"/c","upstreams":[{"url":"http://u3"}]}]}`)
	if err := rt.Reload(path); err != nil {
		t.Fatal(err)
	}
	if _, ok := rt.Table().Route("c"); !ok {
		t.Error("a valid file was not applied")
	}

	var out strings.Builder
	if err := reg.WriteText(&out); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`gateway_route_reloads_total{result="invalid"} 2`, `gateway_route_reloads_total{result="ok"} 2`, "gateway_routes 1"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("metrics lack %q:\n%s", want, out.String())
		}
	}
}

// healthServer answers the health path with the status in code.
func healthServer(t *testing.T, code *atomic.Int32, probes chan<- struct{}) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Errorf("health check requested %s", r.URL.Path)
		}
		w.WriteHeader(int(code.Load()))
		if probes != nil {
			probes <- struct{}{}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestHealthCheckerMarksUpstreamsAndRestartsOnChange(t *testing.T) {
	var code atomic.Int32
	code.Store(http.StatusServiceUnavailable)
	probes := make(chan struct{}, 16)
	srv := healthServer(t, &code, probes)

	reg := metrics.NewRegistry()
	clk := clock.NewManual(t0)
	rt, err := NewRuntime(RuntimeOptions{Clock: clk, Logger: logging.Discard(), Metrics: reg})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	routes := func(threshold int) *config.Routes {
		rs, err := config.ParseRoutes([]byte(`{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"` + srv.URL + `"}],
		  "health_check":{"path":"/healthz","interval":"5s","unhealthy_threshold":` + strconv.Itoa(threshold) + `,"healthy_threshold":1}}]}`))
		if err != nil {
			t.Fatal(err)
		}
		return rs
	}
	if err := rt.Apply(routes(2)); err != nil {
		t.Fatal(err)
	}
	u := routeOf(t, rt, "a").Upstreams[0]
	if !u.Healthy() {
		t.Fatal("a new upstream starts healthy")
	}
	// The checker probes at once, records the result, then waits on the clock: a waiter on
	// the clock means the probe has been recorded.
	<-probes
	clk.BlockUntil(1)
	if !u.Healthy() {
		t.Fatal("unhealthy after one failure with a threshold of two")
	}
	clk.Advance(5 * time.Second)
	<-probes
	clk.BlockUntil(1)
	if u.Healthy() {
		t.Fatal("still healthy after two failures")
	}
	if !gaugeIs(t, reg, `gateway_upstream_healthy{route="a",upstream="`+srv.URL+`"} 0`) {
		t.Error("health gauge not updated")
	}

	// Reapplying the same health settings keeps the checker and its verdict.
	if err := rt.Apply(routes(2)); err != nil {
		t.Fatal(err)
	}
	if routeOf(t, rt, "a").Upstreams[0].Healthy() {
		t.Fatal("reload with unchanged health settings reset the health")
	}

	// Changed settings: the old checker stops, a new one starts healthy and probes at once.
	code.Store(http.StatusOK)
	if err := rt.Apply(routes(3)); err != nil {
		t.Fatal(err)
	}
	if !routeOf(t, rt, "a").Upstreams[0].Healthy() {
		t.Error("new health settings start from healthy")
	}
	<-probes
	clk.BlockUntil(1)
	if !gaugeIs(t, reg, `gateway_upstream_healthy{route="a",upstream="`+srv.URL+`"} 1`) {
		t.Error("health gauge not reset for the new checker")
	}

	// Dropping the upstream stops its checker and removes its series.
	if err := rt.Apply(&config.Routes{}); err != nil {
		t.Fatal(err)
	}
	if gaugeIs(t, reg, `gateway_upstream_healthy{route="a"`) {
		t.Error("the removed upstream's health series is still exported")
	}
	clk.Advance(time.Hour)
	select {
	case <-probes:
		t.Error("the removed upstream is still probed")
	default:
	}
}

// gaugeIs reports whether the registry's exposition contains line.
func gaugeIs(t *testing.T, reg *metrics.Registry, line string) bool {
	t.Helper()
	var out strings.Builder
	if err := reg.WriteText(&out); err != nil {
		t.Fatal(err)
	}
	return strings.Contains(out.String(), line)
}

func TestCloseStopsCheckers(t *testing.T) {
	var code atomic.Int32
	code.Store(http.StatusOK)
	probes := make(chan struct{}, 16)
	srv := healthServer(t, &code, probes)
	rt, clk := newRuntime(t, `{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"`+srv.URL+`"}],"health_check":{"path":"/healthz","interval":"1s"}}]}`)
	<-probes
	clk.BlockUntil(1)
	rt.Close()
	clk.Advance(time.Hour)
	select {
	case <-probes:
		t.Error("a probe ran after Close")
	default:
	}
	if err := rt.Apply(&config.Routes{}); err == nil {
		t.Error("Apply after Close succeeded")
	}
}

func TestStatusReportsUpstreams(t *testing.T) {
	rt, _ := newRuntime(t, `{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://u1","weight":2}],"circuit_breaker":{}}]}`)
	st := routeOf(t, rt, "a").Status()
	if len(st) != 1 || st[0].URL != "http://u1" || st[0].Weight != 2 || !st[0].Healthy || st[0].Breaker != "closed" {
		t.Errorf("Status = %+v", st)
	}
}
