package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/store"
	"github.com/relaywork/jobqueue/internal/testdb"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) { os.Exit(testdb.Run(m, &testPool)) }

// t0 is the manual clock's starting time in every test.
var t0 = time.Date(2025, time.March, 10, 9, 0, 0, 0, time.UTC)

func newStore(t *testing.T) (*store.Store, *clock.Manual) {
	t.Helper()
	pool := testdb.Require(t, testPool)
	clk := clock.NewManual(t0)
	return store.New(pool, clk), clk
}

func mustEnqueue(t *testing.T, s *store.Store, nj domain.NewJob) domain.Job {
	t.Helper()
	if nj.Queue == "" {
		nj.Queue = "default"
	}
	if nj.Type == "" {
		nj.Type = "noop"
	}
	job, err := s.Enqueue(context.Background(), nj)
	if err != nil {
		t.Fatalf("Enqueue(%+v): %v", nj, err)
	}
	return job
}

func mustLease(t *testing.T, s *store.Store, queue, worker string, n int) []domain.Job {
	t.Helper()
	jobs, err := s.Lease(context.Background(), queue, worker, n, time.Minute)
	if err != nil {
		t.Fatalf("Lease: %v", err)
	}
	return jobs
}

func mustGet(t *testing.T, s *store.Store, id int64) domain.Job {
	t.Helper()
	job, err := s.Get(context.Background(), id)
	if err != nil {
		t.Fatalf("Get(%d): %v", id, err)
	}
	return job
}

func ids(jobs []domain.Job) []int64 {
	out := make([]int64, len(jobs))
	for i, j := range jobs {
		out[i] = j.ID
	}
	return out
}

func wantErr(t *testing.T, err, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("error = %v, want %v", err, target)
	}
}

func payload(s string) json.RawMessage { return json.RawMessage(s) }
