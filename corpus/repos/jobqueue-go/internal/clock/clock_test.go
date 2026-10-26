package clock

import (
	"testing"
	"time"
)

var t0 = time.Date(2025, time.March, 10, 9, 0, 0, 0, time.UTC)

func fired(ch <-chan time.Time) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func TestManualAdvanceFiresDueWaiters(t *testing.T) {
	m := NewManual(t0)
	short := m.After(time.Second)
	long := m.After(time.Minute)
	if m.Waiters() != 2 {
		t.Fatalf("Waiters = %d, want 2", m.Waiters())
	}

	m.Advance(time.Second)
	if !fired(short) || fired(long) {
		t.Fatal("after 1s: want only the 1s waiter fired")
	}
	if !m.Now().Equal(t0.Add(time.Second)) {
		t.Errorf("Now = %s", m.Now())
	}

	m.Advance(time.Hour)
	select {
	case got := <-long:
		if !got.Equal(t0.Add(time.Second + time.Hour)) {
			t.Errorf("waiter received %s, want the new time", got)
		}
	default:
		t.Fatal("1m waiter did not fire")
	}
	if m.Waiters() != 0 {
		t.Errorf("Waiters = %d after all fired", m.Waiters())
	}
}

func TestManualAfterNonPositiveFiresImmediately(t *testing.T) {
	m := NewManual(t0)
	if !fired(m.After(0)) || !fired(m.After(-time.Second)) {
		t.Error("After(<=0) did not fire immediately")
	}
	if m.Waiters() != 0 {
		t.Errorf("Waiters = %d", m.Waiters())
	}
}

func TestManualSet(t *testing.T) {
	m := NewManual(t0)
	ch := m.After(time.Hour)
	m.Set(t0.Add(2 * time.Hour))
	if !fired(ch) {
		t.Error("Set past the deadline did not fire the waiter")
	}
	defer func() {
		if recover() == nil {
			t.Error("Set backwards did not panic")
		}
	}()
	m.Set(t0)
}

func TestManualBlockUntil(t *testing.T) {
	m := NewManual(t0)
	registered := make(chan struct{})
	go func() {
		m.After(time.Minute)
		m.After(time.Minute)
		close(registered)
	}()
	m.BlockUntil(2)
	<-registered
	if m.Waiters() != 2 {
		t.Errorf("Waiters = %d after BlockUntil(2)", m.Waiters())
	}
}

func TestRealClock(t *testing.T) {
	var c Clock = Real{}
	before := time.Now()
	if c.Now().Before(before) {
		t.Error("Real.Now is in the past")
	}
	if !fired(waitFor(c.After(0))) {
		t.Error("Real.After(0) did not fire")
	}
}

// waitFor blocks until ch delivers and returns a channel that is ready.
func waitFor(ch <-chan time.Time) <-chan time.Time {
	out := make(chan time.Time, 1)
	out <- <-ch
	return out
}
