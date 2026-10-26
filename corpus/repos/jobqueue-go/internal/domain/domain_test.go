package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2025, time.March, 10, 9, 0, 0, 0, time.UTC)

func fieldsOf(err error) []string {
	var v *ValidationError
	if !errors.As(err, &v) {
		return nil
	}
	out := make([]string, len(v.Fields))
	for i, f := range v.Fields {
		out[i] = f.Field
	}
	return out
}

func TestNormalizeFillsDefaults(t *testing.T) {
	n := NewJob{Queue: "default", Type: "noop", Payload: json.RawMessage("  ")}.Normalize(now)
	if string(n.Payload) != "{}" || n.MaxAttempts != DefaultMaxAttempts || !n.RunAt.Equal(now) {
		t.Errorf("Normalize = %+v", n)
	}
	runAt := now.Add(time.Hour)
	n = NewJob{MaxAttempts: 2, RunAt: runAt, Payload: json.RawMessage(`{"a":1}`)}.Normalize(now)
	if n.MaxAttempts != 2 || !n.RunAt.Equal(runAt) || string(n.Payload) != `{"a":1}` {
		t.Errorf("Normalize overwrote explicit values: %+v", n)
	}
}

func TestNewJobValidate(t *testing.T) {
	valid := NewJob{Queue: "emails", Type: "email.send", Payload: json.RawMessage(`{}`), MaxAttempts: 3}
	cases := []struct {
		name   string
		mutate func(*NewJob)
		fields []string
	}{
		{"valid", func(*NewJob) {}, nil},
		{"queue with dots and dashes", func(n *NewJob) { n.Queue = "billing.eu-west_1" }, nil},
		{"empty queue", func(n *NewJob) { n.Queue = "" }, []string{"queue"}},
		{"upper-case queue", func(n *NewJob) { n.Queue = "Emails" }, []string{"queue"}},
		{"queue too long", func(n *NewJob) { n.Queue = strings.Repeat("q", 64) }, []string{"queue"}},
		{"type with colon", func(n *NewJob) { n.Type = "crm:sync" }, nil},
		{"empty type", func(n *NewJob) { n.Type = "" }, []string{"type"}},
		{"type with space", func(n *NewJob) { n.Type = "send email" }, []string{"type"}},
		{"type too long", func(n *NewJob) { n.Type = strings.Repeat("t", 129) }, []string{"type"}},
		{"array payload", func(n *NewJob) { n.Payload = json.RawMessage(`[1,2]`) }, []string{"payload"}},
		{"broken payload", func(n *NewJob) { n.Payload = json.RawMessage(`{"a":`) }, []string{"payload"}},
		{"huge payload", func(n *NewJob) {
			n.Payload = json.RawMessage(`{"a":"` + strings.Repeat("x", MaxPayloadBytes) + `"}`)
		}, []string{"payload"}},
		{"priority too high", func(n *NewJob) { n.Priority = MaxPriority + 1 }, []string{"priority"}},
		{"priority lowest", func(n *NewJob) { n.Priority = MinPriority }, nil},
		{"zero attempts", func(n *NewJob) { n.MaxAttempts = 0 }, []string{"max_attempts"}},
		{"too many attempts", func(n *NewJob) { n.MaxAttempts = MaxMaxAttempts + 1 }, []string{"max_attempts"}},
		{"several problems", func(n *NewJob) { n.Queue, n.Type = "", "" }, []string{"queue", "type"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			n := valid
			tc.mutate(&n)
			err := n.Validate()
			if got := fieldsOf(err); !slices.Equal(got, tc.fields) {
				t.Errorf("invalid fields = %v (%v), want %v", got, err, tc.fields)
			}
		})
	}
}

func TestStates(t *testing.T) {
	for _, s := range States {
		if got, err := ParseState(string(s)); err != nil || got != s {
			t.Errorf("ParseState(%q) = %q, %v", s, got, err)
		}
	}
	if _, err := ParseState("paused"); err == nil {
		t.Error("ParseState accepted an unknown state")
	}
	terminal := map[State]bool{StateSucceeded: true, StateFailed: true, StateCancelled: true, StateDead: true}
	for _, s := range States {
		if s.Terminal() != terminal[s] {
			t.Errorf("%s.Terminal() = %v", s, s.Terminal())
		}
	}
}

func TestAttemptsExhausted(t *testing.T) {
	if (Job{Attempts: 2, MaxAttempts: 3}).AttemptsExhausted() {
		t.Error("2 of 3 attempts reported as exhausted")
	}
	if !(Job{Attempts: 3, MaxAttempts: 3}).AttemptsExhausted() {
		t.Error("3 of 3 attempts not reported as exhausted")
	}
}

func TestValidationErrorMessage(t *testing.T) {
	v := &ValidationError{}
	if v.Err() != nil {
		t.Fatal("empty ValidationError is an error")
	}
	v.Add("queue", "is required")
	v.Add("priority", "must be at most %d", 10)
	if got := v.Err().Error(); got != "invalid input: queue: is required; priority: must be at most 10" {
		t.Errorf("Error() = %q", got)
	}
}

func TestPermanent(t *testing.T) {
	if Permanent(nil) != nil {
		t.Error("Permanent(nil) is not nil")
	}
	base := errors.New("bad payload")
	err := fmt.Errorf("handler: %w", Permanent(base))
	if !IsPermanent(err) || !errors.Is(err, base) {
		t.Errorf("wrapped permanent error lost its identity: %v", err)
	}
	if IsPermanent(base) {
		t.Error("plain error reported as permanent")
	}
}

func TestFixedDelay(t *testing.T) {
	p, err := NewFixedDelay(30 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 3; attempt++ {
		if got := p.NextRunAt(now, attempt); !got.Equal(now.Add(30 * time.Second)) {
			t.Errorf("attempt %d: NextRunAt = %s", attempt, got)
		}
	}
	if _, err := NewFixedDelay(-time.Second); err == nil {
		t.Error("negative delay accepted")
	}
}

func TestScheduleInputValidate(t *testing.T) {
	valid := ScheduleInput{Name: "nightly-report", Spec: "0 3 * * *", Queue: "reports", Type: "report.build"}.Normalize()
	if string(valid.Payload) != "{}" {
		t.Fatalf("Normalize payload = %s", valid.Payload)
	}
	expr, err := valid.Validate()
	if err != nil || expr.String() != "0 3 * * *" {
		t.Fatalf("Validate = %v, %v", expr, err)
	}

	bad := ScheduleInput{Name: "Bad Name", Spec: "0 3 * *", Queue: "", Type: "x y", Payload: json.RawMessage(`1`)}
	_, err = bad.Validate()
	if got := fieldsOf(err); !slices.Equal(got, []string{"name", "spec", "queue", "type", "payload"}) {
		t.Errorf("invalid fields = %v", got)
	}
}

func TestFirstRun(t *testing.T) {
	expr, _ := ScheduleInput{Name: "s", Spec: "0 3 * * *", Queue: "q", Type: "t"}.Normalize().Validate()
	first, err := FirstRun(expr, now)
	if err != nil || !first.Equal(time.Date(2025, time.March, 11, 3, 0, 0, 0, time.UTC)) {
		t.Errorf("FirstRun = %s, %v", first, err)
	}
	never, _ := ScheduleInput{Name: "s", Spec: "0 0 30 2 *", Queue: "q", Type: "t"}.Normalize().Validate()
	if _, err := FirstRun(never, now); !slices.Equal(fieldsOf(err), []string{"spec"}) {
		t.Errorf("FirstRun of a spec that never fires: %v", err)
	}
}

func TestScheduleJob(t *testing.T) {
	sc := Schedule{Name: "s", Queue: "q", Type: "t", Payload: json.RawMessage(`{"x":1}`)}
	j := sc.Job(now)
	if j.Queue != "q" || j.Type != "t" || string(j.Payload) != `{"x":1}` || !j.RunAt.Equal(now) || j.MaxAttempts != DefaultMaxAttempts {
		t.Errorf("Job = %+v", j)
	}
}
