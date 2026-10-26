package domain

import (
	"bytes"
	"encoding/json"
	"regexp"
	"time"

	"github.com/relaywork/jobqueue/internal/cron"
)

var scheduleNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,127}$`)

// Schedule enqueues a job of a fixed type and payload each time its cron expression fires.
// Expressions are evaluated in UTC.
type Schedule struct {
	Name      string
	Spec      string
	Queue     string
	Type      string
	Payload   json.RawMessage
	Enabled   bool
	NextRunAt time.Time
	LastRunAt *time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Job returns the job a firing of the schedule enqueues.
func (s Schedule) Job(now time.Time) NewJob {
	return NewJob{
		Queue:   s.Queue,
		Type:    s.Type,
		Payload: s.Payload,
		RunAt:   now,
	}.Normalize(now)
}

// ScheduleInput creates or replaces a schedule.
type ScheduleInput struct {
	Name    string
	Spec    string
	Queue   string
	Type    string
	Payload json.RawMessage
	Enabled bool
}

// Normalize replaces an empty payload with {}.
func (in ScheduleInput) Normalize() ScheduleInput {
	if len(bytes.TrimSpace(in.Payload)) == 0 {
		in.Payload = json.RawMessage(`{}`)
	}
	return in
}

// Validate checks a normalized input and returns the parsed cron expression.
func (in ScheduleInput) Validate() (cron.Expression, error) {
	v := &ValidationError{}
	if !scheduleNamePattern.MatchString(in.Name) {
		v.Add("name", "must be 1-128 characters of a-z, 0-9, '_', '.' or '-', starting with a letter or digit")
	}
	expr, err := cron.Parse(in.Spec)
	if err != nil {
		v.Add("spec", "%s", err)
	}
	if err := ValidateQueueName(in.Queue); err != nil {
		v.Add("queue", "%s", err)
	}
	if err := ValidateJobType(in.Type); err != nil {
		v.Add("type", "%s", err)
	}
	if err := validatePayload(in.Payload); err != nil {
		v.Add("payload", "%s", err)
	}
	if err := v.Err(); err != nil {
		return cron.Expression{}, err
	}
	return expr, nil
}

// FirstRun returns when a schedule with expression expr, saved at now, first fires.
func FirstRun(expr cron.Expression, now time.Time) (time.Time, error) {
	next := expr.Next(now)
	if next.IsZero() {
		return time.Time{}, Invalid("spec", "%q never fires", expr.String())
	}
	return next, nil
}
