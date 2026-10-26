package scheduler_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/cron"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/logging"
	"github.com/relaywork/jobqueue/internal/scheduler"
	"github.com/relaywork/jobqueue/internal/store"
	"github.com/relaywork/jobqueue/internal/testdb"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) { os.Exit(testdb.Run(m, &testPool)) }

// 2025-03-10 09:02 UTC, a Monday.
var t0 = time.Date(2025, time.March, 10, 9, 2, 0, 0, time.UTC)

func setup(t *testing.T, batch int) (*scheduler.Scheduler, *store.Store, *clock.Manual) {
	t.Helper()
	db := testdb.Require(t, testPool)
	clk := clock.NewManual(t0)
	st := store.New(db, clk)
	s, err := scheduler.New(st, scheduler.Options{Interval: 10 * time.Second, BatchSize: batch, Clock: clk, Logger: logging.Discard()})
	if err != nil {
		t.Fatal(err)
	}
	return s, st, clk
}

func put(t *testing.T, st *store.Store, name, spec string, now time.Time) domain.Schedule {
	t.Helper()
	in := domain.ScheduleInput{Name: name, Spec: spec, Queue: "default", Type: "report.build",
		Payload: json.RawMessage(`{"name":"` + name + `"}`), Enabled: true}
	expr, err := in.Validate()
	if err != nil {
		t.Fatal(err)
	}
	first, err := domain.FirstRun(expr, now)
	if err != nil {
		t.Fatal(err)
	}
	sc, _, err := st.PutSchedule(context.Background(), in, first)
	if err != nil {
		t.Fatal(err)
	}
	return sc
}

func TestTickFiresDueSchedule(t *testing.T) {
	s, st, clk := setup(t, 0)
	ctx := context.Background()
	sc := put(t, st, "every-5", "*/5 * * * *", clk.Now())
	if want := time.Date(2025, time.March, 10, 9, 5, 0, 0, time.UTC); !sc.NextRunAt.Equal(want) {
		t.Fatalf("first run = %s, want %s", sc.NextRunAt, want)
	}

	if fired, err := s.Tick(ctx); err != nil || len(fired) != 0 {
		t.Fatalf("Tick before the first run fired %+v (%v)", fired, err)
	}

	clk.Set(sc.NextRunAt.Add(20 * time.Second))
	fired, err := s.Tick(ctx)
	if err != nil || len(fired) != 1 {
		t.Fatalf("Tick = %+v, %v; want one firing", fired, err)
	}
	job, err := st.Get(ctx, fired[0].Job.ID)
	if err != nil || job.Type != "report.build" || string(job.Payload) != `{"name": "every-5"}` {
		t.Errorf("enqueued job = %+v, %v", job, err)
	}
	got, _ := st.GetSchedule(ctx, "every-5")
	if want := time.Date(2025, time.March, 10, 9, 10, 0, 0, time.UTC); !got.NextRunAt.Equal(want) {
		t.Errorf("next run = %s, want %s", got.NextRunAt, want)
	}
	if fired, _ := s.Tick(ctx); len(fired) != 0 {
		t.Errorf("second Tick at the same time fired again: %+v", fired)
	}
}

func TestTickDoesNotCatchUpMissedRuns(t *testing.T) {
	s, st, clk := setup(t, 0)
	ctx := context.Background()
	put(t, st, "hourly", "0 * * * *", clk.Now())

	clk.Set(time.Date(2025, time.March, 10, 14, 30, 0, 0, time.UTC)) // five runs were missed
	fired, err := s.Tick(ctx)
	if err != nil || len(fired) != 1 {
		t.Fatalf("Tick = %d firings, %v; want exactly one", len(fired), err)
	}
	got, _ := st.GetSchedule(ctx, "hourly")
	if want := time.Date(2025, time.March, 10, 15, 0, 0, 0, time.UTC); !got.NextRunAt.Equal(want) {
		t.Errorf("next run = %s, want %s", got.NextRunAt, want)
	}
}

func TestTickDisablesScheduleWithBrokenSpec(t *testing.T) {
	s, st, clk := setup(t, 0)
	ctx := context.Background()
	put(t, st, "good", "* * * * *", clk.Now())
	// Specs are validated on the way in; this one was stored by an older version that
	// accepted six fields.
	if _, err := testPool.Exec(ctx, `
		INSERT INTO schedules (name, spec, queue, type, next_run_at, created_at, updated_at)
		VALUES ('legacy', '0 0 * * * *', 'default', 'noop', $1, $1, $1)`, t0); err != nil {
		t.Fatal(err)
	}

	clk.Advance(time.Minute)
	fired, err := s.Tick(ctx)
	if err != nil || len(fired) != 2 {
		t.Fatalf("Tick = %+v, %v", fired, err)
	}
	for _, f := range fired {
		switch f.Schedule.Name {
		case "legacy":
			if f.Err == nil || f.Job.ID != 0 {
				t.Errorf("legacy firing = %+v, want an error and no job", f)
			}
		case "good":
			if f.Err != nil || f.Job.ID == 0 {
				t.Errorf("good firing = %+v", f)
			}
		}
	}
	legacy, _ := st.GetSchedule(ctx, "legacy")
	if legacy.Enabled {
		t.Error("schedule with a broken spec is still enabled")
	}
}

func TestTickDrainsSeveralBatches(t *testing.T) {
	s, st, clk := setup(t, 2)
	for i := range 5 {
		put(t, st, fmt.Sprintf("s%d", i), "* * * * *", clk.Now())
	}
	clk.Advance(time.Minute)
	fired, err := s.Tick(context.Background())
	if err != nil || len(fired) != 5 {
		t.Fatalf("Tick fired %d schedules (%v), want 5 across three batches", len(fired), err)
	}
}

func TestPlan(t *testing.T) {
	now := time.Date(2025, time.March, 10, 9, 2, 30, 0, time.UTC)
	sc := domain.Schedule{Name: "n", Spec: "0 12 * * *", Queue: "q", Type: "t", Payload: json.RawMessage(`{}`)}
	job, next, err := scheduler.Plan(now)(sc)
	if err != nil {
		t.Fatal(err)
	}
	if job.Queue != "q" || job.Type != "t" || !job.RunAt.Equal(now) {
		t.Errorf("job = %+v", job)
	}
	if want := cron.MustParse("0 12 * * *").Next(now); !next.Equal(want) {
		t.Errorf("next = %s, want %s", next, want)
	}
	sc.Spec = "bogus"
	if _, _, err := scheduler.Plan(now)(sc); err == nil {
		t.Error("Plan accepted an invalid spec")
	}
}

// recordingStore counts FireDueSchedules calls without a database.
type recordingStore struct {
	mu    sync.Mutex
	calls []time.Time
}

func (r *recordingStore) FireDueSchedules(_ context.Context, now time.Time, _ int, _ store.PlanFunc) ([]store.Firing, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, now)
	return nil, nil
}

func (r *recordingStore) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func TestRunTicksEveryInterval(t *testing.T) {
	rs := &recordingStore{}
	clk := clock.NewManual(t0)
	s, err := scheduler.New(rs, scheduler.Options{Interval: 10 * time.Second, Clock: clk, Logger: logging.Discard()})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()

	for want := 1; want <= 3; want++ {
		clk.BlockUntil(1)
		if got := rs.count(); got != want {
			t.Fatalf("ticks = %d, want %d", got, want)
		}
		clk.Advance(10 * time.Second)
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("Run = %v after cancel", err)
	}
}

func TestNewValidatesOptions(t *testing.T) {
	if _, err := scheduler.New(&recordingStore{}, scheduler.Options{}); err == nil {
		t.Error("zero interval accepted")
	}
	if _, err := scheduler.New(&recordingStore{}, scheduler.Options{Interval: time.Second, BatchSize: -1}); err == nil {
		t.Error("negative batch size accepted")
	}
}
