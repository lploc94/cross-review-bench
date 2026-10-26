package worker

import (
	"testing"
	"time"
)

func TestLeaseBackoff(t *testing.T) {
	cases := []struct {
		poll     time.Duration
		failures int
		want     time.Duration
	}{
		{time.Second, 1, time.Second},
		{time.Second, 2, 2 * time.Second},
		{time.Second, 5, 16 * time.Second},
		{time.Second, 6, 30 * time.Second},
		{time.Second, 1000, 30 * time.Second},
		{time.Minute, 3, time.Minute}, // never shorter than the poll interval
	}
	for _, tc := range cases {
		if got := leaseBackoff(tc.poll, tc.failures); got != tc.want {
			t.Errorf("leaseBackoff(%s, %d) = %s, want %s", tc.poll, tc.failures, got, tc.want)
		}
	}
}
