package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/store"
)

func TestEnqueueAppliesDefaults(t *testing.T) {
	s, _ := newStore(t)
	job := mustEnqueue(t, s, domain.NewJob{Queue: "emails", Type: "email.send"})

	if job.ID == 0 {
		t.Fatal("job has no id")
	}
	if job.State != domain.StateAvailable || job.Attempts != 0 || job.MaxAttempts != domain.DefaultMaxAttempts {
		t.Errorf("job = %+v, want available with 0/%d attempts", job, domain.DefaultMaxAttempts)
	}
	if string(job.Payload) != "{}" {
		t.Errorf("payload = %s, want {}", job.Payload)
	}
	if !job.RunAt.Equal(t0) || !job.CreatedAt.Equal(t0) || !job.UpdatedAt.Equal(t0) {
		t.Errorf("timestamps = run %s created %s updated %s, want all %s", job.RunAt, job.CreatedAt, job.UpdatedAt, t0)
	}
	if job.LockedBy != "" || job.LockedUntil != nil || job.FinishedAt != nil {
		t.Errorf("new job has lease or finish fields set: %+v", job)
	}
}

func TestEnqueueRoundTripsFields(t *testing.T) {
	s, _ := newStore(t)
	runAt := t0.Add(time.Hour)
	job := mustEnqueue(t, s, domain.NewJob{
		Queue:       "reports",
		Type:        "report.build",
		Payload:     payload(`{"account": 42, "tags": ["a", "b"]}`),
		Priority:    7,
		MaxAttempts: 3,
		RunAt:       runAt,
	})
	got := mustGet(t, s, job.ID)
	if got.Queue != "reports" || got.Type != "report.build" || got.Priority != 7 || got.MaxAttempts != 3 {
		t.Errorf("got %+v", got)
	}
	if !got.RunAt.Equal(runAt) {
		t.Errorf("run_at = %s, want %s", got.RunAt, runAt)
	}
	var p struct {
		Account int      `json:"account"`
		Tags    []string `json:"tags"`
	}
	if err := json.Unmarshal(got.Payload, &p); err != nil || p.Account != 42 || !slices.Equal(p.Tags, []string{"a", "b"}) {
		t.Errorf("payload = %s (%v)", got.Payload, err)
	}
}

func TestEnqueueRejectsInvalidJob(t *testing.T) {
	s, _ := newStore(t)
	_, err := s.Enqueue(context.Background(), domain.NewJob{Queue: "Bad Queue", Type: "", Payload: payload(`[1]`)})
	var verr *domain.ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("error = %v, want a ValidationError", err)
	}
	fields := make([]string, len(verr.Fields))
	for i, f := range verr.Fields {
		fields[i] = f.Field
	}
	if !slices.Equal(fields, []string{"queue", "type", "payload"}) {
		t.Errorf("invalid fields = %v", fields)
	}
}

func TestGetUnknownJob(t *testing.T) {
	s, _ := newStore(t)
	_, err := s.Get(context.Background(), 999)
	wantErr(t, err, domain.ErrNotFound)
}

func TestListPaginatesByID(t *testing.T) {
	s, _ := newStore(t)
	var all []int64
	for range 5 {
		all = append(all, mustEnqueue(t, s, domain.NewJob{}).ID)
	}
	ctx := context.Background()

	var seen []int64
	after := int64(0)
	pages := 0
	for {
		page, err := s.List(ctx, store.ListFilter{After: after, Limit: 2})
		if err != nil {
			t.Fatal(err)
		}
		pages++
		seen = append(seen, ids(page.Jobs)...)
		if page.NextAfter == 0 {
			break
		}
		after = page.NextAfter
	}
	if !slices.Equal(seen, all) || pages != 3 {
		t.Errorf("listed %v in %d pages, want %v in 3", seen, pages, all)
	}
}

func TestListExactPageHasNoNextCursor(t *testing.T) {
	s, _ := newStore(t)
	for range 2 {
		mustEnqueue(t, s, domain.NewJob{})
	}
	page, err := s.List(context.Background(), store.ListFilter{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Jobs) != 2 || page.NextAfter != 0 {
		t.Errorf("got %d jobs, next %d; want 2 jobs and no next page", len(page.Jobs), page.NextAfter)
	}
}

func TestListFilters(t *testing.T) {
	s, _ := newStore(t)
	a1 := mustEnqueue(t, s, domain.NewJob{Queue: "a"})
	a2 := mustEnqueue(t, s, domain.NewJob{Queue: "a"})
	b1 := mustEnqueue(t, s, domain.NewJob{Queue: "b"})
	if _, err := s.Cancel(context.Background(), a2.ID); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name   string
		filter store.ListFilter
		want   []int64
	}{
		{"all", store.ListFilter{}, []int64{a1.ID, a2.ID, b1.ID}},
		{"queue", store.ListFilter{Queue: "a"}, []int64{a1.ID, a2.ID}},
		{"state", store.ListFilter{State: domain.StateAvailable}, []int64{a1.ID, b1.ID}},
		{"queue and state", store.ListFilter{Queue: "a", State: domain.StateCancelled}, []int64{a2.ID}},
		{"after", store.ListFilter{After: a1.ID}, []int64{a2.ID, b1.ID}},
		{"no match", store.ListFilter{Queue: "c"}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			page, err := s.List(context.Background(), tc.filter)
			if err != nil {
				t.Fatal(err)
			}
			if got := ids(page.Jobs); !slices.Equal(got, tc.want) {
				t.Errorf("ids = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestListRejectsBadLimit(t *testing.T) {
	s, _ := newStore(t)
	for _, limit := range []int{-1, store.MaxPageSize + 1} {
		_, err := s.List(context.Background(), store.ListFilter{Limit: limit})
		var verr *domain.ValidationError
		if !errors.As(err, &verr) {
			t.Errorf("limit %d: error = %v, want a ValidationError", limit, err)
		}
	}
}

func TestCancel(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	job := mustEnqueue(t, s, domain.NewJob{})
	clk.Advance(time.Second)

	cancelled, err := s.Cancel(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.State != domain.StateCancelled || cancelled.FinishedAt == nil || !cancelled.FinishedAt.Equal(clk.Now()) {
		t.Errorf("cancelled job = %+v", cancelled)
	}

	t.Run("twice", func(t *testing.T) {
		_, err := s.Cancel(ctx, job.ID)
		wantErr(t, err, domain.ErrConflict)
	})
	t.Run("running job", func(t *testing.T) {
		running := mustEnqueue(t, s, domain.NewJob{Queue: "busy"})
		mustLease(t, s, "busy", "w1", 1)
		_, err := s.Cancel(ctx, running.ID)
		wantErr(t, err, domain.ErrConflict)
		if got := mustGet(t, s, running.ID); got.State != domain.StateRunning {
			t.Errorf("state = %s, want running", got.State)
		}
	})
	t.Run("unknown job", func(t *testing.T) {
		_, err := s.Cancel(ctx, 12345)
		wantErr(t, err, domain.ErrNotFound)
	})
}

func TestRequeueDeadJob(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	job := mustEnqueue(t, s, domain.NewJob{MaxAttempts: 1})
	mustLease(t, s, "default", "w1", 1)
	dead, err := s.Fail(ctx, job.ID, "w1", "boom", clk.Now())
	if err != nil || dead.State != domain.StateDead {
		t.Fatalf("Fail: %+v, %v; want dead", dead, err)
	}

	page, err := s.ListDead(ctx, "", 0, 0)
	if err != nil || !slices.Equal(ids(page.Jobs), []int64{job.ID}) {
		t.Fatalf("ListDead = %v, %v", ids(page.Jobs), err)
	}

	clk.Advance(time.Hour)
	requeued, err := s.Requeue(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if requeued.State != domain.StateAvailable || requeued.Attempts != 0 || requeued.FinishedAt != nil {
		t.Errorf("requeued = %+v", requeued)
	}
	if !requeued.RunAt.Equal(clk.Now()) {
		t.Errorf("run_at = %s, want now (%s)", requeued.RunAt, clk.Now())
	}
	if requeued.LastError != "boom" {
		t.Errorf("last_error = %q, want the error kept for reference", requeued.LastError)
	}
	if leased := mustLease(t, s, "default", "w2", 1); len(leased) != 1 || leased[0].ID != job.ID {
		t.Errorf("requeued job was not leasable: %v", ids(leased))
	}
}

func TestRequeueOnlyDeadJobs(t *testing.T) {
	s, _ := newStore(t)
	job := mustEnqueue(t, s, domain.NewJob{})
	_, err := s.Requeue(context.Background(), job.ID)
	wantErr(t, err, domain.ErrConflict)
	_, err = s.Requeue(context.Background(), job.ID+100)
	wantErr(t, err, domain.ErrNotFound)
}
