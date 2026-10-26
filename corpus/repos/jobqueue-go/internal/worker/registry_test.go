package worker_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/worker"
)

func noop(context.Context, domain.Job) error { return nil }

func TestRegistryTypesAreSorted(t *testing.T) {
	reg := worker.NewRegistry(time.Second)
	reg.Register("email.send", noop)
	reg.Register("audit:write", noop)
	reg.Register("cleanup", noop, worker.WithTimeout(time.Hour))
	if got := reg.Types(); !slices.Equal(got, []string{"audit:write", "cleanup", "email.send"}) {
		t.Errorf("Types() = %v", got)
	}
}

func TestRegistryRejectsBadRegistrations(t *testing.T) {
	cases := []struct {
		name string
		fn   func(reg *worker.Registry)
	}{
		{"duplicate type", func(reg *worker.Registry) {
			reg.Register("dup", noop)
			reg.Register("dup", noop)
		}},
		{"invalid type", func(reg *worker.Registry) { reg.Register("has space", noop) }},
		{"nil handler", func(reg *worker.Registry) { reg.Register("nil", nil) }},
		{"zero timeout", func(reg *worker.Registry) { reg.Register("t", noop, worker.WithTimeout(0)) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Error("registration did not panic")
				}
			}()
			tc.fn(worker.NewRegistry(time.Second))
		})
	}
}
