package worker_test

import (
	"context"
	"errors"
	"testing"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/store"
	"github.com/relaywork/jobqueue/internal/testdb"
	"github.com/relaywork/jobqueue/internal/worker"
)

// With the real store, the attempt IsFinalAttempt marks is exactly the one after which the
// store moves the job to dead, and OnExhausted fires once, for that attempt.
func TestFinalAttemptAgreesWithStore(t *testing.T) {
	db := testdb.Require(t, testPool)
	clk := clock.NewManual(t0)
	st := store.New(db, clk)
	var finals []bool // written by the worker goroutine, read after each outcome
	exhausted := make(chan worker.Outcome, 3)
	reg := registry(map[string]worker.HandlerFunc{
		"flaky": func(ctx context.Context, _ domain.Job) error {
			finals = append(finals, worker.IsFinalAttempt(ctx))
			return errors.New("connection refused")
		},
	})
	h := newHarnessWithClock(t, clk, st, reg, func(o *worker.Options) {
		o.OnExhausted = func(out worker.Outcome) { exhausted <- out }
	})
	ctx := context.Background()
	job, err := st.Enqueue(ctx, domain.NewJob{Queue: "default", Type: "flaky", MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	h.start(t, ctx)

	for attempt := 1; attempt <= 3; attempt++ {
		if attempt > 1 {
			h.clock.BlockUntil(1) // idle until the retry is due
			h.clock.Advance(retryDelay)
		}
		out := h.next(t)
		wantState := domain.StateAvailable
		if attempt == 3 {
			wantState = domain.StateDead
		}
		if out.Job.ID != job.ID || out.Job.Attempts != attempt || out.State != wantState {
			t.Fatalf("attempt %d: outcome = %+v, want job %d in state %s", attempt, out, job.ID, wantState)
		}
		if got, want := finals[attempt-1], attempt == 3; got != want {
			t.Errorf("attempt %d/3: IsFinalAttempt = %v, want %v", attempt, got, want)
		}
		if got := len(exhausted); attempt < 3 && got != 0 {
			t.Errorf("attempt %d/3: OnExhausted called while attempts were left", attempt)
		}
	}
	if len(exhausted) != 1 {
		t.Fatalf("OnExhausted called %d times, want once", len(exhausted))
	}
	if out := <-exhausted; out.Job.ID != job.ID || out.State != domain.StateDead {
		t.Errorf("OnExhausted outcome = %+v", out)
	}
	got, err := st.Get(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != domain.StateDead || got.Attempts != 3 {
		t.Errorf("job after three failures = %s with %d attempts, want dead with 3", got.State, got.Attempts)
	}
}
