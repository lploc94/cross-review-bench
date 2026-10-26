package logging

import (
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestNewWritesJSONLines(t *testing.T) {
	var buf strings.Builder
	log := New(&buf, slog.LevelInfo)
	log.Debug("dropped at info level")
	log.Info("job finished", "job_id", 42, "duration", 1500*time.Millisecond, "error", errors.New("boom"))

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1:\n%s", len(lines), buf.String())
	}
	var rec map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &rec); err != nil {
		t.Fatal(err)
	}
	if rec["msg"] != "job finished" || rec["level"] != "INFO" || rec["job_id"] != 42.0 || rec["error"] != "boom" {
		t.Errorf("record = %v", rec)
	}
	if rec["duration"] != 1.5 {
		t.Errorf("duration = %v, want seconds", rec["duration"])
	}
}

func TestDiscard(t *testing.T) {
	Discard().Error("goes nowhere") // must not panic
	if Discard().Enabled(t.Context(), slog.LevelError) {
		t.Error("Discard logger is enabled")
	}
}
