// Package logging builds the service's structured JSON logger.
package logging

import (
	"io"
	"log/slog"
)

// New returns a logger that writes one JSON object per line to w, at level and above.
func New(w io.Writer, level slog.Leveler) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			// Durations are logged as fractional seconds rather than nanoseconds, so that log
			// queries do not need to know the unit.
			if a.Value.Kind() == slog.KindDuration {
				return slog.Float64(a.Key, a.Value.Duration().Seconds())
			}
			return a
		},
	}))
}

// Discard returns a logger that drops every record. Tests use it.
func Discard() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}
