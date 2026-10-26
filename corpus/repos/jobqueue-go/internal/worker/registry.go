package worker

import (
	"context"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
)

// HandlerFunc runs one attempt of a job. Returning nil completes the job; returning an error
// fails the attempt, and the job is retried while it has attempts left, unless the error is
// wrapped with domain.Permanent. The context is cancelled when the type's timeout expires.
type HandlerFunc func(ctx context.Context, job domain.Job) error

// HandlerOption configures a registered handler.
type HandlerOption func(*handler)

// WithTimeout sets how long one attempt of the job type may run. Handlers that need longer
// than the lease duration must call ExtendLease while they run.
func WithTimeout(d time.Duration) HandlerOption {
	return func(h *handler) { h.timeout = d }
}

type handler struct {
	fn      HandlerFunc
	timeout time.Duration
}

// Registry maps job types to handlers. It is safe for concurrent use.
type Registry struct {
	mu             sync.RWMutex
	handlers       map[string]handler
	defaultTimeout time.Duration
}

// NewRegistry returns an empty registry whose handlers time out after defaultTimeout unless
// registered with WithTimeout.
func NewRegistry(defaultTimeout time.Duration) *Registry {
	if defaultTimeout <= 0 {
		panic("worker: default handler timeout must be positive")
	}
	return &Registry{handlers: make(map[string]handler), defaultTimeout: defaultTimeout}
}

// Register installs fn as the handler of jobType. It panics if jobType is invalid, already
// registered, or given a non-positive timeout: registration happens at startup, where these
// are programming errors.
func (r *Registry) Register(jobType string, fn HandlerFunc, opts ...HandlerOption) {
	if err := domain.ValidateJobType(jobType); err != nil {
		panic(fmt.Sprintf("worker: job type %q %s", jobType, err))
	}
	if fn == nil {
		panic(fmt.Sprintf("worker: nil handler for job type %q", jobType))
	}
	h := handler{fn: fn, timeout: r.defaultTimeout}
	for _, opt := range opts {
		opt(&h)
	}
	if h.timeout <= 0 {
		panic(fmt.Sprintf("worker: timeout for job type %q must be positive", jobType))
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.handlers[jobType]; dup {
		panic(fmt.Sprintf("worker: job type %q registered twice", jobType))
	}
	r.handlers[jobType] = h
}

func (r *Registry) lookup(jobType string) (handler, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	h, ok := r.handlers[jobType]
	return h, ok
}

// Types returns the registered job types in sorted order.
func (r *Registry) Types() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	types := make([]string, 0, len(r.handlers))
	for t := range r.handlers {
		types = append(types, t)
	}
	slices.Sort(types)
	return types
}
