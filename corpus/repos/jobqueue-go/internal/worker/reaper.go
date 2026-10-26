package worker

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/metrics"
)

// ReapStore is the part of the job store the reaper needs.
type ReapStore interface {
	// ReapExpired settles one batch of running jobs whose lease expired before now.
	ReapExpired(ctx context.Context, now time.Time) ([]domain.Job, error)
}

// Reaper periodically returns jobs whose lease expired, because their worker crashed or hung,
// to the queue, or moves them to dead when they have no attempts left.
type Reaper struct {
	store     ReapStore
	batchSize int
	interval  time.Duration
	clock     clock.Clock
	log       *slog.Logger
	reaped    *metrics.Counter
}

// NewReaper returns a reaper that runs every interval. batchSize must match the most jobs one
// ReapExpired call settles, so that the reaper knows when to call again.
func NewReaper(store ReapStore, batchSize int, interval time.Duration, clk clock.Clock, logger *slog.Logger, reg *metrics.Registry) (*Reaper, error) {
	if batchSize < 1 {
		return nil, errors.New("worker: reaper batch size must be positive")
	}
	if interval <= 0 {
		return nil, errors.New("worker: reaper interval must be positive")
	}
	if reg == nil {
		reg = metrics.NewRegistry()
	}
	return &Reaper{
		store:     store,
		batchSize: batchSize,
		interval:  interval,
		clock:     clk,
		log:       logger.With("component", "reaper"),
		reaped: reg.NewCounter("jobqueue_jobs_reaped_total",
			"Running jobs whose lease expired, by the state they were moved to.", "queue", "state"),
	}, nil
}

// Run reaps once immediately and then every interval until ctx is done. It returns nil when ctx
// is cancelled; errors of individual passes are logged and retried at the next interval.
func (r *Reaper) Run(ctx context.Context) error {
	for {
		if _, err := r.ReapOnce(ctx); err != nil && ctx.Err() == nil {
			r.log.Error("reap expired leases", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-r.clock.After(r.interval):
		}
	}
}

// ReapOnce settles every job whose lease has expired, in batches, and returns how many it
// settled.
func (r *Reaper) ReapOnce(ctx context.Context) (int, error) {
	total := 0
	for {
		jobs, err := r.store.ReapExpired(ctx, r.clock.Now())
		if err != nil {
			return total, err
		}
		for _, j := range jobs {
			r.reaped.Inc(j.Queue, string(j.State))
			r.log.Warn("lease expired", "job_id", j.ID, "queue", j.Queue, "type", j.Type,
				"attempt", j.Attempts, "state", j.State)
		}
		total += len(jobs)
		if len(jobs) < r.batchSize {
			return total, nil
		}
	}
}
