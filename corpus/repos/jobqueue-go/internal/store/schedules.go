package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/relaywork/jobqueue/internal/domain"
)

const scheduleColumns = "name, spec, queue, type, payload, enabled, next_run_at, last_run_at, created_at, updated_at"

func scanSchedule(row pgx.Row, extra ...any) (domain.Schedule, error) {
	var sc domain.Schedule
	dest := append([]any{&sc.Name, &sc.Spec, &sc.Queue, &sc.Type, &sc.Payload, &sc.Enabled,
		&sc.NextRunAt, &sc.LastRunAt, &sc.CreatedAt, &sc.UpdatedAt}, extra...)
	if err := row.Scan(dest...); err != nil {
		return domain.Schedule{}, err
	}
	sc.NextRunAt = sc.NextRunAt.UTC()
	sc.LastRunAt = utcPtr(sc.LastRunAt)
	sc.CreatedAt = sc.CreatedAt.UTC()
	sc.UpdatedAt = sc.UpdatedAt.UTC()
	return sc, nil
}

func collectSchedules(rows pgx.Rows) ([]domain.Schedule, error) {
	defer rows.Close()
	var out []domain.Schedule
	for rows.Next() {
		sc, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

// GetSchedule returns the schedule called name.
func (s *Store) GetSchedule(ctx context.Context, name string) (domain.Schedule, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+scheduleColumns+` FROM schedules WHERE name = $1`, name)
	sc, err := scanSchedule(row)
	if err != nil {
		return domain.Schedule{}, notFound(err, "schedule %q", name)
	}
	return sc, nil
}

// ListSchedules returns every schedule ordered by name.
func (s *Store) ListSchedules(ctx context.Context) ([]domain.Schedule, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+scheduleColumns+` FROM schedules ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("list schedules: %w", err)
	}
	out, err := collectSchedules(rows)
	if err != nil {
		return nil, fmt.Errorf("list schedules: %w", err)
	}
	return out, nil
}

// PutSchedule creates or replaces the schedule in.Name, which the caller has validated.
// firstRun is used as next_run_at for a new schedule, and for an existing one whose spec
// changes or that is being enabled; an enabled schedule saved again with the same spec keeps
// its pending run. created reports whether the schedule is new.
func (s *Store) PutSchedule(ctx context.Context, in domain.ScheduleInput, firstRun time.Time) (sc domain.Schedule, created bool, err error) {
	now := s.now()
	row := s.pool.QueryRow(ctx, `
		INSERT INTO schedules AS s (name, spec, queue, type, payload, enabled, next_run_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
		ON CONFLICT (name) DO UPDATE SET
			spec        = EXCLUDED.spec,
			queue       = EXCLUDED.queue,
			type        = EXCLUDED.type,
			payload     = EXCLUDED.payload,
			enabled     = EXCLUDED.enabled,
			next_run_at = CASE WHEN s.spec = EXCLUDED.spec AND s.enabled
			                   THEN s.next_run_at ELSE EXCLUDED.next_run_at END,
			updated_at  = EXCLUDED.updated_at
		RETURNING `+scheduleColumns+`, (xmax = 0)`,
		in.Name, in.Spec, in.Queue, in.Type, []byte(in.Payload), in.Enabled, dbTime(firstRun), now)
	sc, err = scanSchedule(row, &created)
	if err != nil {
		return domain.Schedule{}, false, fmt.Errorf("save schedule %q: %w", in.Name, err)
	}
	return sc, created, nil
}

// DeleteSchedule removes the schedule called name. Jobs it already enqueued are not affected.
func (s *Store) DeleteSchedule(ctx context.Context, name string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM schedules WHERE name = $1`, name)
	if err != nil {
		return fmt.Errorf("delete schedule %q: %w", name, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("schedule %q: %w", name, domain.ErrNotFound)
	}
	return nil
}

// PlanFunc decides what a due schedule enqueues and when it fires next. A zero next time means
// the schedule never fires again; an error means the schedule cannot fire at all.
type PlanFunc func(sc domain.Schedule) (job domain.NewJob, next time.Time, err error)

// Firing is the outcome of one due schedule in FireDueSchedules.
type Firing struct {
	Schedule domain.Schedule // as it was when claimed
	Job      domain.Job      // the enqueued job; zero when Err is set
	Next     time.Time       // the new next_run_at; zero when the schedule was disabled
	Err      error           // why the schedule was disabled instead of fired
}

// FireDueSchedules claims up to limit enabled schedules due at now and, for each, enqueues the
// job that plan returns and moves next_run_at forward, all in one transaction: a schedule fires
// exactly once per due time even with several scheduler instances. Schedules claimed by a
// concurrent call are skipped. A schedule whose plan fails, or whose job does not validate, is
// disabled so that it does not block the others; its Firing carries the reason.
func (s *Store) FireDueSchedules(ctx context.Context, now time.Time, limit int, plan PlanFunc) ([]Firing, error) {
	if limit < 1 {
		return nil, fmt.Errorf("fire schedules: limit must be positive, got %d", limit)
	}
	now = dbTime(now)
	var fired []Firing
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT `+scheduleColumns+` FROM schedules
			WHERE enabled AND next_run_at <= $1
			ORDER BY next_run_at, name
			LIMIT $2
			FOR UPDATE SKIP LOCKED`, now, limit)
		if err != nil {
			return err
		}
		due, err := collectSchedules(rows)
		if err != nil {
			return err
		}
		for _, sc := range due {
			f, err := fireOne(ctx, tx, now, sc, plan)
			if err != nil {
				return err
			}
			fired = append(fired, f)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("fire schedules: %w", err)
	}
	return fired, nil
}

func fireOne(ctx context.Context, tx pgx.Tx, now time.Time, sc domain.Schedule, plan PlanFunc) (Firing, error) {
	f := Firing{Schedule: sc}
	nj, next, err := plan(sc)
	if err == nil {
		f.Job, err = enqueue(ctx, tx, now, nj)
		var verr *domain.ValidationError
		if err != nil && !errors.As(err, &verr) {
			return Firing{}, err
		}
	}
	if err != nil {
		f.Err = err
		_, dbErr := tx.Exec(ctx, `UPDATE schedules SET enabled = false, updated_at = $2 WHERE name = $1`, sc.Name, now)
		return f, dbErr
	}
	if next.IsZero() {
		_, err = tx.Exec(ctx, `
			UPDATE schedules SET enabled = false, last_run_at = $2, updated_at = $2 WHERE name = $1`,
			sc.Name, now)
		return f, err
	}
	f.Next = dbTime(next)
	_, err = tx.Exec(ctx, `
		UPDATE schedules SET next_run_at = $2, last_run_at = $3, updated_at = $3 WHERE name = $1`,
		sc.Name, f.Next, now)
	return f, err
}
