// Package cron parses standard five-field cron expressions and computes their firing times.
//
// The fields are minute (0-59), hour (0-23), day of month (1-31), month (1-12 or JAN-DEC) and
// day of week (0-7 or SUN-SAT, where both 0 and 7 mean Sunday). Each field accepts "*", single
// values, ranges ("1-5"), steps ("*/15", "0-30/10", "5/20") and comma-separated lists of these.
// The macros @yearly, @annually, @monthly, @weekly, @daily, @midnight and @hourly are accepted
// as well.
//
// As in Vixie cron, when both the day-of-month and day-of-week fields are restricted (neither
// starts with "*"), a day matches if either field matches; otherwise both must match.
package cron

import (
	"fmt"
	"strconv"
	"strings"
)

type field struct {
	name  string
	min   int
	max   int
	names map[string]int
}

var (
	minuteField = field{name: "minute", min: 0, max: 59}
	hourField   = field{name: "hour", min: 0, max: 23}
	domField    = field{name: "day of month", min: 1, max: 31}
	monthField  = field{name: "month", min: 1, max: 12, names: map[string]int{
		"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
		"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
	}}
	// Day of week is parsed on 0-7 so that ranges such as "5-7" work; 7 is folded onto 0.
	dowField = field{name: "day of week", min: 0, max: 7, names: map[string]int{
		"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6,
	}}
)

var macros = map[string]string{
	"@yearly":   "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly":  "0 0 1 * *",
	"@weekly":   "0 0 * * 0",
	"@daily":    "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly":   "0 * * * *",
}

// SyntaxError describes why an expression could not be parsed.
type SyntaxError struct {
	Expr   string
	Field  string // empty when the problem is not specific to one field
	Reason string
}

func (e *SyntaxError) Error() string {
	if e.Field == "" {
		return fmt.Sprintf("cron expression %q: %s", e.Expr, e.Reason)
	}
	return fmt.Sprintf("cron expression %q: %s field: %s", e.Expr, e.Field, e.Reason)
}

// Parse parses a five-field cron expression or a macro.
func Parse(spec string) (Expression, error) {
	source := strings.Join(strings.Fields(spec), " ")
	if source == "" {
		return Expression{}, &SyntaxError{Expr: spec, Reason: "is empty"}
	}
	expanded := source
	if strings.HasPrefix(source, "@") {
		m, ok := macros[strings.ToLower(source)]
		if !ok {
			return Expression{}, &SyntaxError{Expr: spec, Reason: "unknown macro " + source}
		}
		expanded = m
	}
	parts := strings.Fields(expanded)
	if len(parts) != 5 {
		return Expression{}, &SyntaxError{Expr: spec, Reason: fmt.Sprintf("has %d fields, want 5", len(parts))}
	}

	e := Expression{source: source}
	var err error
	fieldErr := func(f field, err error) error {
		return &SyntaxError{Expr: spec, Field: f.name, Reason: err.Error()}
	}
	if e.minute, err = parseField(parts[0], minuteField); err != nil {
		return Expression{}, fieldErr(minuteField, err)
	}
	if e.hour, err = parseField(parts[1], hourField); err != nil {
		return Expression{}, fieldErr(hourField, err)
	}
	if e.dom, err = parseField(parts[2], domField); err != nil {
		return Expression{}, fieldErr(domField, err)
	}
	if e.month, err = parseField(parts[3], monthField); err != nil {
		return Expression{}, fieldErr(monthField, err)
	}
	dow, err := parseField(parts[4], dowField)
	if err != nil {
		return Expression{}, fieldErr(dowField, err)
	}
	if dow.has(7) {
		dow = (dow &^ (1 << 7)) | 1
	}
	e.dow = dow
	e.domStar = strings.HasPrefix(parts[2], "*")
	e.dowStar = strings.HasPrefix(parts[4], "*")
	return e, nil
}

// MustParse is like Parse but panics on error. It is meant for expressions fixed in code.
func MustParse(spec string) Expression {
	e, err := Parse(spec)
	if err != nil {
		panic(err)
	}
	return e
}

func parseField(text string, f field) (bitset, error) {
	var set bitset
	for _, item := range strings.Split(text, ",") {
		if item == "" {
			return 0, fmt.Errorf("empty list item in %q", text)
		}
		bits, err := parseItem(item, f)
		if err != nil {
			return 0, err
		}
		set |= bits
	}
	return set, nil
}

// parseItem parses one list item: a range expression with an optional step.
func parseItem(item string, f field) (bitset, error) {
	rangePart, stepPart, hasStep := strings.Cut(item, "/")
	step := 1
	if hasStep {
		n, err := strconv.Atoi(stepPart)
		if err != nil || n < 1 {
			return 0, fmt.Errorf("invalid step %q", stepPart)
		}
		if n > f.max-f.min {
			return 0, fmt.Errorf("step %d is larger than the field's range", n)
		}
		step = n
	}

	var lo, hi int
	switch {
	case rangePart == "*":
		lo, hi = f.min, f.max
		if f.max == 7 { // "*" on day of week means 0-6; 7 would only repeat Sunday
			hi = 6
		}
	case strings.Contains(rangePart, "-"):
		a, b, _ := strings.Cut(rangePart, "-")
		var err error
		if lo, err = f.value(a); err != nil {
			return 0, err
		}
		if hi, err = f.value(b); err != nil {
			return 0, err
		}
		if lo > hi {
			return 0, fmt.Errorf("range %q runs backwards", rangePart)
		}
	default:
		var err error
		if lo, err = f.value(rangePart); err != nil {
			return 0, err
		}
		hi = lo
		if hasStep { // "5/15" means "5-max/15"
			hi = f.max
		}
	}

	var set bitset
	for v := lo; v <= hi; v += step {
		set |= 1 << uint(v)
	}
	return set, nil
}

func (f field) value(s string) (int, error) {
	if n, ok := f.names[strings.ToLower(s)]; ok {
		return n, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("invalid value %q", s)
	}
	if n < f.min || n > f.max {
		return 0, fmt.Errorf("value %d out of range %d-%d", n, f.min, f.max)
	}
	return n, nil
}
