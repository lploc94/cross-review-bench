package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/store"
)

// A dead job that an operator requeues while a purge is deleting it must survive the purge.
func TestPurgeKeepsAJobRequeuedMeanwhile(t *testing.T) {
	s, clk := newStore(t)
	ctx := context.Background()

	dead := mustEnqueue(t, s, domain.NewJob{Queue: "default", MaxAttempts: 1})
	mustLease(t, s, "default", "w1", 1)
	if _, err := s.Fail(ctx, dead.ID, "w1", "upstream unavailable", t0); err != nil {
		t.Fatal(err)
	}
	cancelled := mustEnqueue(t, s, domain.NewJob{Queue: "default"})
	if _, err := s.Cancel(ctx, cancelled.ID); err != nil {
		t.Fatal(err)
	}
	clk.Advance(15 * 24 * time.Hour)
	cutoff := clk.Now().Add(-14 * 24 * time.Hour)

	// The operator's requeue holds the dead job's row while the purge runs.
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var pid int
	if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT id FROM jobs WHERE id = $1 FOR UPDATE`, dead.ID); err != nil {
		t.Fatal(err)
	}

	type result struct {
		purged []store.PurgedJob
		err    error
	}
	done := make(chan result, 1)
	go func() {
		purged, err := s.PurgeFinished(ctx, cutoff)
		done <- result{purged, err}
	}()

	// Let the purge get as far as it can: finished, or waiting for the locked row.
	var finished *result
	deadline := time.Now().Add(20 * time.Second)
	for finished == nil {
		var blocked bool
		err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted AND $1 = ANY(pg_blocking_pids(pid)))`, pid).Scan(&blocked)
		if err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the purge neither finished nor waited for the locked job")
		}
		select {
		case r := <-done:
			finished = &r
		case <-time.After(5 * time.Millisecond):
		}
	}

	// Requeue the job the way Store.Requeue does, and commit.
	tag, err := tx.Exec(ctx, `
		UPDATE jobs SET state = 'available', attempts = 0, run_at = $2, finished_at = NULL, updated_at = $2
		WHERE id = $1 AND state = 'dead'`, dead.ID, clk.Now())
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("requeue: %v (%d rows)", err, tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if finished == nil {
		r := <-done
		finished = &r
	}
	if finished.err != nil {
		t.Fatalf("PurgeFinished: %v", finished.err)
	}

	job, err := s.Get(ctx, dead.ID)
	if err != nil {
		t.Fatalf("requeued job %d was purged: %v", dead.ID, err)
	}
	if job.State != domain.StateAvailable || job.FinishedAt != nil {
		t.Errorf("requeued job = %+v, want available with no finished_at", job)
	}
	if _, err := s.Get(ctx, cancelled.ID); err == nil {
		t.Errorf("old cancelled job %d was not purged", cancelled.ID)
	}
}
