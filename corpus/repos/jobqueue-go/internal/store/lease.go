package store

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/relaywork/jobqueue/internal/domain"
)

// ReapBatchSize is the most jobs one ReapExpired call settles. Callers that find a full batch
// call again.
const ReapBatchSize = 500

// Lease claims up to n available jobs of queue whose run_at has passed, highest priority first,
// then oldest run_at, then lowest id. Each claimed job becomes running, owned by workerID until
// now+leaseFor, and its attempt counter is incremented. Jobs locked by a concurrent Lease are
// skipped rather than waited for.
func (s *Store) Lease(ctx context.Context, queue, workerID string, n int, leaseFor time.Duration) ([]domain.Job, error) {
	if n < 1 {
		return nil, fmt.Errorf("lease: n must be positive, got %d", n)
	}
	if workerID == "" {
		return nil, errors.New("lease: worker id is required")
	}
	if leaseFor <= 0 {
		return nil, fmt.Errorf("lease: duration must be positive, got %s", leaseFor)
	}
	now := s.now()
	rows, err := s.pool.Query(ctx, `
		WITH picked AS (
			SELECT id FROM jobs
			WHERE queue = $1 AND state = 'available' AND run_at <= $2
			ORDER BY priority DESC, run_at, id
			LIMIT $3
			FOR UPDATE SKIP LOCKED
		)
		UPDATE jobs AS j
		SET state = 'running', locked_by = $4, locked_until = $5, attempts = j.attempts + 1, updated_at = $2
		FROM picked
		WHERE j.id = picked.id
		RETURNING `+jobColumnsOf("j"),
		queue, now, n, workerID, now.Add(leaseFor))
	if err != nil {
		return nil, fmt.Errorf("lease jobs from %s: %w", queue, err)
	}
	jobs, err := collectJobs(rows)
	if err != nil {
		return nil, fmt.Errorf("lease jobs from %s: %w", queue, err)
	}
	// UPDATE ... RETURNING does not keep the order of the CTE.
	slices.SortFunc(jobs, func(a, b domain.Job) int {
		if c := cmp.Compare(b.Priority, a.Priority); c != 0 {
			return c
		}
		if c := a.RunAt.Compare(b.RunAt); c != 0 {
			return c
		}
		return cmp.Compare(a.ID, b.ID)
	})
	return jobs, nil
}

// Complete marks a running job owned by workerID as succeeded. It returns domain.ErrLeaseLost
// when the job is not running under workerID's lease any more.
func (s *Store) Complete(ctx context.Context, id int64, workerID string) error {
	now := s.now()
	tag, err := s.pool.Exec(ctx, `
		UPDATE jobs SET state = 'succeeded', locked_by = NULL, locked_until = NULL, finished_at = $3, updated_at = $3
		WHERE id = $1 AND state = 'running' AND locked_by = $2`,
		id, workerID, now)
	if err != nil {
		return fmt.Errorf("complete job %d: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("complete job %d as %s: %w", id, workerID, domain.ErrLeaseLost)
	}
	return nil
}

// Fail records a failed attempt of a running job owned by workerID. A job with attempts left
// becomes available again at retryAt; a job that has used max_attempts becomes dead. It returns
// the job as updated, or domain.ErrLeaseLost when workerID no longer holds the lease.
func (s *Store) Fail(ctx context.Context, id int64, workerID, errMsg string, retryAt time.Time) (domain.Job, error) {
	now := s.now()
	row := s.pool.QueryRow(ctx, `
		UPDATE jobs SET
			state       = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'available' END,
			run_at      = CASE WHEN attempts >= max_attempts THEN run_at ELSE $4 END,
			finished_at = CASE WHEN attempts >= max_attempts THEN $5::timestamptz END,
			last_error  = $3,
			locked_by   = NULL,
			locked_until = NULL,
			updated_at  = $5
		WHERE id = $1 AND state = 'running' AND locked_by = $2
		RETURNING `+jobColumns,
		id, workerID, errorText(errMsg), dbTime(retryAt), now)
	return s.settled(row, id, workerID, "fail")
}

// Discard records a failure that must not be retried: the running job owned by workerID becomes
// failed whatever its remaining attempts.
func (s *Store) Discard(ctx context.Context, id int64, workerID, errMsg string) (domain.Job, error) {
	now := s.now()
	row := s.pool.QueryRow(ctx, `
		UPDATE jobs SET state = 'failed', last_error = $3, locked_by = NULL, locked_until = NULL,
			finished_at = $4, updated_at = $4
		WHERE id = $1 AND state = 'running' AND locked_by = $2
		RETURNING `+jobColumns,
		id, workerID, errorText(errMsg), now)
	return s.settled(row, id, workerID, "discard")
}

func (s *Store) settled(row pgx.Row, id int64, workerID, op string) (domain.Job, error) {
	job, err := scanJob(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Job{}, fmt.Errorf("%s job %d as %s: %w", op, id, workerID, domain.ErrLeaseLost)
		}
		return domain.Job{}, fmt.Errorf("%s job %d: %w", op, id, err)
	}
	return job, nil
}

// ExtendLease moves the lease deadline of a running job owned by workerID to until. It returns
// domain.ErrLeaseLost when workerID no longer holds the lease; a lease that has expired but has
// not been reaped yet can still be extended.
func (s *Store) ExtendLease(ctx context.Context, id int64, workerID string, until time.Time) error {
	now := s.now()
	if !until.After(now) {
		return domain.Invalid("until", "must be in the future")
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE jobs SET locked_until = $3, updated_at = $4
		WHERE id = $1 AND state = 'running' AND locked_by = $2`,
		id, workerID, dbTime(until), now)
	if err != nil {
		return fmt.Errorf("extend lease of job %d: %w", id, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("extend lease of job %d as %s: %w", id, workerID, domain.ErrLeaseLost)
	}
	return nil
}

// ReapExpired settles up to ReapBatchSize running jobs whose lease expired before now: jobs with
// attempts left become available immediately, the others become dead. It returns the jobs as
// updated.
func (s *Store) ReapExpired(ctx context.Context, now time.Time) ([]domain.Job, error) {
	now = dbTime(now)
	rows, err := s.pool.Query(ctx, `
		WITH expired AS (
			SELECT id FROM jobs
			WHERE state = 'running' AND locked_until < $1
			ORDER BY locked_until, id
			LIMIT $2
			FOR UPDATE SKIP LOCKED
		)
		UPDATE jobs AS j SET
			state        = CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'available' END,
			run_at       = CASE WHEN j.attempts >= j.max_attempts THEN j.run_at ELSE $1 END,
			finished_at  = CASE WHEN j.attempts >= j.max_attempts THEN $1 END,
			last_error   = 'lease held by ' || j.locked_by || ' expired before the job finished',
			locked_by    = NULL,
			locked_until = NULL,
			updated_at   = $1
		FROM expired
		WHERE j.id = expired.id
		RETURNING `+jobColumnsOf("j"),
		now, ReapBatchSize)
	if err != nil {
		return nil, fmt.Errorf("reap expired leases: %w", err)
	}
	jobs, err := collectJobs(rows)
	if err != nil {
		return nil, fmt.Errorf("reap expired leases: %w", err)
	}
	return jobs, nil
}
