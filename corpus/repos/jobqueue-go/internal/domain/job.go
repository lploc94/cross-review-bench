// Package domain holds the job and schedule model, the job state machine, validation rules and
// the retry policy. It has no knowledge of storage or transport.
package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

// State is the lifecycle state of a job.
//
//	available ──lease──▶ running ──complete──▶ succeeded
//	    ▲                   │ ├──fail (attempts left)──▶ available
//	    │                   │ ├──fail (no attempts left)──▶ dead ──requeue──▶ available
//	    │                   │ └──permanent failure──▶ failed
//	    └──lease expired────┘
//	available ──cancel──▶ cancelled
type State string

const (
	StateAvailable State = "available"
	StateRunning   State = "running"
	StateSucceeded State = "succeeded"
	StateFailed    State = "failed"
	StateCancelled State = "cancelled"
	StateDead      State = "dead"
)

// States lists every job state in lifecycle order.
var States = []State{StateAvailable, StateRunning, StateSucceeded, StateFailed, StateCancelled, StateDead}

// Valid reports whether s is a known state.
func (s State) Valid() bool {
	for _, known := range States {
		if s == known {
			return true
		}
	}
	return false
}

// Terminal reports whether a job in state s will never run again on its own. Dead jobs are
// terminal too, although an operator may requeue them.
func (s State) Terminal() bool {
	switch s {
	case StateSucceeded, StateFailed, StateCancelled, StateDead:
		return true
	}
	return false
}

// ParseState converts s to a State, rejecting unknown values.
func ParseState(s string) (State, error) {
	st := State(s)
	if !st.Valid() {
		return "", fmt.Errorf("unknown job state %q", s)
	}
	return st, nil
}

// Limits on job fields.
const (
	DefaultMaxAttempts = 5
	MaxMaxAttempts     = 100
	MinPriority        = -1000
	MaxPriority        = 1000
	MaxPayloadBytes    = 256 << 10
	maxTypeLength      = 128
)

var (
	queueNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)
	jobTypePattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]*$`)
)

// Job is a unit of work stored in a queue.
type Job struct {
	ID          int64
	Queue       string
	Type        string
	Payload     json.RawMessage
	Priority    int
	State       State
	Attempts    int
	MaxAttempts int
	RunAt       time.Time
	LockedBy    string     // empty unless the job is running
	LockedUntil *time.Time // nil unless the job is running
	LastError   string
	CreatedAt   time.Time
	UpdatedAt   time.Time
	FinishedAt  *time.Time // set when the job reaches a terminal state
}

// AttemptsExhausted reports whether the job has used all of its attempts. The store applies the
// same rule in SQL when it settles a failed or expired attempt.
func (j Job) AttemptsExhausted() bool {
	return j.Attempts >= j.MaxAttempts
}

// NewJob is a request to enqueue a job.
type NewJob struct {
	Queue       string
	Type        string
	Payload     json.RawMessage // a JSON object; empty means {}
	Priority    int             // higher runs first
	MaxAttempts int             // 0 means DefaultMaxAttempts
	RunAt       time.Time       // zero means as soon as possible
}

// Normalize fills in defaults: an empty payload becomes {}, a zero MaxAttempts becomes
// DefaultMaxAttempts, and a zero RunAt becomes now.
func (n NewJob) Normalize(now time.Time) NewJob {
	if len(bytes.TrimSpace(n.Payload)) == 0 {
		n.Payload = json.RawMessage(`{}`)
	}
	if n.MaxAttempts == 0 {
		n.MaxAttempts = DefaultMaxAttempts
	}
	if n.RunAt.IsZero() {
		n.RunAt = now
	}
	return n
}

// Validate checks a normalized NewJob.
func (n NewJob) Validate() error {
	v := &ValidationError{}
	if err := ValidateQueueName(n.Queue); err != nil {
		v.Add("queue", "%s", err)
	}
	if err := ValidateJobType(n.Type); err != nil {
		v.Add("type", "%s", err)
	}
	if err := validatePayload(n.Payload); err != nil {
		v.Add("payload", "%s", err)
	}
	if n.Priority < MinPriority || n.Priority > MaxPriority {
		v.Add("priority", "must be between %d and %d", MinPriority, MaxPriority)
	}
	if n.MaxAttempts < 1 || n.MaxAttempts > MaxMaxAttempts {
		v.Add("max_attempts", "must be between 1 and %d", MaxMaxAttempts)
	}
	return v.Err()
}

// ValidateQueueName checks that name is a lower-case queue name of at most 63 characters.
func ValidateQueueName(name string) error {
	if name == "" {
		return errors.New("is required")
	}
	if !queueNamePattern.MatchString(name) {
		return errors.New("must be 1-63 characters of a-z, 0-9, '_', '.' or '-', starting with a letter or digit")
	}
	return nil
}

// ValidateJobType checks a job type name such as "email.send".
func ValidateJobType(typ string) error {
	if typ == "" {
		return errors.New("is required")
	}
	if len(typ) > maxTypeLength {
		return fmt.Errorf("must be at most %d characters", maxTypeLength)
	}
	if !jobTypePattern.MatchString(typ) {
		return errors.New("must contain only letters, digits, '_', '.', ':' or '-'")
	}
	return nil
}

func validatePayload(p json.RawMessage) error {
	if len(p) > MaxPayloadBytes {
		return fmt.Errorf("must be at most %d bytes", MaxPayloadBytes)
	}
	if !json.Valid(p) {
		return errors.New("must be valid JSON")
	}
	trimmed := bytes.TrimSpace(p)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("must be a JSON object")
	}
	return nil
}
