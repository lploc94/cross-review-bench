// Package worker runs job handlers: a Pool of goroutines leases jobs from the store, runs the
// handler registered for each job's type and records the outcome. A Reaper returns jobs whose
// lease expired to the queue.
package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/metrics"
)

// settleTimeout bounds the store call that records a job's outcome.
const settleTimeout = 10 * time.Second

// Store is the part of the job store the pool needs.
type Store interface {
	Lease(ctx context.Context, queue, workerID string, n int, leaseFor time.Duration) ([]domain.Job, error)
	Complete(ctx context.Context, id int64, workerID string) error
	Fail(ctx context.Context, id int64, workerID, errMsg string, retryAt time.Time) (domain.Job, error)
	Discard(ctx context.Context, id int64, workerID, errMsg string) (domain.Job, error)
	ExtendLease(ctx context.Context, id int64, workerID string, until time.Time) error
}

// Options configures a Pool.
type Options struct {
	// ID prefixes the lease owner names of the pool's goroutines ("<ID>/<queue>/<n>"). It must
	// be unique among running pools.
	ID            string
	Queues        []string
	Concurrency   int // goroutines per queue
	PollInterval  time.Duration
	LeaseDuration time.Duration
	Retry         domain.RetryPolicy
	Clock         clock.Clock
	Logger        *slog.Logger
	Metrics       *metrics.Registry // optional
	// OnSettled, if set, is called after each job's outcome has been recorded (or failed to
	// be), from the goroutine that ran the job.
	OnSettled func(Outcome)
}

// Outcome describes one finished attempt.
type Outcome struct {
	Job       domain.Job // the job as leased
	WorkerID  string
	Err       error         // what the handler returned; nil on success
	State     domain.State  // the job's state after settling; empty if settling failed
	SettleErr error         // why the outcome could not be recorded, e.g. domain.ErrLeaseLost
	Duration  time.Duration // handler run time
}

// PanicError is the error of an attempt whose handler panicked.
type PanicError struct {
	Value any
	Stack []byte
}

func (e *PanicError) Error() string { return fmt.Sprintf("panic: %v", e.Value) }

// Pool runs Concurrency goroutines per queue. Each repeatedly leases one job, runs its handler
// and records the outcome, sleeping PollInterval whenever its queue is empty.
type Pool struct {
	store    Store
	registry *Registry
	opts     Options
	log      *slog.Logger
	metrics  poolMetrics

	mu      sync.Mutex
	started bool
	ctx     context.Context
	quit    chan struct{}
	wg      sync.WaitGroup
}

// NewPool validates opts and returns a pool that is not running yet.
func NewPool(store Store, registry *Registry, opts Options) (*Pool, error) {
	switch {
	case opts.ID == "":
		return nil, errors.New("worker: pool ID is required")
	case opts.Concurrency < 0:
		return nil, errors.New("worker: concurrency must not be negative")
	case opts.PollInterval <= 0:
		return nil, errors.New("worker: poll interval must be positive")
	case opts.LeaseDuration <= 0:
		return nil, errors.New("worker: lease duration must be positive")
	case opts.Retry == nil:
		return nil, errors.New("worker: retry policy is required")
	}
	for _, q := range opts.Queues {
		if err := domain.ValidateQueueName(q); err != nil {
			return nil, fmt.Errorf("worker: queue %q %w", q, err)
		}
	}
	if opts.Clock == nil {
		opts.Clock = clock.Real{}
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Metrics == nil {
		opts.Metrics = metrics.NewRegistry()
	}
	return &Pool{
		store:    store,
		registry: registry,
		opts:     opts,
		log:      opts.Logger.With("component", "worker"),
		metrics:  newPoolMetrics(opts.Metrics),
		quit:     make(chan struct{}),
	}, nil
}

// Start launches the pool's goroutines. Cancelling ctx aborts the pool: leasing stops and
// running handlers see their context cancelled. For a graceful stop, call Stop instead.
func (p *Pool) Start(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.started {
		return errors.New("worker: pool already started")
	}
	select {
	case <-p.quit:
		return errors.New("worker: pool already stopped")
	default:
	}
	p.started = true
	p.ctx = ctx
	for _, queue := range p.opts.Queues {
		for i := range p.opts.Concurrency {
			workerID := fmt.Sprintf("%s/%s/%d", p.opts.ID, queue, i)
			p.wg.Add(1)
			go p.work(queue, workerID)
		}
	}
	p.log.Info("worker pool started", "queues", p.opts.Queues, "concurrency", p.opts.Concurrency,
		"types", p.registry.Types())
	return nil
}

// Stop stops leasing new jobs and waits for the handlers that are running to return and for
// their outcomes to be recorded. Running handlers are not interrupted. Stop may be called more
// than once and before Start.
func (p *Pool) Stop() {
	p.mu.Lock()
	select {
	case <-p.quit:
	default:
		close(p.quit)
	}
	p.mu.Unlock()
	p.wg.Wait()
	p.log.Info("worker pool stopped")
}

// work is the loop of one goroutine.
func (p *Pool) work(queue, workerID string) {
	defer p.wg.Done()
	failures := 0
	for !p.stopping() {
		jobs, err := p.store.Lease(p.ctx, queue, workerID, 1, p.opts.LeaseDuration)
		if err != nil {
			if p.ctx.Err() != nil {
				return
			}
			failures++
			p.metrics.leaseErrors.Inc(queue)
			p.log.Error("lease jobs", "queue", queue, "worker", workerID, "error", err, "consecutive_failures", failures)
			if !p.idle(leaseBackoff(p.opts.PollInterval, failures)) {
				return
			}
			continue
		}
		failures = 0
		if len(jobs) == 0 {
			if !p.idle(p.opts.PollInterval) {
				return
			}
			continue
		}
		// A job leased here is processed even if Stop was called in the meantime: it is
		// already running in the database.
		for _, job := range jobs {
			p.run(queue, workerID, job)
		}
	}
}

func (p *Pool) stopping() bool {
	select {
	case <-p.quit:
		return true
	case <-p.ctx.Done():
		return true
	default:
		return false
	}
}

// maxLeaseBackoff caps the wait after repeated lease failures.
const maxLeaseBackoff = 30 * time.Second

// leaseBackoff is how long a worker waits after its failures-th consecutive failed lease: the
// poll interval, doubled for each further failure up to maxLeaseBackoff, so that a database
// outage does not turn every worker into a tight retry loop.
func leaseBackoff(poll time.Duration, failures int) time.Duration {
	d := poll
	for i := 1; i < failures && d < maxLeaseBackoff; i++ {
		d *= 2
	}
	return max(poll, min(d, maxLeaseBackoff))
}

// idle waits for d and reports whether the goroutine should carry on.
func (p *Pool) idle(d time.Duration) bool {
	select {
	case <-p.quit:
		return false
	case <-p.ctx.Done():
		return false
	case <-p.opts.Clock.After(d):
		return true
	}
}

func (p *Pool) run(queue, workerID string, job domain.Job) {
	p.metrics.busy.Add(1, queue)
	defer p.metrics.busy.Add(-1, queue)

	log := p.log.With("job_id", job.ID, "queue", job.Queue, "type", job.Type, "attempt", job.Attempts, "worker", workerID)
	start := p.opts.Clock.Now()
	herr := p.execute(job, workerID)
	elapsed := p.opts.Clock.Now().Sub(start)

	var panicErr *PanicError
	if errors.As(herr, &panicErr) {
		log.Error("handler panicked", "panic", fmt.Sprint(panicErr.Value), "stack", string(panicErr.Stack))
	}

	// The outcome is recorded even if the pool's context was cancelled while the handler ran;
	// otherwise the job would stay running until its lease expires.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(p.ctx), settleTimeout)
	defer cancel()
	out := p.settle(ctx, job, workerID, herr)
	out.Duration = elapsed

	p.metrics.duration.Observe(elapsed.Seconds(), queue, job.Type)
	p.metrics.processed.Inc(queue, job.Type, outcomeLabel(out))
	switch {
	case out.SettleErr != nil && errors.Is(out.SettleErr, domain.ErrLeaseLost):
		log.Warn("lease lost before the outcome was recorded", "error", out.SettleErr, "handler_error", errString(herr))
	case out.SettleErr != nil:
		log.Error("record job outcome", "error", out.SettleErr, "handler_error", errString(herr))
	case out.State == domain.StateSucceeded:
		log.Debug("job succeeded", "duration", elapsed)
	case out.State == domain.StateDead:
		log.Error("job failed for the last time", "error", herr, "duration", elapsed)
	default:
		log.Warn("job attempt failed", "error", herr, "state", out.State, "duration", elapsed)
	}
	if p.opts.OnSettled != nil {
		p.opts.OnSettled(out)
	}
}

// execute runs the job's handler with the type's timeout and turns a panic into an error.
func (p *Pool) execute(job domain.Job, workerID string) error {
	h, ok := p.registry.lookup(job.Type)
	if !ok {
		return fmt.Errorf("no handler registered for job type %q", job.Type)
	}
	ctx := withLease(p.ctx, &lease{
		jobID:    job.ID,
		workerID: workerID,
		store:    p.store,
		clock:    p.opts.Clock,
		duration: p.opts.LeaseDuration,
	})
	ctx, cancel := context.WithTimeout(ctx, h.timeout)
	defer cancel()

	err := invoke(ctx, h.fn, job)
	if err != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("timed out after %s: %w", h.timeout, err)
	}
	return err
}

func invoke(ctx context.Context, fn HandlerFunc, job domain.Job) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = &PanicError{Value: r, Stack: debug.Stack()}
		}
	}()
	return fn(ctx, job)
}

// settle records the attempt's outcome in the store.
func (p *Pool) settle(ctx context.Context, job domain.Job, workerID string, herr error) Outcome {
	out := Outcome{Job: job, WorkerID: workerID, Err: herr}
	var (
		settled domain.Job
		err     error
	)
	switch {
	case herr == nil:
		err = p.store.Complete(ctx, job.ID, workerID)
		settled.State = domain.StateSucceeded
	case domain.IsPermanent(herr):
		settled, err = p.store.Discard(ctx, job.ID, workerID, herr.Error())
	default:
		retryAt := p.opts.Retry.NextRunAt(p.opts.Clock.Now(), job.Attempts)
		settled, err = p.store.Fail(ctx, job.ID, workerID, herr.Error(), retryAt)
	}
	if err != nil {
		out.SettleErr = err
		return out
	}
	out.State = settled.State
	return out
}

func outcomeLabel(o Outcome) string {
	switch {
	case o.SettleErr != nil && errors.Is(o.SettleErr, domain.ErrLeaseLost):
		return "lease_lost"
	case o.SettleErr != nil:
		return "error"
	case o.State == domain.StateAvailable:
		return "retried"
	default:
		return string(o.State)
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

type poolMetrics struct {
	processed   *metrics.Counter
	duration    *metrics.Histogram
	busy        *metrics.Gauge
	leaseErrors *metrics.Counter
}

func newPoolMetrics(reg *metrics.Registry) poolMetrics {
	return poolMetrics{
		processed: reg.NewCounter("jobqueue_jobs_processed_total",
			"Job attempts by outcome: succeeded, retried, dead, failed, lease_lost or error.", "queue", "type", "outcome"),
		duration: reg.NewHistogram("jobqueue_job_duration_seconds",
			"Handler run time per attempt.", nil, "queue", "type"),
		busy: reg.NewGauge("jobqueue_workers_busy",
			"Worker goroutines currently running a handler.", "queue"),
		leaseErrors: reg.NewCounter("jobqueue_lease_errors_total",
			"Failed attempts to lease jobs.", "queue"),
	}
}
