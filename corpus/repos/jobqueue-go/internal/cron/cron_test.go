package cron

import (
	"errors"
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestNext(t *testing.T) {
	// 2025-03-10 is a Monday.
	cases := []struct {
		spec string
		from string
		want string
	}{
		{"* * * * *", "2025-03-10T09:00:00Z", "2025-03-10T09:01:00Z"},
		{"* * * * *", "2025-03-10T09:00:30Z", "2025-03-10T09:01:00Z"},
		{"*/15 * * * *", "2025-03-10T09:07:00Z", "2025-03-10T09:15:00Z"},
		{"5/20 * * * *", "2025-03-10T09:00:00Z", "2025-03-10T09:05:00Z"},
		{"0 * * * *", "2025-03-10T09:00:00Z", "2025-03-10T10:00:00Z"},
		{"30 2 * * *", "2025-03-10T09:00:00Z", "2025-03-11T02:30:00Z"},
		{"0 9 * * MON-FRI", "2025-03-14T10:00:00Z", "2025-03-17T09:00:00Z"},
		{"0 0 1 * *", "2025-03-10T09:00:00Z", "2025-04-01T00:00:00Z"},
		{"0 0 31 * *", "2025-04-01T00:00:00Z", "2025-05-31T00:00:00Z"},
		{"0 0 29 2 *", "2025-03-10T09:00:00Z", "2028-02-29T00:00:00Z"},
		{"0 0 1 JAN *", "2025-03-10T09:00:00Z", "2026-01-01T00:00:00Z"},
		{"0 0 * * *", "2025-12-31T23:59:00Z", "2026-01-01T00:00:00Z"},
		{"0 0 * * 7", "2025-03-10T09:00:00Z", "2025-03-16T00:00:00Z"},
		{"0 0 * * 5-7", "2025-03-10T09:00:00Z", "2025-03-14T00:00:00Z"},
		{"@hourly", "2025-03-10T09:30:00Z", "2025-03-10T10:00:00Z"},
		{"@weekly", "2025-03-10T09:30:00Z", "2025-03-16T00:00:00Z"},
		// Day of month and day of week both restricted: either may match.
		{"0 12 15 * FRI", "2025-03-10T13:00:00Z", "2025-03-14T12:00:00Z"},
		{"0 12 15 * FRI", "2025-03-14T13:00:00Z", "2025-03-15T12:00:00Z"},
		// A day-of-month field starting with "*" counts as unrestricted: both must match.
		{"0 12 */2 * MON", "2025-03-10T09:00:00Z", "2025-03-17T12:00:00Z"},
		// Input in another zone is converted; schedules are always UTC.
		{"0 2 * * *", "2025-03-10T08:00:00+07:00", "2025-03-10T02:00:00Z"},
	}
	for _, tc := range cases {
		t.Run(tc.spec+" from "+tc.from, func(t *testing.T) {
			got := MustParse(tc.spec).Next(at(tc.from))
			if !got.Equal(at(tc.want)) || got.Location() != time.UTC {
				t.Errorf("Next = %s, want %s", got, tc.want)
			}
		})
	}
}

func TestNextNeverFires(t *testing.T) {
	for _, spec := range []string{"0 0 30 2 *", "0 0 31 4,6,9,11 *"} {
		if got := MustParse(spec).Next(at("2025-03-10T09:00:00Z")); !got.IsZero() {
			t.Errorf("%s: Next = %s, want zero", spec, got)
		}
	}
	if got := (Expression{}).Next(at("2025-03-10T09:00:00Z")); !got.IsZero() {
		t.Errorf("zero Expression: Next = %s, want zero", got)
	}
}

func TestNextIsStrictlyIncreasing(t *testing.T) {
	e := MustParse("*/7 1-3 * * *")
	prev := at("2025-03-10T00:00:00Z")
	for range 100 {
		next := e.Next(prev)
		if !next.After(prev) || !e.Matches(next) {
			t.Fatalf("Next(%s) = %s", prev, next)
		}
		prev = next
	}
}

func TestMatches(t *testing.T) {
	e := MustParse("0 9 * * MON")
	if !e.Matches(at("2025-03-10T09:00:45Z")) {
		t.Error("does not match Monday 09:00")
	}
	if e.Matches(at("2025-03-11T09:00:00Z")) {
		t.Error("matches Tuesday")
	}
}

func TestParseAccepts(t *testing.T) {
	cases := []struct {
		spec   string
		source string
	}{
		{"0,15,30,45 * * * *", "0,15,30,45 * * * *"},
		{"  0   0 *  jan,JUL sun ", "0 0 * jan,JUL sun"},
		{"0-59/30 0-23/6 1-31 1-12 0-7", "0-59/30 0-23/6 1-31 1-12 0-7"},
		{"@DAILY", "@DAILY"},
		{"@annually", "@annually"},
	}
	for _, tc := range cases {
		t.Run(tc.spec, func(t *testing.T) {
			e, err := Parse(tc.spec)
			if err != nil {
				t.Fatal(err)
			}
			if e.String() != tc.source {
				t.Errorf("String() = %q, want %q", e.String(), tc.source)
			}
		})
	}
}

func TestParseRejects(t *testing.T) {
	cases := []struct {
		spec  string
		field string
	}{
		{"", ""},
		{"* * * *", ""},
		{"* * * * * *", ""},
		{"@every 5m", ""},
		{"60 * * * *", "minute"},
		{"-1 * * * *", "minute"},
		{"a * * * *", "minute"},
		{"1,,2 * * * *", "minute"},
		{"5-1 * * * *", "minute"},
		{"*/0 * * * *", "minute"},
		{"*/60 * * * *", "minute"},
		{"* 24 * * *", "hour"},
		{"* * 0 * *", "day of month"},
		{"* * * 13 *", "month"},
		{"* * * FOO *", "month"},
		{"* * * * 8", "day of week"},
	}
	for _, tc := range cases {
		t.Run(tc.spec, func(t *testing.T) {
			_, err := Parse(tc.spec)
			var serr *SyntaxError
			if !errors.As(err, &serr) {
				t.Fatalf("error = %v, want a SyntaxError", err)
			}
			if serr.Field != tc.field {
				t.Errorf("field = %q, want %q (%v)", serr.Field, tc.field, err)
			}
		})
	}
}

func TestMustParsePanicsOnInvalidSpec(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("MustParse did not panic")
		}
	}()
	MustParse("not a spec")
}
