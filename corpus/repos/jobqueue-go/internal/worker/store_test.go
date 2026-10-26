package worker_test

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/logging"
	"github.com/relaywork/jobqueue/internal/store"
	"github.com/relaywork/jobqueue/internal/testdb"
	"github.com/relaywork/jobqueue/internal/worker"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) { os.Exit(testdb.Run(m, &testPool)) }

// newStoreHarness runs a pool against the real store, sharing the harness's manual clock.
func newStoreHarness(t *testing.T, reg *worker.Registry) (*harness, *store.Store) {
	t.Helper()
	db := testdb.Require(t, testPool)
	clk := clock.NewManual(t0)
	st := store.New(db, clk)
	return newHarnessWithClock(t, clk, st, reg), st
}

func TestPoolWithStoreRetriesThenDeadLetters(t *testing.T) {
	reg := registry(map[string]worker.HandlerFunc{
		"flaky": func(context.Context, domain.Job) error { return errors.New("connection refused") },
	})
	h, st := newStoreHarness(t, reg)
	ctx := context.Background()
	job, err := st.Enqueue(ctx, domain.NewJob{Queue: "default", Type: "flaky", MaxAttempts: 2})
	if err != nil {
		t.Fatal(err)
	}
	h.start(t, ctx)

	if out := h.next(t); out.State != domain.StateAvailable {
		t.Fatalf("first attempt outcome = %+v, want a retry", out)
	}
	got, _ := st.Get(ctx, job.ID)
	if !got.RunAt.Equal(t0.Add(retryDelay)) || got.Attempts != 1 {
		t.Fatalf("after first attempt: %+v", got)
	}

	h.clock.BlockUntil(1) // the worker is idle until the retry is due
	h.clock.Advance(retryDelay)
	if out := h.next(t); out.State != domain.StateDead {
		t.Fatalf("second attempt outcome = %+v, want dead", out)
	}
	got, _ = st.Get(ctx, job.ID)
	if got.State != domain.StateDead || got.Attempts != 2 || got.LastError != "connection refused" {
		t.Errorf("dead job = %+v", got)
	}
	page, err := st.ListDead(ctx, "default", 0, 10)
	if err != nil || len(page.Jobs) != 1 {
		t.Errorf("ListDead = %d jobs, %v", len(page.Jobs), err)
	}
}

func TestReaperHandsAbandonedJobToAnotherWorker(t *testing.T) {
	reg := registry(map[string]worker.HandlerFunc{"ok": func(context.Context, domain.Job) error { return nil }})
	h, st := newStoreHarness(t, reg)
	ctx := context.Background()
	job, err := st.Enqueue(ctx, domain.NewJob{Queue: "default", Type: "ok"})
	if err != nil {
		t.Fatal(err)
	}
	// A worker of some other process leases the job and dies without settling it.
	if _, err := st.Lease(ctx, "default", "crashed/default/0", 1, time.Minute); err != nil {
		t.Fatal(err)
	}
	h.start(t, ctx)
	h.clock.BlockUntil(1)

	h.clock.Advance(2 * time.Minute)
	reaper, err := worker.NewReaper(st, store.ReapBatchSize, time.Minute, h.clock, logging.Discard(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := reaper.ReapOnce(ctx); err != nil || n != 1 {
		t.Fatalf("ReapOnce = %d, %v; want 1", n, err)
	}
	h.clock.BlockUntil(1)
	h.clock.Advance(time.Second)

	out := h.next(t)
	if out.Job.ID != job.ID || out.State != domain.StateSucceeded || out.Job.Attempts != 2 {
		t.Fatalf("outcome = %+v, want job %d succeeded on attempt 2", out, job.ID)
	}
	if err := st.Complete(ctx, job.ID, "crashed/default/0"); !errors.Is(err, domain.ErrLeaseLost) {
		t.Errorf("crashed worker's Complete = %v, want ErrLeaseLost", err)
	}
}
