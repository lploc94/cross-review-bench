package cron

import "time"

// bitset holds the allowed values of one field; bit n set means value n is allowed.
type bitset uint64

func (b bitset) has(n int) bool { return b&(1<<uint(n)) != 0 }

// searchYears bounds how far Next looks ahead. Eight years covers the longest gap between two
// February 29ths (across a century year that is not a leap year).
const searchYears = 9

// Expression is a parsed cron expression. The zero value matches nothing.
type Expression struct {
	source  string
	minute  bitset
	hour    bitset
	dom     bitset
	month   bitset
	dow     bitset
	domStar bool
	dowStar bool
}

// String returns the expression as written, with whitespace normalized.
func (e Expression) String() string { return e.source }

// Next returns the first time strictly after t, in UTC and truncated to the minute, at which the
// expression fires. It returns the zero time when the expression never fires, for example
// "0 0 30 2 *".
func (e Expression) Next(t time.Time) time.Time {
	if e.minute == 0 {
		return time.Time{}
	}
	t = t.UTC().Truncate(time.Minute).Add(time.Minute)
	limit := t.Year() + searchYears
	for t.Year() <= limit {
		if !e.month.has(int(t.Month())) {
			t = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, time.UTC)
			continue
		}
		if !e.dayMatches(t) {
			t = time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, time.UTC)
			continue
		}
		if !e.hour.has(t.Hour()) {
			t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour()+1, 0, 0, 0, time.UTC)
			continue
		}
		if !e.minute.has(t.Minute()) {
			t = t.Add(time.Minute)
			continue
		}
		return t
	}
	return time.Time{}
}

// Matches reports whether the expression fires at t (in UTC, ignoring seconds).
func (e Expression) Matches(t time.Time) bool {
	t = t.UTC()
	return e.minute.has(t.Minute()) && e.hour.has(t.Hour()) && e.month.has(int(t.Month())) && e.dayMatches(t)
}

func (e Expression) dayMatches(t time.Time) bool {
	dom := e.dom.has(t.Day())
	dow := e.dow.has(int(t.Weekday()))
	if e.domStar || e.dowStar {
		return dom && dow
	}
	return dom || dow
}
