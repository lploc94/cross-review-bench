// Package logging builds the gateway's structured JSON logger.
//
// The gateway handles credentials on every request. Call sites never log them, and the logger
// backs that up: an attribute whose key names a credential is replaced by "[redacted]" whatever
// its value.
package logging

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
)

// Redacted replaces the value of a sensitive attribute.
const Redacted = "[redacted]"

// sensitiveKeys are attribute keys, compared case-insensitively with '-' and '_' ignored, whose
// values are never written.
var sensitiveKeys = map[string]bool{
	"authorization":      true,
	"proxyauthorization": true,
	"apikey":             true,
	"xapikey":            true,
	"key":                true,
	"secret":             true,
	"signature":          true,
	"token":              true,
	"admintoken":         true,
	"password":           true,
	"cookie":             true,
	"setcookie":          true,
}

// IsSensitive reports whether an attribute or header called name carries a credential.
func IsSensitive(name string) bool {
	n := strings.ToLower(name)
	n = strings.NewReplacer("-", "", "_", "").Replace(n)
	return sensitiveKeys[n]
}

// New returns a logger that writes one JSON object per line to w, at level and above.
func New(w io.Writer, level slog.Leveler) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if IsSensitive(a.Key) {
				return slog.String(a.Key, Redacted)
			}
			// Durations are logged as fractional seconds rather than nanoseconds, so that log
			// queries do not need to know the unit.
			if a.Value.Kind() == slog.KindDuration {
				return slog.Float64(a.Key, a.Value.Duration().Seconds())
			}
			return a
		},
	}))
}

// SafeHeaders returns h as a log attribute value with every credential header redacted. Debug
// logging of request headers goes through it.
func SafeHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for name, values := range h {
		if IsSensitive(name) {
			out[name] = Redacted
			continue
		}
		out[name] = strings.Join(values, ", ")
	}
	return out
}

// Discard returns a logger that drops every record. Tests use it.
func Discard() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}
