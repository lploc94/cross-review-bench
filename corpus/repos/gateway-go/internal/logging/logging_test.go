package logging

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"
)

func decodeLine(t *testing.T, s string) map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1:\n%s", len(lines), s)
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

func TestNewWritesJSONLines(t *testing.T) {
	var buf strings.Builder
	log := New(&buf, slog.LevelInfo)
	log.Debug("dropped at info level")
	log.Info("request", "route", "orders", "status", 502, "duration", 1500*time.Millisecond, "error", errors.New("boom"))

	rec := decodeLine(t, buf.String())
	if rec["msg"] != "request" || rec["level"] != "INFO" || rec["status"] != 502.0 || rec["error"] != "boom" {
		t.Errorf("record = %v", rec)
	}
	if rec["duration"] != 1.5 {
		t.Errorf("duration = %v, want seconds", rec["duration"])
	}
}

func TestSensitiveAttributesAreRedacted(t *testing.T) {
	var buf strings.Builder
	log := New(&buf, slog.LevelInfo)
	log.Info("auth", "Authorization", "Bearer abc", "api_key", "gk_1", "X-Api-Key", "gk_2",
		slog.Group("hmac", "signature", "deadbeef", "key_id", "hk_1"), "consumer_id", "c1")

	out := buf.String()
	for _, secret := range []string{"Bearer abc", "gk_1", "gk_2", "deadbeef"} {
		if strings.Contains(out, secret) {
			t.Errorf("log line contains %q:\n%s", secret, out)
		}
	}
	rec := decodeLine(t, out)
	if rec["consumer_id"] != "c1" || rec["hmac"].(map[string]any)["key_id"] != "hk_1" {
		t.Errorf("non-sensitive attributes lost: %v", rec)
	}
}

func TestIsSensitive(t *testing.T) {
	for name, want := range map[string]bool{
		"Authorization": true, "proxy-authorization": true, "X-API-Key": true, "secret": true,
		"Set-Cookie": true, "key_prefix": false, "consumer": false, "X-Request-ID": false,
	} {
		if got := IsSensitive(name); got != want {
			t.Errorf("IsSensitive(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestSafeHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("Authorization", "HMAC key_id=a, signature=b, timestamp=1")
	h.Set("X-Api-Key", "gk_secret")
	h.Add("Accept", "text/plain")
	h.Add("Accept", "application/json")
	got := SafeHeaders(h)
	if got["Authorization"] != Redacted || got["X-Api-Key"] != Redacted {
		t.Errorf("credentials not redacted: %v", got)
	}
	if got["Accept"] != "text/plain, application/json" {
		t.Errorf("Accept = %q", got["Accept"])
	}
}

func TestDiscard(t *testing.T) {
	Discard().Error("goes nowhere") // must not panic
	if Discard().Enabled(t.Context(), slog.LevelError) {
		t.Error("Discard logger is enabled")
	}
}
