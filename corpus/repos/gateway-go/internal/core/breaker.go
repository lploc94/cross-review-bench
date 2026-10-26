package core

import (
	"errors"
	"sync"
	"time"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/config"
)

// ErrCircuitOpen reports that a circuit breaker rejected a request without calling the upstream.
var ErrCircuitOpen = errors.New("circuit breaker is open")

// BreakerState is the state of a circuit breaker.
type BreakerState int

// Breaker states. The numeric values are exported as the breaker state gauge.
const (
	Closed   BreakerState = 0
	Open     BreakerState = 1
	HalfOpen BreakerState = 2
)

func (s BreakerState) String() string {
	switch s {
	case Closed:
		return "closed"
	case Open:
		return "open"
	case HalfOpen:
		return "half_open"
	}
	return "unknown"
}

// BreakerPolicy configures a circuit breaker.
type BreakerPolicy struct {
	FailureRatio   float64       // open when this share of the window failed...
	MinRequests    int           // ...and the window holds at least this many outcomes
	Window         int           // the number of most recent outcomes considered
	OpenDuration   time.Duration // how long the breaker stays open before probing
	HalfOpenProbes int           // successful probes needed to close again
}

func breakerPolicy(c config.CircuitBreaker) BreakerPolicy {
	return BreakerPolicy{
		FailureRatio:   c.FailureRatio,
		MinRequests:    c.MinRequests,
		Window:         c.Window,
		OpenDuration:   c.OpenDuration.D(),
		HalfOpenProbes: c.HalfOpenProbes,
	}
}

// Outcome is how an admitted request ended, as far as the breaker is concerned.
type Outcome int

const (
	// Success means the upstream answered without a server error.
	Success Outcome = iota
	// Failure means the upstream could not be reached, timed out or answered 5xx.
	Failure
	// Ignored means the request ended for reasons that say nothing about the upstream, for
	// example the client went away. It releases a half-open probe without counting.
	Ignored
)

// Breaker is a circuit breaker for one upstream of one route.
//
// Closed, it admits every request and records the outcomes of the last Window of them; once at
// least MinRequests are recorded and FailureRatio of them failed, it opens. Open, it rejects
// every request until OpenDuration has passed, then turns half-open. Half-open, it admits up to
// HalfOpenProbes requests at a time; when that many have succeeded it closes, and the first
// failure opens it again.
//
// Each state change starts a new generation. An outcome reported for a request admitted in an
// earlier generation is ignored: a slow request admitted while closed must not close a breaker
// that has since opened, nor use up a half-open probe.
type Breaker struct {
	policy   BreakerPolicy
	clock    clock.Clock
	onChange func(from, to BreakerState)

	mu         sync.Mutex
	state      BreakerState
	generation uint64
	openedAt   time.Time
	// closed state: a ring of the last policy.Window outcomes
	outcomes []bool // true for a failure
	next     int
	count    int
	failures int
	// half-open state
	probesInFlight int
	probeSuccesses int
}

// NewBreaker returns a closed breaker. onChange, if not nil, is called with every state change
// while the breaker's lock is held, so calls arrive in order; it must be quick and must not
// call the breaker.
func NewBreaker(p BreakerPolicy, clk clock.Clock, onChange func(from, to BreakerState)) *Breaker {
	return &Breaker{policy: p, clock: clk, onChange: onChange, outcomes: make([]bool, p.Window)}
}

// Ticket is the permission to send one request. Report how it went with Done exactly once.
// The zero Ticket, returned by a nil *Breaker, does nothing.
type Ticket struct {
	b          *Breaker
	generation uint64
	probe      bool
}

// Allow asks to send a request. It returns ErrCircuitOpen when the breaker is open, or half-open
// with all its probes in flight. A nil *Breaker allows everything.
func (b *Breaker) Allow() (Ticket, error) {
	if b == nil {
		return Ticket{}, nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.state {
	case Closed:
		return Ticket{b: b, generation: b.generation}, nil
	case Open:
		if b.clock.Now().Before(b.openedAt.Add(b.policy.OpenDuration)) {
			return Ticket{}, ErrCircuitOpen
		}
		b.transitionLocked(HalfOpen)
	}
	// Half-open: admit a probe while successes plus probes in flight leave room for it.
	if b.probesInFlight+b.probeSuccesses >= b.policy.HalfOpenProbes {
		return Ticket{}, ErrCircuitOpen
	}
	b.probesInFlight++
	return Ticket{b: b, generation: b.generation, probe: true}, nil
}

// Done reports the outcome of the request the ticket admitted.
func (t Ticket) Done(o Outcome) {
	if t.b == nil {
		return
	}
	t.b.done(t, o)
}

func (b *Breaker) done(t Ticket, o Outcome) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if t.generation != b.generation {
		return // admitted before the last state change; says nothing about the current state
	}
	switch b.state {
	case Closed:
		if o == Ignored {
			return
		}
		b.recordLocked(o == Failure)
		if b.count >= b.policy.MinRequests && float64(b.failures)/float64(b.count) >= b.policy.FailureRatio {
			b.transitionLocked(Open)
		}
	case HalfOpen:
		if !t.probe {
			return
		}
		b.probesInFlight--
		switch o {
		case Failure:
			b.transitionLocked(Open)
		case Success:
			b.probeSuccesses++
			if b.probeSuccesses >= b.policy.HalfOpenProbes {
				b.transitionLocked(Closed)
			}
		}
	}
}

// recordLocked adds one outcome to the closed-state window, dropping the oldest when full.
func (b *Breaker) recordLocked(failed bool) {
	if b.count == len(b.outcomes) {
		if b.outcomes[b.next] {
			b.failures--
		}
	} else {
		b.count++
	}
	b.outcomes[b.next] = failed
	if failed {
		b.failures++
	}
	b.next = (b.next + 1) % len(b.outcomes)
}

func (b *Breaker) transitionLocked(to BreakerState) {
	from := b.state
	b.state = to
	b.generation++
	b.probesInFlight, b.probeSuccesses = 0, 0
	switch to {
	case Open:
		b.openedAt = b.clock.Now()
	case Closed:
		clear(b.outcomes)
		b.next, b.count, b.failures = 0, 0, 0
	}
	if b.onChange != nil && from != to {
		b.onChange(from, to)
	}
}

// State returns the current state. An open breaker whose open duration has passed reports Open
// until the next request turns it half-open.
func (b *Breaker) State() BreakerState {
	if b == nil {
		return Closed
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state
}

// Policy returns the breaker's settings.
func (b *Breaker) Policy() BreakerPolicy { return b.policy }
