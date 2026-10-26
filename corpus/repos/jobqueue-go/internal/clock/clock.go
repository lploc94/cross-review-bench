// Package clock abstracts the passage of time so that leasing, retries, schedules and the
// background loops can be driven deterministically in tests.
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
}

// Real is the wall clock.
type Real struct{}

// Now returns time.Now().
func (Real) Now() time.Time { return time.Now() }

// After returns time.After(d).
func (Real) After(d time.Duration) <-chan time.Time { return time.After(d) }

// Manual is a clock that only moves when told to. Waiters registered through After fire when
// Advance or Set moves the clock to or past their deadline.
type Manual struct {
	mu      sync.Mutex
	now     time.Time
	waiters []waiter
	changed chan struct{} // closed and replaced whenever the set of waiters changes
}

type waiter struct {
	deadline time.Time
	ch       chan time.Time
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
	m.waiters = append(m.waiters, waiter{deadline: m.now.Add(d), ch: ch})
	m.notifyLocked()
	return ch
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
		w.ch <- t
		fired++
	}
	if fired > 0 {
		m.waiters = append(m.waiters[:0:0], m.waiters[fired:]...)
		m.notifyLocked()
	}
}

// Waiters returns the number of pending After calls.
func (m *Manual) Waiters() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.waiters)
}

// BlockUntil waits until at least n After calls are pending. Tests use it to make sure a loop is
// parked on the clock before they advance it.
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
