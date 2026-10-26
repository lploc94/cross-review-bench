package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
)

func TestProgressOfAReapedAttemptIsRejected(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	job := mustEnqueue(t, s, domain.NewJob{})
	mustLease(t, s, "default", "old", 1)
	if err := s.ReportProgress(ctx, job.ID, "old", 30, "first attempt"); err != nil {
		t.Fatal(err)
	}

	clk.Advance(2 * time.Minute)
	if reaped, err := s.ReapExpired(ctx, clk.Now()); err != nil || len(reaped) != 1 {
		t.Fatalf("ReapExpired = %d jobs, %v", len(reaped), err)
	}
	if leased := mustLease(t, s, "default", "new", 1); len(leased) != 1 || leased[0].Progress != nil {
		t.Fatalf("second lease = %+v, want the job without progress", leased)
	}
	if err := s.ReportProgress(ctx, job.ID, "new", 5, "second attempt"); err != nil {
		t.Fatal(err)
	}
	if err := s.ReportProgress(ctx, job.ID, "old", 90, "first attempt"); !errors.Is(err, domain.ErrLeaseLost) {
		t.Fatalf("old worker's report = %v, want ErrLeaseLost", err)
	}
	got := mustGet(t, s, job.ID)
	if got.Progress == nil || got.Progress.Percent != 5 || got.Progress.Message != "second attempt" {
		t.Errorf("progress = %+v, want the second attempt's report", got.Progress)
	}
	if err := s.ReportProgress(ctx, job.ID+1000, "new", 5, ""); !errors.Is(err, domain.ErrLeaseLost) {
		t.Errorf("report for an unknown job = %v, want ErrLeaseLost", err)
	}
}

func TestProgressLimits(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()
	job := mustEnqueue(t, s, domain.NewJob{})
	mustLease(t, s, "default", "w", 1)

	for _, tc := range []struct {
		percent int
		message string
		ok      bool
	}{
		{0, "", true},
		{100, strings.Repeat("x", domain.MaxProgressMessageBytes), true},
		{100, strings.Repeat("x", domain.MaxProgressMessageBytes+1), false},
		{-5, "", false},
		{50, "line one\nline \"two\" ✓", true},
	} {
		err := s.ReportProgress(ctx, job.ID, "w", tc.percent, tc.message)
		var verr *domain.ValidationError
		if tc.ok && err != nil || !tc.ok && !errors.As(err, &verr) {
			t.Errorf("ReportProgress(%d, %d bytes) = %v, want ok=%v", tc.percent, len(tc.message), err, tc.ok)
			continue
		}
		if tc.ok {
			if got := mustGet(t, s, job.ID).Progress; got == nil || got.Percent != tc.percent || got.Message != tc.message {
				t.Errorf("stored progress = %+v, want %d %q", got, tc.percent, tc.message)
			}
		}
	}
}
