package store_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/store"
)

func scheduleInput(name, spec string) domain.ScheduleInput {
	return domain.ScheduleInput{Name: name, Spec: spec, Queue: "default", Type: "noop", Payload: payload(`{"k":1}`), Enabled: true}
}

func TestPutScheduleCreatesAndReplaces(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	first := t0.Add(time.Hour)

	sc, created, err := s.PutSchedule(ctx, scheduleInput("hourly", "0 * * * *"), first)
	if err != nil {
		t.Fatal(err)
	}
	if !created || !sc.NextRunAt.Equal(first) || !sc.Enabled || sc.LastRunAt != nil {
		t.Errorf("created schedule = %+v (created %v)", sc, created)
	}

	clk.Advance(time.Minute)
	in := scheduleInput("hourly", "0 * * * *")
	in.Queue = "other"
	sc, created, err = s.PutSchedule(ctx, in, first.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if created || sc.Queue != "other" {
		t.Errorf("replaced schedule = %+v (created %v)", sc, created)
	}
	if !sc.NextRunAt.Equal(first) {
		t.Errorf("same spec moved next_run_at to %s, want the pending run %s kept", sc.NextRunAt, first)
	}
	if !sc.CreatedAt.Equal(t0) || !sc.UpdatedAt.Equal(clk.Now()) {
		t.Errorf("created_at %s updated_at %s", sc.CreatedAt, sc.UpdatedAt)
	}

	sc, _, err = s.PutSchedule(ctx, scheduleInput("hourly", "30 * * * *"), t0.Add(30*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !sc.NextRunAt.Equal(t0.Add(30 * time.Minute)) {
		t.Errorf("new spec kept next_run_at %s", sc.NextRunAt)
	}
}

func TestPutScheduleReenablingRecomputesNextRun(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()
	in := scheduleInput("nightly", "0 3 * * *")
	in.Enabled = false
	if _, _, err := s.PutSchedule(ctx, in, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	in.Enabled = true
	sc, _, err := s.PutSchedule(ctx, in, t0.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !sc.NextRunAt.Equal(t0.Add(2 * time.Hour)) {
		t.Errorf("next_run_at = %s, want the newly computed first run", sc.NextRunAt)
	}
}

func TestGetListDeleteSchedule(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()
	for _, name := range []string{"b", "a"} {
		if _, _, err := s.PutSchedule(ctx, scheduleInput(name, "@daily"), t0.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	list, err := s.ListSchedules(ctx)
	if err != nil || len(list) != 2 || list[0].Name != "a" || list[1].Name != "b" {
		t.Fatalf("ListSchedules = %+v, %v", list, err)
	}
	sc, err := s.GetSchedule(ctx, "a")
	if err != nil || sc.Spec != "@daily" || string(sc.Payload) != `{"k": 1}` {
		t.Errorf("GetSchedule = %+v, %v", sc, err)
	}
	if err := s.DeleteSchedule(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	_, err = s.GetSchedule(ctx, "a")
	wantErr(t, err, domain.ErrNotFound)
	wantErr(t, s.DeleteSchedule(ctx, "a"), domain.ErrNotFound)
}

// planEvery returns a plan that enqueues the schedule's job and fires again after d.
func planEvery(now time.Time, d time.Duration) store.PlanFunc {
	return func(sc domain.Schedule) (domain.NewJob, time.Time, error) {
		return sc.Job(now), now.Add(d), nil
	}
}

func TestFireDueSchedules(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	if _, _, err := s.PutSchedule(ctx, scheduleInput("due", "* * * * *"), t0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.PutSchedule(ctx, scheduleInput("later", "* * * * *"), t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	disabled := scheduleInput("off", "* * * * *")
	disabled.Enabled = false
	if _, _, err := s.PutSchedule(ctx, disabled, t0); err != nil {
		t.Fatal(err)
	}

	now := clk.Now()
	fired, err := s.FireDueSchedules(ctx, now, 10, planEvery(now, time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(fired) != 1 || fired[0].Schedule.Name != "due" || fired[0].Err != nil {
		t.Fatalf("fired = %+v, want only the due schedule", fired)
	}
	job := mustGet(t, s, fired[0].Job.ID)
	if job.Type != "noop" || job.Queue != "default" || string(job.Payload) != `{"k": 1}` || !job.RunAt.Equal(now) {
		t.Errorf("enqueued job = %+v", job)
	}
	sc, _ := s.GetSchedule(ctx, "due")
	if !sc.NextRunAt.Equal(now.Add(time.Minute)) || sc.LastRunAt == nil || !sc.LastRunAt.Equal(now) {
		t.Errorf("schedule after firing = %+v", sc)
	}

	again, err := s.FireDueSchedules(ctx, now, 10, planEvery(now, time.Minute))
	if err != nil || len(again) != 0 {
		t.Errorf("second call fired %+v (err %v), want nothing", again, err)
	}
}

func TestFireDueSchedulesDisablesBrokenSchedule(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	for _, name := range []string{"broken", "fine"} {
		if _, _, err := s.PutSchedule(ctx, scheduleInput(name, "* * * * *"), t0); err != nil {
			t.Fatal(err)
		}
	}
	now := clk.Now()
	planErr := errors.New("cannot plan")
	fired, err := s.FireDueSchedules(ctx, now, 10, func(sc domain.Schedule) (domain.NewJob, time.Time, error) {
		if sc.Name == "broken" {
			return domain.NewJob{}, time.Time{}, planErr
		}
		return sc.Job(now), now.Add(time.Minute), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(fired) != 2 || !errors.Is(fired[0].Err, planErr) || fired[1].Err != nil || fired[1].Job.ID == 0 {
		t.Fatalf("fired = %+v", fired)
	}
	if sc, _ := s.GetSchedule(ctx, "broken"); sc.Enabled {
		t.Error("broken schedule is still enabled")
	}
	if sc, _ := s.GetSchedule(ctx, "fine"); !sc.Enabled {
		t.Error("working schedule was disabled")
	}
}

func TestFireDueSchedulesDisablesFinishedSchedule(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	if _, _, err := s.PutSchedule(ctx, scheduleInput("once", "0 0 1 1 *"), t0); err != nil {
		t.Fatal(err)
	}
	now := clk.Now()
	fired, err := s.FireDueSchedules(ctx, now, 10, func(sc domain.Schedule) (domain.NewJob, time.Time, error) {
		return sc.Job(now), time.Time{}, nil
	})
	if err != nil || len(fired) != 1 || fired[0].Job.ID == 0 || !fired[0].Next.IsZero() {
		t.Fatalf("fired = %+v, %v", fired, err)
	}
	sc, _ := s.GetSchedule(ctx, "once")
	if sc.Enabled || sc.LastRunAt == nil {
		t.Errorf("schedule after its last run = %+v, want disabled with last_run_at set", sc)
	}
}

func TestConcurrentFiringEnqueuesOnce(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	const schedules = 20
	for i := range schedules {
		name := "s" + string(rune('a'+i))
		if _, _, err := s.PutSchedule(ctx, scheduleInput(name, "* * * * *"), t0); err != nil {
			t.Fatal(err)
		}
	}
	now := clk.Now()

	// Both callers hold their transaction open until the other has claimed its rows, so the
	// second one must skip what the first has locked rather than fire it again.
	claimed := make(chan struct{}, 2)
	proceed := make(chan struct{})
	plan := func(sc domain.Schedule) (domain.NewJob, time.Time, error) {
		return sc.Job(now), now.Add(time.Minute), nil
	}
	var wg sync.WaitGroup
	results := make([][]store.Firing, 2)
	errs := make([]error, 2)
	for i := range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			first := true
			results[i], errs[i] = s.FireDueSchedules(ctx, now, 10, func(sc domain.Schedule) (domain.NewJob, time.Time, error) {
				if first {
					first = false
					claimed <- struct{}{}
					<-proceed
				}
				return plan(sc)
			})
		}()
	}
	<-claimed
	<-claimed
	close(proceed)
	wg.Wait()

	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := len(results[0]) + len(results[1]); n != schedules {
		t.Errorf("fired %d schedules in total, want %d", n, schedules)
	}
	page, err := s.List(ctx, store.ListFilter{Limit: 100})
	if err != nil || len(page.Jobs) != schedules {
		t.Errorf("enqueued %d jobs (err %v), want %d", len(page.Jobs), err, schedules)
	}
}
