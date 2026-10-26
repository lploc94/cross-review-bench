// Package store persists jobs and schedules in PostgreSQL.
//
// Every state transition is a single conditional statement, so concurrent workers, the reaper
// and API calls never need application-level locks: leasing uses FOR UPDATE SKIP LOCKED, and
// settling a job is conditional on the worker still holding its lease.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
)

// maxErrorBytes bounds the last_error column; handler errors can embed whole response bodies.
const maxErrorBytes = 4096

// Store reads and writes jobs and schedules. It is safe for concurrent use.
type Store struct {
	pool  *pgxpool.Pool
	clock clock.Clock
}

// New returns a Store backed by pool. All timestamps it writes come from clk.
func New(pool *pgxpool.Pool, clk clock.Clock) *Store {
	return &Store{pool: pool, clock: clk}
}

// Ping checks that the database is reachable.
func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

// now returns the current time at the precision PostgreSQL stores, so that values written and
// values read back compare equal.
func (s *Store) now() time.Time {
	return dbTime(s.clock.Now())
}

func dbTime(t time.Time) time.Time {
	return t.UTC().Truncate(time.Microsecond)
}

// querier is implemented by *pgxpool.Pool and pgx.Tx, so that statements can run either on
// their own or inside a caller's transaction.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// jobColumns is the column list scanJob expects.
const jobColumns = "id, queue, type, payload, priority, state, attempts, max_attempts, run_at, " +
	"locked_by, locked_until, last_error, created_at, updated_at, finished_at"

// jobColumnsOf qualifies the job columns with a table alias.
func jobColumnsOf(alias string) string {
	cols := strings.Split(jobColumns, ", ")
	for i, c := range cols {
		cols[i] = alias + "." + c
	}
	return strings.Join(cols, ", ")
}

func scanJob(row pgx.Row) (domain.Job, error) {
	var (
		j         domain.Job
		state     string
		lockedBy  *string
		lastError *string
	)
	err := row.Scan(&j.ID, &j.Queue, &j.Type, &j.Payload, &j.Priority, &state, &j.Attempts, &j.MaxAttempts,
		&j.RunAt, &lockedBy, &j.LockedUntil, &lastError, &j.CreatedAt, &j.UpdatedAt, &j.FinishedAt)
	if err != nil {
		return domain.Job{}, err
	}
	j.State = domain.State(state)
	if lockedBy != nil {
		j.LockedBy = *lockedBy
	}
	if lastError != nil {
		j.LastError = *lastError
	}
	j.RunAt = j.RunAt.UTC()
	j.CreatedAt = j.CreatedAt.UTC()
	j.UpdatedAt = j.UpdatedAt.UTC()
	j.LockedUntil = utcPtr(j.LockedUntil)
	j.FinishedAt = utcPtr(j.FinishedAt)
	return j, nil
}

func collectJobs(rows pgx.Rows) ([]domain.Job, error) {
	defer rows.Close()
	var jobs []domain.Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// notFound wraps domain.ErrNotFound for a pgx.ErrNoRows and passes any other error through.
func notFound(err error, format string, args ...any) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf(format+": %w", append(args, domain.ErrNotFound)...)
	}
	return err
}

// errorText makes a handler error storable: PostgreSQL text cannot hold NUL bytes or invalid
// UTF-8, and the column is bounded.
func errorText(msg string) string {
	msg = strings.ToValidUTF8(strings.ReplaceAll(msg, "\x00", ""), "�")
	if len(msg) <= maxErrorBytes {
		return msg
	}
	cut := maxErrorBytes
	for cut > 0 && !utf8.RuneStart(msg[cut]) {
		cut--
	}
	return msg[:cut] + "…"
}
