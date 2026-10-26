package domain

import (
	"errors"
	"time"
)

// RetryPolicy decides when a failed attempt runs again.
type RetryPolicy interface {
	// NextRunAt returns when a job whose attempt number attempt (1-based) failed at failedAt
	// should run again. The caller decides separately whether the job has attempts left.
	NextRunAt(failedAt time.Time, attempt int) time.Time
}

// FixedDelay retries after the same delay every time.
type FixedDelay struct {
	Delay time.Duration
}

// NewFixedDelay returns a FixedDelay policy, rejecting negative delays.
func NewFixedDelay(d time.Duration) (FixedDelay, error) {
	if d < 0 {
		return FixedDelay{}, errors.New("retry delay must not be negative")
	}
	return FixedDelay{Delay: d}, nil
}

// NextRunAt returns failedAt plus the fixed delay.
func (p FixedDelay) NextRunAt(failedAt time.Time, _ int) time.Time {
	return failedAt.Add(p.Delay)
}
