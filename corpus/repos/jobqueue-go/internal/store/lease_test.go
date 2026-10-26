package store_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/store"
)

func TestLeaseOrderAndEligibility(t *testing.T) {
	s, clk := newStore(t)
	low := mustEnqueue(t, s, domain.NewJob{Priority: 0})
	high := mustEnqueue(t, s, domain.NewJob{Priority: 10})
	earlier := mustEnqueue(t, s, domain.NewJob{Priority: 0, RunAt: t0.Add(-time.Minute)})
	lowSame := mustEnqueue(t, s, domain.NewJob{Priority: 0})
	future := mustEnqueue(t, s, domain.NewJob{Priority: 100, RunAt: t0.Add(time.Hour)})
	mustEnqueue(t, s, domain.NewJob{Queue: "other", Priority: 100})

	got := mustLease(t, s, "default", "w1", 10)
	want := []int64{high.ID, earlier.ID, low.ID, lowSame.ID}
	if !slices.Equal(ids(got), want) {
		t.Fatalf("leased %v, want %v (priority, then run_at, then id; no future or other-queue jobs)", ids(got), want)
	}
	for _, j := range got {
		if j.State != domain.StateRunning || j.LockedBy != "w1" || j.Attempts != 1 {
			t.Errorf("job %d = %+v, want running, locked by w1, attempt 1", j.ID, j)
		}
		if j.LockedUntil == nil || !j.LockedUntil.Equal(clk.Now().Add(time.Minute)) {
			t.Errorf("job %d locked_until = %v, want now+1m", j.ID, j.LockedUntil)
		}
	}

	clk.Advance(time.Hour)
	if got := mustLease(t, s, "default", "w1", 10); !slices.Equal(ids(got), []int64{future.ID}) {
		t.Errorf("after an hour leased %v, want the delayed job %d", ids(got), future.ID)
	}
}

func TestLeaseRespectsLimit(t *testing.T) {
	s, _ := newStore(t)
	for range 3 {
		mustEnqueue(t, s, domain.NewJob{})
	}
	if got := mustLease(t, s, "default", "w1", 2); len(got) != 2 {
		t.Fatalf("leased %d jobs, want 2", len(got))
	}
	if got := mustLease(t, s, "default", "w1", 2); len(got) != 1 {
		t.Fatalf("leased %d jobs, want the 1 left", len(got))
	}
	if got := mustLease(t, s, "default", "w1", 2); len(got) != 0 {
		t.Fatalf("leased %d jobs from an empty queue", len(got))
	}
}

func TestLeaseRejectsBadArguments(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()
	cases := []struct {
		name   string
		worker string
		n      int
		dur    time.Duration
	}{
		{"zero n", "w1", 0, time.Minute},
		{"no worker", "", 1, time.Minute},
		{"zero duration", "w1", 1, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.Lease(ctx, "default", tc.worker, tc.n, tc.dur); err == nil {
				t.Error("Lease succeeded, want an error")
			}
		})
	}
}

func TestConcurrentLeasesNeverShareAJob(t *testing.T) {
	s, _ := newStore(t)
	const jobs, workers, perLease = 40, 8, 3
	for range jobs {
		mustEnqueue(t, s, domain.NewJob{})
	}

	start := make(chan struct{})
	var (
		mu     sync.Mutex
		owners = make(map[int64]string)
		dups   []int64
		wg     sync.WaitGroup
		errs   = make(chan error, workers)
	)
	for w := range workers {
		wg.Add(1)
		go func(worker string) {
			defer wg.Done()
			<-start
			for {
				leased, err := s.Lease(context.Background(), "default", worker, perLease, time.Minute)
				if err != nil {
					errs <- err
					return
				}
				if len(leased) == 0 {
					return
				}
				mu.Lock()
				for _, j := range leased {
					if _, taken := owners[j.ID]; taken {
						dups = append(dups, j.ID)
					}
					owners[j.ID] = worker
				}
				mu.Unlock()
			}
		}(fmt.Sprintf("w%d", w))
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if len(dups) > 0 {
		t.Fatalf("jobs leased twice: %v", dups)
	}
	if len(owners) != jobs {
		t.Fatalf("leased %d distinct jobs, want %d", len(owners), jobs)
	}
	for id, owner := range owners {
		if got := mustGet(t, s, id); got.LockedBy != owner || got.Attempts != 1 {
			t.Errorf("job %d locked by %q with %d attempts, want %q with 1", id, got.LockedBy, got.Attempts, owner)
		}
	}
}

func TestCompleteRequiresTheLease(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	job := mustEnqueue(t, s, domain.NewJob{})
	mustLease(t, s, "default", "w1", 1)

	wantErr(t, s.Complete(ctx, job.ID, "w2"), domain.ErrLeaseLost)

	clk.Advance(5 * time.Second)
	if err := s.Complete(ctx, job.ID, "w1"); err != nil {
		t.Fatal(err)
	}
	got := mustGet(t, s, job.ID)
	if got.State != domain.StateSucceeded || got.LockedBy != "" || got.LockedUntil != nil {
		t.Errorf("completed job = %+v", got)
	}
	if got.FinishedAt == nil || !got.FinishedAt.Equal(clk.Now()) {
		t.Errorf("finished_at = %v, want %s", got.FinishedAt, clk.Now())
	}

	wantErr(t, s.Complete(ctx, job.ID, "w1"), domain.ErrLeaseLost)
}

func TestFailRetriesUntilAttemptsRunOut(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	job := mustEnqueue(t, s, domain.NewJob{MaxAttempts: 2})

	mustLease(t, s, "default", "w1", 1)
	retryAt := clk.Now().Add(30 * time.Second)
	failed, err := s.Fail(ctx, job.ID, "w1", "first failure", retryAt)
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != domain.StateAvailable || !failed.RunAt.Equal(retryAt) || failed.LastError != "first failure" {
		t.Errorf("after first failure: %+v", failed)
	}
	if failed.LockedBy != "" || failed.LockedUntil != nil || failed.FinishedAt != nil {
		t.Errorf("retried job keeps lease or finish fields: %+v", failed)
	}
	if got := mustLease(t, s, "default", "w1", 1); len(got) != 0 {
		t.Fatalf("job leased before its retry time")
	}

	clk.Set(retryAt)
	again := mustLease(t, s, "default", "w2", 1)
	if len(again) != 1 || again[0].Attempts != 2 {
		t.Fatalf("second lease = %+v", again)
	}
	dead, err := s.Fail(ctx, job.ID, "w2", "second failure", clk.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if dead.State != domain.StateDead || dead.FinishedAt == nil || dead.LastError != "second failure" {
		t.Errorf("after last attempt: %+v, want dead", dead)
	}
	if !dead.RunAt.Equal(retryAt) {
		t.Errorf("dead job run_at moved to %s, want it kept at %s", dead.RunAt, retryAt)
	}
}

func TestFailRequiresTheLease(t *testing.T) {
	s, clk := newStore(t)
	job := mustEnqueue(t, s, domain.NewJob{})
	mustLease(t, s, "default", "w1", 1)
	_, err := s.Fail(context.Background(), job.ID, "w2", "boom", clk.Now())
	wantErr(t, err, domain.ErrLeaseLost)
	if got := mustGet(t, s, job.ID); got.State != domain.StateRunning || got.LastError != "" {
		t.Errorf("job changed by a worker without the lease: %+v", got)
	}
}

func TestFailStoresUnstorableErrorText(t *testing.T) {
	s, clk := newStore(t)
	job := mustEnqueue(t, s, domain.NewJob{})
	mustLease(t, s, "default", "w1", 1)

	msg := "bad\x00byte \xff " + strings.Repeat("é", 5000)
	failed, err := s.Fail(context.Background(), job.ID, "w1", msg, clk.Now())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(failed.LastError, "\x00") || !utf8.ValidString(failed.LastError) {
		t.Errorf("stored error is not clean text: %q", failed.LastError[:20])
	}
	if len(failed.LastError) > 4096+len("…") {
		t.Errorf("stored error is %d bytes, want it truncated", len(failed.LastError))
	}
	if !strings.HasPrefix(failed.LastError, "badbyte") {
		t.Errorf("stored error starts %q", failed.LastError[:10])
	}
}

func TestDiscardFailsPermanently(t *testing.T) {
	s, _ := newStore(t)
	job := mustEnqueue(t, s, domain.NewJob{MaxAttempts: 5})
	mustLease(t, s, "default", "w1", 1)

	failed, err := s.Discard(context.Background(), job.ID, "w1", "malformed payload")
	if err != nil {
		t.Fatal(err)
	}
	if failed.State != domain.StateFailed || failed.FinishedAt == nil || failed.LastError != "malformed payload" {
		t.Errorf("discarded job = %+v", failed)
	}
	_, err = s.Discard(context.Background(), job.ID, "w1", "again")
	wantErr(t, err, domain.ErrLeaseLost)
}

func TestExtendLease(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	job := mustEnqueue(t, s, domain.NewJob{})
	mustLease(t, s, "default", "w1", 1)

	until := clk.Now().Add(10 * time.Minute)
	if err := s.ExtendLease(ctx, job.ID, "w1", until); err != nil {
		t.Fatal(err)
	}
	if got := mustGet(t, s, job.ID); got.LockedUntil == nil || !got.LockedUntil.Equal(until) {
		t.Errorf("locked_until = %v, want %s", got.LockedUntil, until)
	}

	t.Run("other worker", func(t *testing.T) {
		wantErr(t, s.ExtendLease(ctx, job.ID, "w2", until), domain.ErrLeaseLost)
	})
	t.Run("deadline in the past", func(t *testing.T) {
		if err := s.ExtendLease(ctx, job.ID, "w1", clk.Now()); err == nil {
			t.Error("extending to now succeeded")
		}
	})
	t.Run("expired lease not yet reaped", func(t *testing.T) {
		clk.Advance(11 * time.Minute)
		if err := s.ExtendLease(ctx, job.ID, "w1", clk.Now().Add(time.Minute)); err != nil {
			t.Errorf("ExtendLease after expiry but before reaping: %v", err)
		}
	})
	t.Run("finished job", func(t *testing.T) {
		if err := s.Complete(ctx, job.ID, "w1"); err != nil {
			t.Fatal(err)
		}
		wantErr(t, s.ExtendLease(ctx, job.ID, "w1", clk.Now().Add(time.Minute)), domain.ErrLeaseLost)
	})
}

func TestReapExpired(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()
	retry := mustEnqueue(t, s, domain.NewJob{Queue: "a", MaxAttempts: 3})
	last := mustEnqueue(t, s, domain.NewJob{Queue: "b", MaxAttempts: 1})
	fresh := mustEnqueue(t, s, domain.NewJob{Queue: "c"})
	mustLease(t, s, "a", "wa", 1) // lease of one minute
	mustLease(t, s, "b", "wb", 1)

	clk.Advance(30 * time.Second)
	if _, err := s.Lease(ctx, "c", "wc", 1, time.Hour); err != nil {
		t.Fatal(err)
	}
	if reaped, err := s.ReapExpired(ctx, clk.Now()); err != nil || len(reaped) != 0 {
		t.Fatalf("reaped %v before any lease expired (err %v)", ids(reaped), err)
	}

	clk.Advance(time.Minute)
	reaped, err := s.ReapExpired(ctx, clk.Now())
	if err != nil {
		t.Fatal(err)
	}
	states := make(map[int64]domain.State)
	for _, j := range reaped {
		states[j.ID] = j.State
		if j.LockedBy != "" || j.LockedUntil != nil || !strings.Contains(j.LastError, "expired") {
			t.Errorf("reaped job %d = %+v", j.ID, j)
		}
	}
	if len(reaped) != 2 || states[retry.ID] != domain.StateAvailable || states[last.ID] != domain.StateDead {
		t.Fatalf("reaped states = %v, want %d available and %d dead", states, retry.ID, last.ID)
	}
	if got := mustGet(t, s, retry.ID); !got.RunAt.Equal(clk.Now()) {
		t.Errorf("reaped job run_at = %s, want now", got.RunAt)
	}
	if got := mustGet(t, s, fresh.ID); got.State != domain.StateRunning {
		t.Errorf("job with a live lease was reaped: %+v", got)
	}

	// The worker whose lease expired can no longer settle the job.
	wantErr(t, s.Complete(ctx, retry.ID, "wa"), domain.ErrLeaseLost)
	if again := mustLease(t, s, "a", "wa2", 1); len(again) != 1 || again[0].Attempts != 2 {
		t.Errorf("reaped job lease = %+v, want attempt 2", again)
	}
}

func TestReapExpiredWorksInBatches(t *testing.T) {
	if testing.Short() {
		t.Skip("enqueues more than one reap batch")
	}
	s, clk := newStore(t)
	ctx := context.Background()
	total := store.ReapBatchSize + 7
	if _, err := testPool.Exec(ctx, `
		INSERT INTO jobs (queue, type, state, attempts, max_attempts, run_at, locked_by, locked_until, created_at, updated_at)
		SELECT 'default', 'noop', 'running', 1, 5, $1, 'gone', $1, $1, $1 FROM generate_series(1, $2)`,
		clk.Now(), total); err != nil {
		t.Fatal(err)
	}
	clk.Advance(time.Second)

	first, err := s.ReapExpired(ctx, clk.Now())
	if err != nil || len(first) != store.ReapBatchSize {
		t.Fatalf("first batch: %d jobs, %v; want %d", len(first), err, store.ReapBatchSize)
	}
	second, err := s.ReapExpired(ctx, clk.Now())
	if err != nil || len(second) != 7 {
		t.Fatalf("second batch: %d jobs, %v; want 7", len(second), err)
	}
}
