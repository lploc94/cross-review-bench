package worker_test

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/worker"
)

// leaseStore is the fake store with the real store's lease check (store.ExtendLease): renewing
// the lease of a job that is not running under this worker fails with domain.ErrLeaseLost. Every
// call is recorded, as it is a round trip to the database.
type leaseStore struct{ *fakeStore }

func (s leaseStore) ExtendLease(ctx context.Context, id int64, workerID string, until time.Time) error {
	if err := s.fakeStore.ExtendLease(ctx, id, workerID, until); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if j, ok := s.running[id]; !ok || j.LockedBy != workerID {
		return fmt.Errorf("extend lease of job %d as %s: %w", id, workerID, domain.ErrLeaseLost)
	}
	return nil
}

// renewalLoops counts the goroutines that are inside the pool's lease renewal loop.
func renewalLoops() int {
	buf := make([]byte, 1<<20)
	n := runtime.Stack(buf, true)
	return strings.Count(string(buf[:n]), "worker.(*Pool).renewLease(")
}

func TestPoolRenewalEndsWhenJobSettles(t *testing.T) {
	st := leaseStore{newFakeStore(domain.Job{ID: 1, Type: "ok"}, domain.Job{ID: 2, Type: "ok"})}
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"ok": func(context.Context, domain.Job) error { return nil },
	}))
	h.start(t, context.Background())
	for range 2 {
		if out := h.next(t); out.State != domain.StateSucceeded {
			t.Fatalf("outcome = %+v", out)
		}
	}

	// Once a job has settled nothing renews its lease any more. The loop only polls for the
	// renewal goroutines to finish; it never decides the result by timing.
	deadline := time.Now().Add(5 * time.Second)
	for renewalLoops() > 0 {
		if time.Now().After(deadline) {
			t.Fatalf("%d lease renewal loops still running 5s after their jobs settled", renewalLoops())
		}
		time.Sleep(5 * time.Millisecond)
	}

	// The store refuses renewals of settled jobs; none may even be attempted.
	for range 6 {
		h.clock.BlockUntil(1)
		h.clock.Advance(20 * time.Second)
	}
	h.clock.BlockUntil(1)
	if ext := st.snapshot().extended; len(ext) != 0 {
		t.Errorf("ExtendLease calls after the jobs settled: %+v", ext)
	}
}

func TestPoolRenewalEndsWhenSettleFails(t *testing.T) {
	// Recording the outcome fails (the database is briefly unreachable), so the job is still
	// running under this worker in the store. Its lease has to run out, so that the reaper can
	// hand the job out again.
	st := leaseStore{newFakeStore(domain.Job{ID: 1, Type: "ok"})}
	st.settleErr = errDatabaseDown
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"ok": func(context.Context, domain.Job) error { return nil },
	}))
	h.start(t, context.Background())
	if out := h.next(t); out.SettleErr == nil {
		t.Fatalf("outcome = %+v, want a settle error", out)
	}

	// Give the attempt's renewal loop time to notice that the attempt is over (it does at once
	// when it does at all), then let several renewal intervals pass.
	deadline := time.Now().Add(5 * time.Second)
	for renewalLoops() > 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	for range 6 {
		h.clock.BlockUntil(1)
		h.clock.Advance(20 * time.Second)
	}
	h.clock.BlockUntil(1)
	ext := st.snapshot().extended
	if loops := renewalLoops(); loops > 0 || len(ext) != 0 {
		t.Errorf("after the attempt ended, %d lease renewal loops still run and the lease was renewed %d times: the job is never handed out again", loops, len(ext))
	}
}
