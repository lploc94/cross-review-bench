package core

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestBalancerSmoothWeightedRoundRobin(t *testing.T) {
	a := &Upstream{Weight: 5, health: &Health{}}
	b := &Upstream{Weight: 1, health: &Health{}}
	c := &Upstream{Weight: 1, health: &Health{}}
	names := map[*Upstream]string{a: "a", b: "b", c: "c"}
	bal := NewBalancer([]*Upstream{a, b, c})
	var seq strings.Builder
	for range 7 {
		seq.WriteString(names[bal.Next(nil)])
	}
	// nginx's smooth weighted round-robin interleaves the light upstreams.
	if got := seq.String(); got != "aabacaa" {
		t.Errorf("sequence = %s, want aabacaa", got)
	}
}

func TestBalancerSkipsUnhealthyAndSkipped(t *testing.T) {
	a := &Upstream{Weight: 1, health: &Health{}}
	b := &Upstream{Weight: 1, health: &Health{}}
	bal := NewBalancer([]*Upstream{a, b})
	a.health.Set(false)
	for range 4 {
		if got := bal.Next(nil); got != b {
			t.Fatal("picked an unhealthy upstream")
		}
	}
	if got := bal.Next(func(u *Upstream) bool { return u == b }); got != nil {
		t.Errorf("Next = %v with every healthy upstream skipped, want nil", got)
	}
	a.health.Set(true)
	seen := map[*Upstream]int{}
	for range 4 {
		seen[bal.Next(nil)]++
	}
	if seen[a] != 2 || seen[b] != 2 {
		t.Errorf("after recovery: %v, want an even split", seen)
	}
}

func TestIsIdempotent(t *testing.T) {
	for _, m := range []string{http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodPut, http.MethodDelete} {
		if !IsIdempotent(m) {
			t.Errorf("%s is idempotent", m)
		}
	}
	for _, m := range []string{http.MethodPost, http.MethodPatch, "CONNECT", "get"} {
		if IsIdempotent(m) {
			t.Errorf("%s is not idempotent", m)
		}
	}
}

func TestRetryPolicyRetries(t *testing.T) {
	p := RetryPolicy{Attempts: 3, Statuses: map[int]bool{503: true}, Errors: map[ErrorClass]bool{ErrConnect: true}}
	if !p.Retries("GET") || !p.Retries("DELETE") || p.Retries("POST") || p.Retries("PATCH") {
		t.Error("only idempotent methods are retried by default")
	}
	p.NonIdempotent = true
	if !p.Retries("POST") {
		t.Error("NonIdempotent opts POST in")
	}
	if (RetryPolicy{Attempts: 1, NonIdempotent: true}).Retries("GET") {
		t.Error("a single attempt is no retry")
	}
	if !p.RetryStatus(503) || p.RetryStatus(500) || !p.RetryError(ErrConnect) || p.RetryError(ErrTimeout) {
		t.Error("RetryStatus/RetryError do not follow the policy")
	}
}

// fixedRand returns n-1 for Int64N(n): the top of the jitter range.
type fixedRand struct{ low bool }

func (f fixedRand) Int64N(n int64) int64 {
	if f.low {
		return 0
	}
	return n - 1
}

func TestRetryDelayBacksOffWithJitter(t *testing.T) {
	p := RetryPolicy{Attempts: 5, Backoff: 100 * time.Millisecond, MaxBackoff: 300 * time.Millisecond}
	cases := []struct {
		n         int
		low, high time.Duration
	}{
		{1, 50 * time.Millisecond, 100 * time.Millisecond},
		{2, 100 * time.Millisecond, 200 * time.Millisecond},
		{3, 150 * time.Millisecond, 300 * time.Millisecond}, // capped at MaxBackoff
		{9, 150 * time.Millisecond, 300 * time.Millisecond},
	}
	for _, c := range cases {
		if got := p.Delay(c.n, fixedRand{low: true}); got != c.low {
			t.Errorf("Delay(%d) low = %s, want %s", c.n, got, c.low)
		}
		if got := p.Delay(c.n, fixedRand{}); got != c.high {
			t.Errorf("Delay(%d) high = %s, want %s", c.n, got, c.high)
		}
	}
	if (RetryPolicy{}).Delay(1, fixedRand{}) != 0 {
		t.Error("no backoff configured, but a delay")
	}
}
