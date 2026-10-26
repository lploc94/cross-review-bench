package worker_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/logging"
	"github.com/relaywork/jobqueue/internal/worker"
)

// fakeReapStore hands out the given batches, one per call, then empty ones.
type fakeReapStore struct {
	mu      sync.Mutex
	batches [][]domain.Job
	calls   []time.Time
}

func (f *fakeReapStore) ReapExpired(_ context.Context, now time.Time) ([]domain.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, now)
	if len(f.batches) == 0 {
		return nil, nil
	}
	b := f.batches[0]
	f.batches = f.batches[1:]
	return b, nil
}

func (f *fakeReapStore) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func jobsInState(n int, st domain.State) []domain.Job {
	out := make([]domain.Job, n)
	for i := range out {
		out[i] = domain.Job{ID: int64(i + 1), Queue: "default", State: st}
	}
	return out
}

func TestReapOnceDrainsFullBatches(t *testing.T) {
	st := &fakeReapStore{batches: [][]domain.Job{
		jobsInState(2, domain.StateAvailable),
		jobsInState(2, domain.StateDead),
		jobsInState(1, domain.StateAvailable),
	}}
	r, err := worker.NewReaper(st, 2, time.Minute, clock.NewManual(t0), logging.Discard(), nil)
	if err != nil {
		t.Fatal(err)
	}
	n, err := r.ReapOnce(context.Background())
	if err != nil || n != 5 {
		t.Fatalf("ReapOnce = %d, %v; want 5", n, err)
	}
	if got := st.callCount(); got != 3 {
		t.Errorf("store called %d times, want 3 (stop after the partial batch)", got)
	}
}

func TestReaperRunsEveryInterval(t *testing.T) {
	st := &fakeReapStore{}
	clk := clock.NewManual(t0)
	r, err := worker.NewReaper(st, 10, time.Minute, clk, logging.Discard(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()

	clk.BlockUntil(1)
	if got := st.callCount(); got != 1 {
		t.Fatalf("calls after start = %d, want 1", got)
	}
	clk.Advance(time.Minute)
	clk.BlockUntil(1)
	if got := st.callCount(); got != 2 {
		t.Fatalf("calls after one interval = %d, want 2", got)
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("Run returned %v after cancel, want nil", err)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if !st.calls[1].Equal(t0.Add(time.Minute)) {
		t.Errorf("second pass used now = %s, want %s", st.calls[1], t0.Add(time.Minute))
	}
}

func TestNewReaperValidates(t *testing.T) {
	if _, err := worker.NewReaper(&fakeReapStore{}, 0, time.Minute, clock.Real{}, logging.Discard(), nil); err == nil {
		t.Error("zero batch size accepted")
	}
	if _, err := worker.NewReaper(&fakeReapStore{}, 1, 0, clock.Real{}, logging.Discard(), nil); err == nil {
		t.Error("zero interval accepted")
	}
}
