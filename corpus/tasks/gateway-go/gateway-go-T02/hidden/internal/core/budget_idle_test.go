package core

import (
	"testing"
	"time"
)

// TestRetryBudgetIdleSecondsLeaveTheWindow checks that the counts of a second stop counting once
// the second has left the window, after a long idle and after a shorter gap.
func TestRetryBudgetIdleSecondsLeaveTheWindow(t *testing.T) {
	start := time.Date(2025, time.June, 2, 12, 0, 0, 0, time.UTC)
	allowed := func(b *RetryBudget, at time.Time) int {
		n := 0
		for b.AllowRetry(at) {
			n++
		}
		return n
	}

	// Idle for longer than the 10s window: the retries of start no longer count.
	b := NewRetryBudget(0.5, 1, 10*time.Second)
	if got := allowed(b, start); got != 10 {
		t.Fatalf("retries at start = %d, want 10", got)
	}
	later := start.Add(11 * time.Second)
	b.Request(later)
	if got := allowed(b, later); got != 11 {
		t.Errorf("after 11s idle: %d retries allowed, want 11", got)
	}

	// A gap of 7s: the requests after it are in the window, the retries of start are not.
	b = NewRetryBudget(0.5, 1, 10*time.Second)
	allowed(b, start)
	b.Request(start.Add(7 * time.Second))
	later = start.Add(11 * time.Second)
	b.Request(later)
	if got := allowed(b, later); got != 11 {
		t.Errorf("after a 7s gap: %d retries allowed, want 11", got)
	}
}
