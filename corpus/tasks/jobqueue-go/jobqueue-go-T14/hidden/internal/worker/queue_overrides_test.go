package worker_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/worker"
)

func TestPoolOverrideWithoutDefaultWorkers(t *testing.T) {
	started := make(chan string, 4)
	release := make(chan struct{})
	st := newFakeStore(domain.Job{ID: 1, Queue: "billing", Type: "block"}, domain.Job{ID: 2, Queue: "billing", Type: "block"})
	overrides := map[string]int{"billing": 2}
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"block": func(ctx context.Context, _ domain.Job) error {
			started <- worker.WorkerID(ctx)
			<-release
			return nil
		},
	}), func(o *worker.Options) {
		o.Queues = []string{"mail", "billing"}
		o.Concurrency = 0
		o.QueueConcurrency = overrides
	})
	overrides["billing"] = 1 // changing the caller's map after NewPool has no effect
	overrides["mail"] = 5
	h.start(t, context.Background())

	seen := map[string]bool{}
	for range 2 {
		select {
		case id := <-started:
			seen[id] = true
		case <-time.After(10 * time.Second):
			t.Fatalf("both billing jobs did not run at once; started %v", seen)
		}
	}
	close(release)
	if !seen["test/billing/0"] || !seen["test/billing/1"] {
		t.Errorf("workers = %v", seen)
	}
	h.next(t)
	h.next(t)

	var buf strings.Builder
	_ = h.metrics.WriteText(&buf)
	for _, line := range []string{`jobqueue_workers{queue="billing"} 2`, `jobqueue_workers{queue="mail"} 0`} {
		if !strings.Contains(buf.String(), line) {
			t.Errorf("metrics lack %s:\n%s", line, buf.String())
		}
	}
}
