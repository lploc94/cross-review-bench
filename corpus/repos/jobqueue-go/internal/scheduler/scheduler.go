// Package scheduler turns cron schedules into jobs. Each tick claims the schedules that are
// due, enqueues one job for each and moves its next run forward, in one transaction per batch;
// several scheduler instances can run against the same database.
//
// A schedule that was due several times while no scheduler ran fires once, and its next run is
// computed from the current time: missed runs are not caught up.
package scheduler

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/cron"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/metrics"
	"github.com/relaywork/jobqueue/internal/store"
)

// DefaultBatchSize is how many schedules one transaction fires at most.
const DefaultBatchSize = 100

// Store is the part of the store the scheduler needs.
type Store interface {
	FireDueSchedules(ctx context.Context, now time.Time, limit int, plan store.PlanFunc) ([]store.Firing, error)
}

// Options configures a Scheduler.
type Options struct {
	Interval  time.Duration
	BatchSize int // 0 means DefaultBatchSize
	Clock     clock.Clock
	Logger    *slog.Logger
	Metrics   *metrics.Registry // optional
}

// Scheduler fires due schedules periodically.
type Scheduler struct {
	store    Store
	interval time.Duration
	batch    int
	clock    clock.Clock
	log      *slog.Logger
	fired    *metrics.Counter
	disabled *metrics.Counter
}

// New returns a scheduler that is not running yet.
func New(st Store, opts Options) (*Scheduler, error) {
	if opts.Interval <= 0 {
		return nil, errors.New("scheduler: interval must be positive")
	}
	if opts.BatchSize < 0 {
		return nil, errors.New("scheduler: batch size must not be negative")
	}
	if opts.BatchSize == 0 {
		opts.BatchSize = DefaultBatchSize
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
	return &Scheduler{
		store:    st,
		interval: opts.Interval,
		batch:    opts.BatchSize,
		clock:    opts.Clock,
		log:      opts.Logger.With("component", "scheduler"),
		fired: opts.Metrics.NewCounter("jobqueue_schedules_fired_total",
			"Jobs enqueued by schedules.", "schedule"),
		disabled: opts.Metrics.NewCounter("jobqueue_schedules_disabled_total",
			"Schedules disabled because they could not fire or will never fire again.", "schedule"),
	}, nil
}

// Run ticks immediately and then every interval until ctx is done. It returns nil when ctx is
// cancelled; a failed tick is logged and retried at the next interval.
func (s *Scheduler) Run(ctx context.Context) error {
	for {
		if _, err := s.Tick(ctx); err != nil && ctx.Err() == nil {
			s.log.Error("fire schedules", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-s.clock.After(s.interval):
		}
	}
}

// Tick fires every schedule due now, a batch per transaction, and returns what happened to
// each.
func (s *Scheduler) Tick(ctx context.Context) ([]store.Firing, error) {
	now := s.clock.Now().UTC()
	var all []store.Firing
	for {
		fired, err := s.store.FireDueSchedules(ctx, now, s.batch, Plan(now))
		if err != nil {
			return all, err
		}
		for _, f := range fired {
			s.report(f)
		}
		all = append(all, fired...)
		if len(fired) < s.batch {
			return all, nil
		}
	}
}

func (s *Scheduler) report(f store.Firing) {
	name := f.Schedule.Name
	switch {
	case f.Err != nil:
		s.disabled.Inc(name)
		s.log.Error("schedule disabled: it cannot fire", "schedule", name, "spec", f.Schedule.Spec, "error", f.Err)
	case f.Next.IsZero():
		s.fired.Inc(name)
		s.disabled.Inc(name)
		s.log.Warn("schedule fired for the last time and was disabled", "schedule", name, "job_id", f.Job.ID)
	default:
		s.fired.Inc(name)
		s.log.Info("schedule fired", "schedule", name, "job_id", f.Job.ID, "queue", f.Job.Queue,
			"type", f.Job.Type, "next_run_at", f.Next)
	}
}

// Plan returns the store.PlanFunc for a tick at now: the schedule's job runs at now, and the
// schedule next fires at the first time after now that its expression matches.
func Plan(now time.Time) store.PlanFunc {
	return func(sc domain.Schedule) (domain.NewJob, time.Time, error) {
		expr, err := cron.Parse(sc.Spec)
		if err != nil {
			return domain.NewJob{}, time.Time{}, err
		}
		return sc.Job(now), expr.Next(now), nil
	}
}
