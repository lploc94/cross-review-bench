// Package clock abstracts the passage of time so that rate-limit windows, breaker timers, health
// check intervals, key expiry and signature timestamps can be driven deterministically in tests.
package clock

import (
	"sort"
	"sync"
	"time"
)

// Clock tells the time and waits for it.
type Clock interface {
	// Now returns the current time.
	Now() time.Time
	// After returns a channel that receives the time once d has elapsed. A non-positive d fires
	// immediately.
	After(d time.Duration) <-chan time.Time
	// AfterFunc calls f in its own goroutine once d has elapsed, unless the returned timer is
	// stopped first.
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is a pending AfterFunc call.
type Timer interface {
	// Stop prevents the call from happening. It reports whether it did so, that is false when
	// the call already started or the timer was already stopped.
	Stop() bool
}

// Real is the wall clock.
type Real struct{}

// Now returns time.Now().
func (Real) Now() time.Time { return time.Now() }

// After returns time.After(d).
func (Real) After(d time.Duration) <-chan time.Time { return time.After(d) }

// AfterFunc returns time.AfterFunc(d, f).
func (Real) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }

// Manual is a clock that only moves when told to. Waiters registered through After and AfterFunc
// fire when Advance or Set moves the clock to or past their deadline.
type Manual struct {
	mu      sync.Mutex
	now     time.Time
	seq     uint64
	waiters []*waiter
	changed chan struct{} // closed and replaced whenever the set of waiters changes
}

type waiter struct {
	id       uint64
	deadline time.Time
	ch       chan time.Time // After
	fn       func()         // AfterFunc
}

// NewManual returns a manual clock set to start.
func NewManual(start time.Time) *Manual {
	return &Manual{now: start, changed: make(chan struct{})}
}

// Now returns the clock's current time.
func (m *Manual) Now() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.now
}

// After registers a waiter that fires once the clock reaches now+d.
func (m *Manual) After(d time.Duration) <-chan time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	ch := make(chan time.Time, 1)
	if d <= 0 {
		ch <- m.now
		return ch
	}
	m.addLocked(&waiter{deadline: m.now.Add(d), ch: ch})
	return ch
}

// AfterFunc registers f to run in its own goroutine once the clock reaches now+d.
func (m *Manual) AfterFunc(d time.Duration, f func()) Timer {
	m.mu.Lock()
	defer m.mu.Unlock()
	w := &waiter{deadline: m.now.Add(d), fn: f}
	if d <= 0 {
		go f()
		return &manualTimer{m: m, id: 0}
	}
	m.addLocked(w)
	return &manualTimer{m: m, id: w.id}
}

func (m *Manual) addLocked(w *waiter) {
	m.seq++
	w.id = m.seq
	m.waiters = append(m.waiters, w)
	m.notifyLocked()
}

type manualTimer struct {
	m  *Manual
	id uint64
}

func (t *manualTimer) Stop() bool {
	if t.id == 0 {
		return false
	}
	t.m.mu.Lock()
	defer t.m.mu.Unlock()
	for i, w := range t.m.waiters {
		if w.id == t.id {
			t.m.waiters = append(t.m.waiters[:i:i], t.m.waiters[i+1:]...)
			t.m.notifyLocked()
			return true
		}
	}
	return false
}

// Advance moves the clock forward by d and fires every waiter whose deadline has passed.
func (m *Manual) Advance(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.setLocked(m.now.Add(d))
}

// Set moves the clock to t, which must not be before the current time.
func (m *Manual) Set(t time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t.Before(m.now) {
		panic("clock: Manual.Set cannot move time backwards")
	}
	m.setLocked(t)
}

func (m *Manual) setLocked(t time.Time) {
	m.now = t
	sort.SliceStable(m.waiters, func(i, j int) bool { return m.waiters[i].deadline.Before(m.waiters[j].deadline) })
	fired := 0
	for _, w := range m.waiters {
		if w.deadline.After(t) {
			break
		}
		if w.fn != nil {
			go w.fn()
		} else {
			w.ch <- t
		}
		fired++
	}
	if fired > 0 {
		m.waiters = append(m.waiters[:0:0], m.waiters[fired:]...)
		m.notifyLocked()
	}
}

// Waiters returns the number of pending After and AfterFunc calls.
func (m *Manual) Waiters() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.waiters)
}

// BlockUntil waits until at least n After or AfterFunc calls are pending. Tests use it to make
// sure a loop is parked on the clock before they advance it.
func (m *Manual) BlockUntil(n int) {
	for {
		m.mu.Lock()
		if len(m.waiters) >= n {
			m.mu.Unlock()
			return
		}
		changed := m.changed
		m.mu.Unlock()
		<-changed
	}
}

func (m *Manual) notifyLocked() {
	close(m.changed)
	m.changed = make(chan struct{})
}
