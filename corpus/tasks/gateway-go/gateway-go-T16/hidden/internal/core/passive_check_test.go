package core

import (
	"testing"
	"time"
)

// TestPassiveEjectionCheck covers the ejection after N failures, the return after the period,
// and the panic pick of an ejected or unhealthy upstream when none is left.
func TestPassiveEjectionCheck(t *testing.T) {
	rt, clk := newRuntime(t, `{"routes":[{"id":"p","path":"/p","upstreams":[{"url":"http://a"},{"url":"http://b"}],
	  "passive_health":{"consecutive_failures":3,"ejection":"1m","max_ejected_percent":50}}]}`)
	r := routeOf(t, rt, "p")
	a := r.Upstreams[0]

	a.Report(Failure)
	a.Report(Failure)
	if a.Ejected() {
		t.Fatal("ejected after two failures; the limit is three")
	}
	a.Report(Failure)
	if !a.Ejected() {
		t.Fatal("not ejected after three failures in a row")
	}
	clk.Advance(59 * time.Second)
	if !a.Ejected() {
		t.Fatal("returned before the ejection period ended")
	}
	clk.Advance(time.Second)
	if a.Ejected() {
		t.Fatal("still ejected after the ejection period")
	}

	a.Report(Failure)
	a.Report(Failure)
	a.Report(Failure)
	b := r.Upstreams[1]
	b.health.Set(false)
	if u := r.Next(nil); u != nil {
		t.Fatalf("Next picked %v; a is ejected and b unhealthy, so no upstream is left", u)
	}
	if u := r.NextAny(func(u *Upstream) bool { return u == b }); u != a {
		t.Fatalf("panic pick with b skipped: %v; the ejected upstream a should be used", u)
	}
	if u := r.NextAny(func(u *Upstream) bool { return u == a }); u != b {
		t.Fatalf("panic pick with a skipped: %v; the unhealthy upstream b should be used", u)
	}
}
