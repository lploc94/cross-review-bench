package worker

import (
	"context"
	"errors"
	"time"

	"github.com/relaywork/jobqueue/internal/clock"
)

// ErrNoLease is returned by ExtendLease when the context does not belong to a running job.
var ErrNoLease = errors.New("worker: context does not carry a job lease")

type leaseKey struct{}

// lease is what a handler's context knows about the job it runs.
type lease struct {
	jobID    int64
	workerID string
	store    Store
	clock    clock.Clock
	duration time.Duration
}

func withLease(ctx context.Context, l *lease) context.Context {
	return context.WithValue(ctx, leaseKey{}, l)
}

// ExtendLease pushes the lease of the job running under ctx to one lease duration from now.
// Handlers that may run longer than the lease call it periodically; without it, the reaper
// hands the job to another worker once the lease expires. It returns domain.ErrLeaseLost when
// the job has already been reaped.
func ExtendLease(ctx context.Context) error {
	l, ok := ctx.Value(leaseKey{}).(*lease)
	if !ok {
		return ErrNoLease
	}
	return l.store.ExtendLease(ctx, l.jobID, l.workerID, l.clock.Now().Add(l.duration))
}

// WorkerID returns the lease owner name of the worker running the job under ctx, or "" when
// ctx does not belong to a running job.
func WorkerID(ctx context.Context) string {
	if l, ok := ctx.Value(leaseKey{}).(*lease); ok {
		return l.workerID
	}
	return ""
}
