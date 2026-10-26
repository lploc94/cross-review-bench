package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/store"
)

// A batch is enqueued as a whole: when its third job cannot be stored, neither can the first two,
// whether validation or the database rejects it.
func TestEnqueueBatchIsAllOrNothing(t *testing.T) {
	s, _ := newStore(t)
	ctx := context.Background()
	count := func(t *testing.T, queue string) int {
		t.Helper()
		page, err := s.List(ctx, store.ListFilter{Queue: queue})
		if err != nil {
			t.Fatal(err)
		}
		return len(page.Jobs)
	}

	t.Run("third job invalid", func(t *testing.T) {
		_, err := s.EnqueueBatch(ctx, []domain.NewJob{
			{Queue: "atomic-invalid", Type: "row.import"},
			{Queue: "atomic-invalid", Type: "row.import"},
			{Queue: "atomic-invalid", Type: ""},
		})
		var verr *domain.ValidationError
		if !errors.As(err, &verr) || verr.Fields[0].Field != "jobs[2].type" {
			t.Fatalf("error = %v, want a ValidationError for jobs[2].type", err)
		}
		if n := count(t, "atomic-invalid"); n != 0 {
			t.Errorf("queue holds %d jobs after a rejected batch, want 0", n)
		}
	})

	t.Run("third job rejected by the database", func(t *testing.T) {
		// Valid JSON object, but jsonb cannot store a NUL character.
		_, err := s.EnqueueBatch(ctx, []domain.NewJob{
			{Queue: "atomic-db", Type: "row.import"},
			{Queue: "atomic-db", Type: "row.import"},
			{Queue: "atomic-db", Type: "row.import", Payload: payload(`{"note":"\u0000"}`)},
		})
		if err == nil {
			t.Fatal("batch with a payload jsonb rejects was enqueued")
		}
		if n := count(t, "atomic-db"); n != 0 {
			t.Errorf("queue holds %d jobs after a failed batch, want 0", n)
		}
	})

	t.Run("valid batch after a rejected one", func(t *testing.T) {
		jobs, err := s.EnqueueBatch(ctx, []domain.NewJob{
			{Queue: "atomic-retry", Type: "row.import"},
			{Queue: "atomic-retry", Type: "row.import"},
		})
		if err != nil || len(jobs) != 2 {
			t.Fatalf("EnqueueBatch = %d jobs, %v", len(jobs), err)
		}
		if n := count(t, "atomic-retry"); n != 2 {
			t.Errorf("queue holds %d jobs, want 2", n)
		}
	})
}
