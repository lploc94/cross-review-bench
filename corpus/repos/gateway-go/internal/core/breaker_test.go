package core

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/clock"
)

type transition struct{ from, to BreakerState }

func newTestBreaker(p BreakerPolicy) (*Breaker, *clock.Manual, *[]transition) {
	clk := clock.NewManual(t0)
	var changes []transition
	b := NewBreaker(p, clk, func(from, to BreakerState) { changes = append(changes, transition{from, to}) })
	return b, clk, &changes
}

func mustAllow(t *testing.T, b *Breaker) Ticket {
	t.Helper()
	tk, err := b.Allow()
	if err != nil {
		t.Fatalf("Allow in state %s: %v", b.State(), err)
	}
	return tk
}

func TestBreakerOpensAtFailureRatio(t *testing.T) {
	b, _, changes := newTestBreaker(BreakerPolicy{FailureRatio: 0.5, MinRequests: 4, Window: 4, OpenDuration: time.Minute, HalfOpenProbes: 1})
	// Three outcomes, all failures: below MinRequests, still closed.
	for range 3 {
		mustAllow(t, b).Done(Failure)
	}
	if b.State() != Closed {
		t.Fatalf("opened before MinRequests outcomes")
	}
	mustAllow(t, b).Done(Success) // 3 of 4 failed
	if b.State() != Open {
		t.Fatalf("state = %s, want open at 75%% failures", b.State())
	}
	if _, err := b.Allow(); !errors.Is(err, ErrCircuitOpen) {
		t.Errorf("Allow while open: %v", err)
	}
	if len(*changes) != 1 || (*changes)[0] != (transition{Closed, Open}) {
		t.Errorf("changes = %v", *changes)
	}
}

func TestBreakerStaysClosedBelowRatio(t *testing.T) {
	b, _, _ := newTestBreaker(BreakerPolicy{FailureRatio: 0.3, MinRequests: 10, Window: 10, OpenDuration: time.Minute, HalfOpenProbes: 1})
	for i := range 10 {
		o := Success
		if i < 2 {
			o = Failure
		}
		mustAllow(t, b).Done(o)
	}
	if b.State() != Closed {
		t.Fatal("opened at 20% failures with a 30% ratio")
	}
	// The window rolls: the two failures fall out, then three new ones arrive.
	for range 2 {
		mustAllow(t, b).Done(Success)
	}
	for range 2 {
		mustAllow(t, b).Done(Failure)
	}
	if b.State() != Closed {
		t.Fatal("opened at 20% failures of the rolling window")
	}
	mustAllow(t, b).Done(Failure) // 3 of the last 10: exactly the ratio
	if b.State() != Open {
		t.Fatalf("state = %s; a ratio equal to the threshold must open", b.State())
	}
}

func TestBreakerIgnoredOutcomesDoNotCount(t *testing.T) {
	b, _, _ := newTestBreaker(BreakerPolicy{FailureRatio: 0.5, MinRequests: 2, Window: 2, OpenDuration: time.Minute, HalfOpenProbes: 1})
	mustAllow(t, b).Done(Failure)
	mustAllow(t, b).Done(Ignored)
	if b.State() != Closed {
		t.Fatal("an ignored outcome was counted")
	}
}

func TestBreakerHalfOpenProbes(t *testing.T) {
	b, clk, changes := newTestBreaker(BreakerPolicy{FailureRatio: 1, MinRequests: 1, Window: 1, OpenDuration: 30 * time.Second, HalfOpenProbes: 2})
	mustAllow(t, b).Done(Failure)
	clk.Advance(30*time.Second - time.Millisecond)
	if _, err := b.Allow(); !errors.Is(err, ErrCircuitOpen) {
		t.Fatal("admitted before the open duration passed")
	}
	clk.Advance(time.Millisecond)

	p1 := mustAllow(t, b)
	p2 := mustAllow(t, b)
	if b.State() != HalfOpen {
		t.Fatalf("state = %s", b.State())
	}
	if _, err := b.Allow(); !errors.Is(err, ErrCircuitOpen) {
		t.Fatal("admitted a third probe with two allowed")
	}
	p1.Done(Ignored) // frees its slot without counting
	p3 := mustAllow(t, b)
	p2.Done(Success)
	if b.State() != HalfOpen {
		t.Fatal("closed after one of two successful probes")
	}
	if _, err := b.Allow(); !errors.Is(err, ErrCircuitOpen) {
		t.Fatal("admitted a probe beyond the successes still needed")
	}
	p3.Done(Success)
	if b.State() != Closed {
		t.Fatalf("state = %s after two successful probes", b.State())
	}
	want := []transition{{Closed, Open}, {Open, HalfOpen}, {HalfOpen, Closed}}
	if len(*changes) != len(want) {
		t.Fatalf("changes = %v", *changes)
	}
	for i := range want {
		if (*changes)[i] != want[i] {
			t.Errorf("change %d = %v, want %v", i, (*changes)[i], want[i])
		}
	}
	// Closed again with a fresh window: one failure opens it again (Window 1, ratio 1).
	mustAllow(t, b).Done(Success)
	if b.State() != Closed {
		t.Fatal("success reopened the breaker")
	}
}

func TestBreakerHalfOpenFailureReopens(t *testing.T) {
	b, clk, _ := newTestBreaker(BreakerPolicy{FailureRatio: 1, MinRequests: 1, Window: 1, OpenDuration: 10 * time.Second, HalfOpenProbes: 3})
	mustAllow(t, b).Done(Failure)
	clk.Advance(10 * time.Second)
	p1 := mustAllow(t, b)
	p2 := mustAllow(t, b)
	p1.Done(Failure)
	if b.State() != Open {
		t.Fatalf("state = %s after a failed probe", b.State())
	}
	// The other probe finishing late belongs to the old half-open period.
	p2.Done(Success)
	if b.State() != Open {
		t.Fatal("a probe from the previous half-open period changed the state")
	}
	// The open period restarted when the probe failed.
	clk.Advance(9 * time.Second)
	if _, err := b.Allow(); !errors.Is(err, ErrCircuitOpen) {
		t.Fatal("the open period did not restart")
	}
}

func TestBreakerStaleTicketsAreIgnored(t *testing.T) {
	b, clk, _ := newTestBreaker(BreakerPolicy{FailureRatio: 0.5, MinRequests: 2, Window: 2, OpenDuration: time.Second, HalfOpenProbes: 1})
	slow := mustAllow(t, b) // admitted while closed, finishes much later
	mustAllow(t, b).Done(Failure)
	mustAllow(t, b).Done(Failure)
	if b.State() != Open {
		t.Fatal("did not open")
	}
	clk.Advance(time.Second)
	probe := mustAllow(t, b)
	slow.Done(Success) // must not close the half-open breaker nor use the probe's slot
	if b.State() != HalfOpen {
		t.Fatalf("state = %s; a ticket from the closed period changed the half-open state", b.State())
	}
	probe.Done(Success)
	if b.State() != Closed {
		t.Fatalf("state = %s after the probe succeeded", b.State())
	}
}

func TestNilBreakerAllowsEverything(t *testing.T) {
	var b *Breaker
	tk, err := b.Allow()
	if err != nil {
		t.Fatal(err)
	}
	tk.Done(Failure) // must not panic
	if b.State() != Closed {
		t.Error("nil breaker is not closed")
	}
}

// TestBreakerConcurrentProbes lets many goroutines race for the half-open probes: exactly the
// configured number may get through.
func TestBreakerConcurrentProbes(t *testing.T) {
	const probes, racers = 3, 64
	b, clk, _ := newTestBreaker(BreakerPolicy{FailureRatio: 1, MinRequests: 1, Window: 1, OpenDuration: time.Second, HalfOpenProbes: probes})
	mustAllow(t, b).Done(Failure)
	clk.Advance(time.Second)

	start := make(chan struct{})
	tickets := make(chan Ticket, racers)
	var wg sync.WaitGroup
	for range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if tk, err := b.Allow(); err == nil {
				tickets <- tk
			}
		}()
	}
	close(start)
	wg.Wait()
	close(tickets)
	var admitted []Ticket
	for tk := range tickets {
		admitted = append(admitted, tk)
	}
	if len(admitted) != probes {
		t.Fatalf("%d requests admitted while half-open, want %d", len(admitted), probes)
	}
	var done sync.WaitGroup
	for _, tk := range admitted {
		done.Add(1)
		go func() {
			defer done.Done()
			tk.Done(Success)
		}()
	}
	done.Wait()
	if b.State() != Closed {
		t.Fatalf("state = %s after all probes succeeded", b.State())
	}
}

// TestBreakerConcurrentOutcomes records outcomes from many goroutines; the window never counts
// more outcomes than it holds and the breaker opens exactly once.
func TestBreakerConcurrentOutcomes(t *testing.T) {
	var mu sync.Mutex
	opened := 0
	clk := clock.NewManual(t0)
	b := NewBreaker(BreakerPolicy{FailureRatio: 0.5, MinRequests: 50, Window: 100, OpenDuration: time.Hour, HalfOpenProbes: 1}, clk,
		func(_, to BreakerState) {
			if to == Open {
				mu.Lock()
				opened++
				mu.Unlock()
			}
		})
	start := make(chan struct{})
	var wg sync.WaitGroup
	for range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if tk, err := b.Allow(); err == nil {
				tk.Done(Failure)
			}
		}()
	}
	close(start)
	wg.Wait()
	if b.State() != Open || opened != 1 {
		t.Errorf("state = %s, opened %d times; want open once", b.State(), opened)
	}
}
