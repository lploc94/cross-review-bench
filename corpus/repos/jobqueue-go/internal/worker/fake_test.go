package worker_test

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
)

// fakeStore is an in-memory worker.Store that records how jobs were settled.
type fakeStore struct {
	mu        sync.Mutex
	available []domain.Job
	running   map[int64]domain.Job
	leases    int
	completed []int64
	failed    []failCall
	discarded []failCall
	extended  []extendCall

	settleErr error // returned by Complete, Fail and Discard when set
	leaseErrs int   // the next leaseErrs Lease calls fail
}

var errDatabaseDown = errors.New("fake: database is down")

type failCall struct {
	id       int64
	workerID string
	msg      string
	retryAt  time.Time
	ctxErr   error // the context's error when the call was made
}

type extendCall struct {
	id       int64
	workerID string
	until    time.Time
}

func newFakeStore(jobs ...domain.Job) *fakeStore {
	f := &fakeStore{running: make(map[int64]domain.Job)}
	f.add(jobs...)
	return f
}

func (f *fakeStore) add(jobs ...domain.Job) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, j := range jobs {
		if j.Queue == "" {
			j.Queue = "default"
		}
		if j.MaxAttempts == 0 {
			j.MaxAttempts = 3
		}
		j.State = domain.StateAvailable
		f.available = append(f.available, j)
	}
}

func (f *fakeStore) Lease(_ context.Context, queue, workerID string, n int, _ time.Duration) ([]domain.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.leases++
	if f.leaseErrs > 0 {
		f.leaseErrs--
		return nil, errDatabaseDown
	}
	var out, rest []domain.Job
	for _, j := range f.available {
		if j.Queue == queue && len(out) < n {
			j.State = domain.StateRunning
			j.LockedBy = workerID
			j.Attempts++
			f.running[j.ID] = j
			out = append(out, j)
			continue
		}
		rest = append(rest, j)
	}
	f.available = rest
	return out, nil
}

func (f *fakeStore) Complete(_ context.Context, id int64, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.settleErr != nil {
		return f.settleErr
	}
	f.completed = append(f.completed, id)
	delete(f.running, id)
	return nil
}

func (f *fakeStore) Fail(ctx context.Context, id int64, workerID, msg string, retryAt time.Time) (domain.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.settleErr != nil {
		return domain.Job{}, f.settleErr
	}
	f.failed = append(f.failed, failCall{id: id, workerID: workerID, msg: msg, retryAt: retryAt, ctxErr: ctx.Err()})
	j, ok := f.running[id]
	if !ok {
		return domain.Job{}, errors.New("fake: job is not running")
	}
	delete(f.running, id)
	j.LastError = msg
	if j.AttemptsExhausted() {
		j.State = domain.StateDead
	} else {
		j.State = domain.StateAvailable
	}
	return j, nil
}

func (f *fakeStore) Discard(ctx context.Context, id int64, workerID, msg string) (domain.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.settleErr != nil {
		return domain.Job{}, f.settleErr
	}
	f.discarded = append(f.discarded, failCall{id: id, workerID: workerID, msg: msg, ctxErr: ctx.Err()})
	j := f.running[id]
	delete(f.running, id)
	j.State = domain.StateFailed
	return j, nil
}

func (f *fakeStore) ExtendLease(_ context.Context, id int64, workerID string, until time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.extended = append(f.extended, extendCall{id: id, workerID: workerID, until: until})
	return nil
}

// calls is a copy of what a fakeStore recorded.
type calls struct {
	leases    int
	completed []int64
	failed    []failCall
	discarded []failCall
	extended  []extendCall
}

func (f *fakeStore) snapshot() calls {
	f.mu.Lock()
	defer f.mu.Unlock()
	return calls{
		leases:    f.leases,
		completed: append([]int64(nil), f.completed...),
		failed:    append([]failCall(nil), f.failed...),
		discarded: append([]failCall(nil), f.discarded...),
		extended:  append([]extendCall(nil), f.extended...),
	}
}
