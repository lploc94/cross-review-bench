package worker_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/worker"
)

func TestPoolShutdownWaitsForCancelledHandlerToSettle(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	st := newFakeStore(domain.Job{ID: 1, Type: "slow"})
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"slow": func(ctx context.Context, _ domain.Job) error {
			close(started)
			<-ctx.Done()
			<-release // winding down takes a while after the cancellation
			return ctx.Err()
		},
	}), func(o *worker.Options) { o.Clock = clock.Real{} })
	h.start(t, context.Background())
	<-started

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the drain deadline has passed
	type result struct {
		err     error
		failed  int // Fail calls recorded when Shutdown returned
		settled int // OnSettled calls made when Shutdown returned
	}
	done := make(chan result, 1)
	go func() {
		err := h.pool.Shutdown(ctx)
		done <- result{err: err, failed: len(st.snapshot().failed), settled: len(h.outcomes)}
	}()

	// The handler is let go as soon as Shutdown returns, or after 3s. Shutdown that waits for
	// it returns only afterwards; the time only bounds how long the test waits.
	var r result
	select {
	case r = <-done:
		close(release)
	case <-time.After(3 * time.Second):
		close(release)
		select {
		case r = <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("Shutdown did not return after the handler did")
		}
	}
	if r.failed != 1 || r.settled != 1 {
		t.Fatalf("Shutdown returned with %d Fail calls and %d settled outcomes, want the cancelled attempt recorded first (1 and 1)", r.failed, r.settled)
	}
	if !errors.Is(r.err, context.Canceled) {
		t.Errorf("Shutdown = %v, want the context's error", r.err)
	}
	if out := h.next(t); !errors.Is(out.Err, context.Canceled) || out.State != domain.StateAvailable {
		t.Errorf("outcome = %+v, want the cancelled attempt retried", out)
	}
}
