package store

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/relaywork/jobqueue/internal/domain"
)

// Page sizes for List and ListDead.
const (
	DefaultPageSize = 50
	MaxPageSize     = 500
)

// ListFilter selects jobs for List. Zero fields do not filter.
type ListFilter struct {
	Queue string
	State domain.State
	After int64 // return jobs with an id greater than After
	Limit int   // page size; 0 means DefaultPageSize
}

// Page is one page of jobs in ascending id order.
type Page struct {
	Jobs []domain.Job
	// NextAfter is the cursor for the next page, or 0 when this page is the last one.
	NextAfter int64
}

// Enqueue normalizes, validates and inserts a job.
func (s *Store) Enqueue(ctx context.Context, nj domain.NewJob) (domain.Job, error) {
	return enqueue(ctx, s.pool, s.now(), nj)
}

func enqueue(ctx context.Context, q querier, now time.Time, nj domain.NewJob) (domain.Job, error) {
	nj = nj.Normalize(now)
	if err := nj.Validate(); err != nil {
		return domain.Job{}, err
	}
	row := q.QueryRow(ctx, `
		INSERT INTO jobs (queue, type, payload, priority, state, max_attempts, run_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, 'available', $5, $6, $7, $7)
		RETURNING `+jobColumns,
		nj.Queue, nj.Type, []byte(nj.Payload), nj.Priority, nj.MaxAttempts, dbTime(nj.RunAt), now)
	job, err := scanJob(row)
	if err != nil {
		return domain.Job{}, fmt.Errorf("insert job: %w", err)
	}
	return job, nil
}

// Get returns the job with the given id.
func (s *Store) Get(ctx context.Context, id int64) (domain.Job, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+jobColumns+` FROM jobs WHERE id = $1`, id)
	job, err := scanJob(row)
	if err != nil {
		return domain.Job{}, notFound(err, "job %d", id)
	}
	return job, nil
}

// List returns a page of jobs matching f, in ascending id order.
func (s *Store) List(ctx context.Context, f ListFilter) (Page, error) {
	if f.Limit == 0 {
		f.Limit = DefaultPageSize
	}
	if f.Limit < 0 || f.Limit > MaxPageSize {
		return Page{}, domain.Invalid("limit", "must be between 1 and %d", MaxPageSize)
	}
	if f.State != "" && !f.State.Valid() {
		return Page{}, domain.Invalid("state", "unknown state %q", f.State)
	}

	var (
		where = []string{"id > $1"}
		args  = []any{f.After}
	)
	if f.Queue != "" {
		args = append(args, f.Queue)
		where = append(where, "queue = $"+strconv.Itoa(len(args)))
	}
	if f.State != "" {
		args = append(args, string(f.State))
		where = append(where, "state = $"+strconv.Itoa(len(args)))
	}
	// Fetch one extra row to learn whether another page follows.
	args = append(args, f.Limit+1)
	sql := `SELECT ` + jobColumns + ` FROM jobs WHERE ` + strings.Join(where, " AND ") +
		` ORDER BY id LIMIT $` + strconv.Itoa(len(args))

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return Page{}, fmt.Errorf("list jobs: %w", err)
	}
	jobs, err := collectJobs(rows)
	if err != nil {
		return Page{}, fmt.Errorf("list jobs: %w", err)
	}
	page := Page{Jobs: jobs}
	if len(jobs) > f.Limit {
		page.Jobs = jobs[:f.Limit]
		page.NextAfter = page.Jobs[f.Limit-1].ID
	}
	return page, nil
}

// Cancel cancels an available job. It returns domain.ErrConflict when the job is in any other
// state; running jobs cannot be cancelled.
func (s *Store) Cancel(ctx context.Context, id int64) (domain.Job, error) {
	now := s.now()
	row := s.pool.QueryRow(ctx, `
		UPDATE jobs SET state = 'cancelled', finished_at = $2, updated_at = $2
		WHERE id = $1 AND state = 'available'
		RETURNING `+jobColumns, id, now)
	job, err := scanJob(row)
	if err == nil {
		return job, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.Job{}, fmt.Errorf("cancel job %d: %w", id, err)
	}
	return domain.Job{}, s.stateConflict(ctx, id, "cancel", domain.StateAvailable)
}

// ListDead returns a page of dead jobs, optionally limited to one queue.
func (s *Store) ListDead(ctx context.Context, queue string, after int64, limit int) (Page, error) {
	return s.List(ctx, ListFilter{Queue: queue, State: domain.StateDead, After: after, Limit: limit})
}

// Requeue makes a dead job available again with a fresh set of attempts. The last error is
// kept for reference until the job runs again.
func (s *Store) Requeue(ctx context.Context, id int64) (domain.Job, error) {
	now := s.now()
	row := s.pool.QueryRow(ctx, `
		UPDATE jobs SET state = 'available', attempts = 0, run_at = $2, finished_at = NULL, updated_at = $2
		WHERE id = $1 AND state = 'dead'
		RETURNING `+jobColumns, id, now)
	job, err := scanJob(row)
	if err == nil {
		return job, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.Job{}, fmt.Errorf("requeue job %d: %w", id, err)
	}
	return domain.Job{}, s.stateConflict(ctx, id, "requeue", domain.StateDead)
}

// stateConflict explains why a conditional update of job id matched no row: the job does not
// exist, or it is not in the state the operation requires.
func (s *Store) stateConflict(ctx context.Context, id int64, op string, want domain.State) error {
	var state string
	err := s.pool.QueryRow(ctx, `SELECT state FROM jobs WHERE id = $1`, id).Scan(&state)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("job %d: %w", id, domain.ErrNotFound)
		}
		return fmt.Errorf("%s job %d: %w", op, id, err)
	}
	return fmt.Errorf("cannot %s job %d: it is %s, not %s: %w", op, id, state, want, domain.ErrConflict)
}
