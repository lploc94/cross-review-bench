package worker_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/logging"
	"github.com/relaywork/jobqueue/internal/metrics"
	"github.com/relaywork/jobqueue/internal/worker"
)

var t0 = time.Date(2025, time.March, 10, 9, 0, 0, 0, time.UTC)

const retryDelay = 30 * time.Second

type harness struct {
	clock    *clock.Manual
	pool     *worker.Pool
	metrics  *metrics.Registry
	outcomes chan worker.Outcome
}

func newHarness(t *testing.T, st worker.Store, reg *worker.Registry, mutate ...func(*worker.Options)) *harness {
	t.Helper()
	return newHarnessWithClock(t, clock.NewManual(t0), st, reg, mutate...)
}

func newHarnessWithClock(t *testing.T, clk *clock.Manual, st worker.Store, reg *worker.Registry, mutate ...func(*worker.Options)) *harness {
	t.Helper()
	h := &harness{clock: clk, metrics: metrics.NewRegistry(), outcomes: make(chan worker.Outcome, 100)}
	opts := worker.Options{
		ID:            "test",
		Queues:        []string{"default"},
		Concurrency:   1,
		PollInterval:  time.Second,
		LeaseDuration: time.Minute,
		Retry:         domain.FixedDelay{Delay: retryDelay},
		Clock:         h.clock,
		Logger:        logging.Discard(),
		Metrics:       h.metrics,
		OnSettled:     func(o worker.Outcome) { h.outcomes <- o },
	}
	for _, m := range mutate {
		m(&opts)
	}
	pool, err := worker.NewPool(st, reg, opts)
	if err != nil {
		t.Fatal(err)
	}
	h.pool = pool
	return h
}

func (h *harness) start(t *testing.T, ctx context.Context) {
	t.Helper()
	if err := h.pool.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.pool.Stop)
}

// next waits for the next settled outcome. The timeout only turns a hang into a failure.
func (h *harness) next(t *testing.T) worker.Outcome {
	t.Helper()
	select {
	case o := <-h.outcomes:
		return o
	case <-time.After(10 * time.Second):
		t.Fatal("no job outcome within 10s")
		return worker.Outcome{}
	}
}

func registry(handlers map[string]worker.HandlerFunc) *worker.Registry {
	reg := worker.NewRegistry(time.Minute)
	for typ, fn := range handlers {
		reg.Register(typ, fn)
	}
	return reg
}

func TestPoolCompletesSuccessfulJob(t *testing.T) {
	st := newFakeStore(domain.Job{ID: 1, Type: "ok"})
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{"ok": func(context.Context, domain.Job) error { return nil }}))
	h.start(t, context.Background())

	out := h.next(t)
	if out.Err != nil || out.SettleErr != nil || out.State != domain.StateSucceeded || out.WorkerID != "test/default/0" {
		t.Fatalf("outcome = %+v", out)
	}
	if got := st.snapshot().completed; len(got) != 1 || got[0] != 1 {
		t.Errorf("completed = %v, want [1]", got)
	}
}

func TestPoolFailsAttemptWithRetryDelay(t *testing.T) {
	st := newFakeStore(domain.Job{ID: 7, Type: "flaky"})
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"flaky": func(context.Context, domain.Job) error { return errors.New("upstream unavailable") },
	}))
	h.start(t, context.Background())

	out := h.next(t)
	if out.State != domain.StateAvailable || out.Err == nil {
		t.Fatalf("outcome = %+v, want the job back to available", out)
	}
	failed := st.snapshot().failed
	if len(failed) != 1 || failed[0].msg != "upstream unavailable" || !failed[0].retryAt.Equal(t0.Add(retryDelay)) {
		t.Errorf("Fail calls = %+v, want one at now+%s", failed, retryDelay)
	}
}

func TestPoolMovesExhaustedJobToDead(t *testing.T) {
	st := newFakeStore(domain.Job{ID: 1, Type: "flaky", Attempts: 2, MaxAttempts: 3})
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"flaky": func(context.Context, domain.Job) error { return errors.New("still failing") },
	}))
	h.start(t, context.Background())

	if out := h.next(t); out.State != domain.StateDead {
		t.Fatalf("outcome state = %s, want dead", out.State)
	}
}

func TestPoolDiscardsPermanentFailure(t *testing.T) {
	st := newFakeStore(domain.Job{ID: 1, Type: "strict"})
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"strict": func(context.Context, domain.Job) error {
			return domain.Permanent(errors.New("payload has no recipient"))
		},
	}))
	h.start(t, context.Background())

	if out := h.next(t); out.State != domain.StateFailed {
		t.Fatalf("outcome state = %s, want failed", out.State)
	}
	c := st.snapshot()
	if len(c.discarded) != 1 || c.discarded[0].msg != "payload has no recipient" || len(c.failed) != 0 {
		t.Errorf("discarded %+v, failed %+v", c.discarded, c.failed)
	}
}

func TestPoolRecoversFromPanic(t *testing.T) {
	st := newFakeStore(domain.Job{ID: 1, Type: "explode"}, domain.Job{ID: 2, Type: "ok"})
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"explode": func(context.Context, domain.Job) error { panic("index out of range") },
		"ok":      func(context.Context, domain.Job) error { return nil },
	}))
	h.start(t, context.Background())

	first := h.next(t)
	var perr *worker.PanicError
	if !errors.As(first.Err, &perr) || len(perr.Stack) == 0 {
		t.Fatalf("outcome error = %v, want a PanicError with a stack", first.Err)
	}
	if failed := st.snapshot().failed; len(failed) != 1 || failed[0].msg != "panic: index out of range" {
		t.Errorf("Fail calls = %+v", failed)
	}
	if second := h.next(t); second.Job.ID != 2 || second.State != domain.StateSucceeded {
		t.Errorf("worker did not carry on after the panic: %+v", second)
	}
}

func TestPoolTimesOutHandler(t *testing.T) {
	st := newFakeStore(domain.Job{ID: 1, Type: "slow"})
	reg := worker.NewRegistry(time.Minute)
	reg.Register("slow", func(ctx context.Context, _ domain.Job) error {
		<-ctx.Done()
		return ctx.Err()
	}, worker.WithTimeout(20*time.Millisecond))
	h := newHarness(t, st, reg)
	h.start(t, context.Background())

	out := h.next(t)
	if !errors.Is(out.Err, context.DeadlineExceeded) || !strings.Contains(out.Err.Error(), "timed out after 20ms") {
		t.Fatalf("outcome error = %v", out.Err)
	}
	if out.State != domain.StateAvailable {
		t.Errorf("state = %s, want the attempt retried", out.State)
	}
}

func TestPoolFailsJobWithoutHandler(t *testing.T) {
	st := newFakeStore(domain.Job{ID: 1, Type: "unknown.type"})
	h := newHarness(t, st, registry(nil))
	h.start(t, context.Background())

	h.next(t)
	failed := st.snapshot().failed
	if len(failed) != 1 || !strings.Contains(failed[0].msg, `no handler registered for job type "unknown.type"`) {
		t.Errorf("Fail calls = %+v", failed)
	}
}

func TestPoolReportsLostLease(t *testing.T) {
	st := newFakeStore(domain.Job{ID: 1, Type: "ok"})
	st.settleErr = domain.ErrLeaseLost
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{"ok": func(context.Context, domain.Job) error { return nil }}))
	h.start(t, context.Background())

	out := h.next(t)
	if !errors.Is(out.SettleErr, domain.ErrLeaseLost) || out.State != "" {
		t.Fatalf("outcome = %+v, want a lost lease", out)
	}
	h.pool.Stop()
	var buf strings.Builder
	if err := h.metrics.WriteText(&buf); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), `jobqueue_jobs_processed_total{queue="default",type="ok",outcome="lease_lost"} 1`) {
		t.Errorf("metrics do not count the lost lease:\n%s", buf.String())
	}
}

func TestPoolExtendLeaseFromHandler(t *testing.T) {
	st := newFakeStore(domain.Job{ID: 5, Type: "long"})
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"long": func(ctx context.Context, _ domain.Job) error {
			if worker.WorkerID(ctx) != "test/default/0" {
				return errors.New("handler context does not name its worker")
			}
			return worker.ExtendLease(ctx)
		},
	}))
	h.start(t, context.Background())

	if out := h.next(t); out.Err != nil {
		t.Fatalf("handler failed: %v", out.Err)
	}
	ext := st.snapshot().extended
	if len(ext) != 1 || ext[0].id != 5 || ext[0].workerID != "test/default/0" || !ext[0].until.Equal(t0.Add(time.Minute)) {
		t.Errorf("ExtendLease calls = %+v, want job 5 until now+1m", ext)
	}
}

func TestExtendLeaseOutsideAJob(t *testing.T) {
	if err := worker.ExtendLease(context.Background()); !errors.Is(err, worker.ErrNoLease) {
		t.Errorf("error = %v, want ErrNoLease", err)
	}
	if id := worker.WorkerID(context.Background()); id != "" {
		t.Errorf("WorkerID = %q, want empty", id)
	}
}

func TestPoolStopWaitsForRunningHandler(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	st := newFakeStore(domain.Job{ID: 1, Type: "block"})
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"block": func(ctx context.Context, _ domain.Job) error {
			close(started)
			<-release
			return ctx.Err() // Stop must not cancel the handler
		},
	}))
	h.start(t, context.Background())
	<-started

	stopped := make(chan struct{})
	go func() {
		h.pool.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
		t.Fatal("Stop returned while a handler was running")
	default:
	}
	close(release)
	<-stopped

	if got := st.snapshot().completed; len(got) != 1 {
		t.Fatalf("completed = %v; Stop returned before the outcome was recorded", got)
	}
}

func TestPoolStopEndsIdleWorkersAndLeasesNothingMore(t *testing.T) {
	st := newFakeStore()
	h := newHarness(t, st, registry(nil), func(o *worker.Options) { o.Concurrency = 3 })
	h.start(t, context.Background())

	h.clock.BlockUntil(3) // every worker found the queue empty and is waiting to poll again
	h.pool.Stop()
	leases := st.snapshot().leases

	st.add(domain.Job{ID: 1, Type: "noop"})
	h.clock.Advance(time.Hour)
	if got := st.snapshot().leases; got != leases {
		t.Errorf("pool leased %d more times after Stop", got-leases)
	}
}

func TestPoolPollsAgainAfterInterval(t *testing.T) {
	st := newFakeStore()
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{"ok": func(context.Context, domain.Job) error { return nil }}))
	h.start(t, context.Background())

	h.clock.BlockUntil(1)
	st.add(domain.Job{ID: 3, Type: "ok"})
	h.clock.Advance(time.Second)
	if out := h.next(t); out.Job.ID != 3 {
		t.Fatalf("outcome = %+v, want job 3", out)
	}
}

func TestPoolRecordsOutcomeAfterAbort(t *testing.T) {
	started := make(chan struct{})
	st := newFakeStore(domain.Job{ID: 1, Type: "block"})
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"block": func(ctx context.Context, _ domain.Job) error {
			close(started)
			<-ctx.Done()
			return ctx.Err()
		},
	}))
	ctx, cancel := context.WithCancel(context.Background())
	h.start(t, ctx)
	<-started
	cancel()

	out := h.next(t)
	if !errors.Is(out.Err, context.Canceled) || out.SettleErr != nil {
		t.Fatalf("outcome = %+v", out)
	}
	failed := st.snapshot().failed
	if len(failed) != 1 || failed[0].ctxErr != nil {
		t.Errorf("Fail calls = %+v, want one made with a live context", failed)
	}
}

func TestPoolRunsConcurrencyWorkersPerQueue(t *testing.T) {
	const perQueue = 2
	queues := []string{"a", "b"}
	running := make(chan string, 10)
	release := make(chan struct{})
	var jobs []domain.Job
	for i, q := range append(queues, queues...) {
		jobs = append(jobs, domain.Job{ID: int64(i + 1), Queue: q, Type: "block"})
	}
	st := newFakeStore(jobs...)
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{
		"block": func(_ context.Context, j domain.Job) error {
			running <- j.Queue
			<-release
			return nil
		},
	}), func(o *worker.Options) {
		o.Queues = queues
		o.Concurrency = perQueue
	})
	h.start(t, context.Background())

	// The timeout only turns a hang into a failure: with too few workers the
	// last handlers never start. Handlers are released before the pool stops.
	counts := map[string]int{}
	for range len(queues) * perQueue {
		select {
		case q := <-running:
			counts[q]++
		case <-time.After(10 * time.Second):
			close(release)
			t.Fatalf("handlers running at once per queue = %v after 10s, want %d each", counts, perQueue)
		}
	}
	close(release)
	if counts["a"] != perQueue || counts["b"] != perQueue {
		t.Errorf("handlers running at once per queue = %v, want %d each", counts, perQueue)
	}
	for range len(jobs) {
		h.next(t)
	}
}

func TestPoolStartTwice(t *testing.T) {
	h := newHarness(t, newFakeStore(), registry(nil))
	h.start(t, context.Background())
	if err := h.pool.Start(context.Background()); err == nil {
		t.Error("second Start succeeded")
	}
}

func TestNewPoolValidatesOptions(t *testing.T) {
	valid := worker.Options{ID: "p", Queues: []string{"default"}, Concurrency: 1, PollInterval: time.Second,
		LeaseDuration: time.Minute, Retry: domain.FixedDelay{}}
	cases := []struct {
		name   string
		mutate func(*worker.Options)
	}{
		{"no id", func(o *worker.Options) { o.ID = "" }},
		{"negative concurrency", func(o *worker.Options) { o.Concurrency = -1 }},
		{"zero poll interval", func(o *worker.Options) { o.PollInterval = 0 }},
		{"zero lease", func(o *worker.Options) { o.LeaseDuration = 0 }},
		{"no retry policy", func(o *worker.Options) { o.Retry = nil }},
		{"bad queue", func(o *worker.Options) { o.Queues = []string{"Not A Queue"} }},
	}
	if _, err := worker.NewPool(newFakeStore(), registry(nil), valid); err != nil {
		t.Fatalf("valid options rejected: %v", err)
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := valid
			tc.mutate(&opts)
			if _, err := worker.NewPool(newFakeStore(), registry(nil), opts); err == nil {
				t.Error("NewPool accepted invalid options")
			}
		})
	}
}

func TestPoolBacksOffAfterLeaseFailures(t *testing.T) {
	st := newFakeStore(domain.Job{ID: 1, Type: "ok"})
	st.leaseErrs = 3
	h := newHarness(t, st, registry(map[string]worker.HandlerFunc{"ok": func(context.Context, domain.Job) error { return nil }}))
	h.start(t, context.Background())

	// Failures 1, 2 and 3 wait 1s, 2s and 4s before the next attempt.
	for i, wait := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second} {
		h.clock.BlockUntil(1)
		if got := st.snapshot().leases; got != i+1 {
			t.Fatalf("lease attempts = %d, want %d", got, i+1)
		}
		h.clock.Advance(wait - time.Millisecond)
		if h.clock.Waiters() != 1 {
			t.Fatalf("worker retried before %s", wait)
		}
		h.clock.Advance(time.Millisecond)
	}
	if out := h.next(t); out.Job.ID != 1 || out.State != domain.StateSucceeded {
		t.Fatalf("outcome after the database recovered = %+v", out)
	}
	var buf strings.Builder
	_ = h.metrics.WriteText(&buf)
	if !strings.Contains(buf.String(), `jobqueue_lease_errors_total{queue="default"} 3`) {
		t.Errorf("lease errors not counted:\n%s", buf.String())
	}
}

func TestPoolCannotStartAfterStop(t *testing.T) {
	st := newFakeStore()
	h := newHarness(t, st, registry(nil))
	h.pool.Stop()
	if err := h.pool.Start(context.Background()); err == nil {
		t.Fatal("Start after Stop succeeded")
	}
	if got := st.snapshot().leases; got != 0 {
		t.Errorf("stopped pool leased %d times", got)
	}
}
