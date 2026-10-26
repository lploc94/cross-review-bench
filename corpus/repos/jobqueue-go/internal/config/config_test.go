package config

import (
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"
)

const token = "0123456789abcdef0123456789abcdef"

func env(vars map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := vars[k]
		return v, ok
	}
}

func base() map[string]string {
	return map[string]string{"DATABASE_URL": "postgres://localhost/jobs", "ADMIN_TOKEN": token}
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := LoadFrom(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Database.URL != "postgres://localhost/jobs" || cfg.Database.MaxConns != 10 {
		t.Errorf("Database = %+v", cfg.Database)
	}
	if cfg.HTTPAddr != ":8080" || cfg.LogLevel != slog.LevelInfo || cfg.ShutdownTimeout != 15*time.Second {
		t.Errorf("server settings = %q %v %s", cfg.HTTPAddr, cfg.LogLevel, cfg.ShutdownTimeout)
	}
	if !slices.Equal(cfg.WorkerQueues, []string{"default"}) || cfg.WorkerConcurrency != 4 {
		t.Errorf("workers = %v x %d", cfg.WorkerQueues, cfg.WorkerConcurrency)
	}
	if cfg.LeaseDuration != 5*time.Minute || cfg.JobTimeout != time.Minute || cfg.RetryDelay != 30*time.Second {
		t.Errorf("timings = lease %s timeout %s retry %s", cfg.LeaseDuration, cfg.JobTimeout, cfg.RetryDelay)
	}
	if cfg.WorkerID == "" {
		t.Error("no default worker id")
	}
}

func TestLoadOverrides(t *testing.T) {
	vars := base()
	vars["HTTP_ADDR"] = "127.0.0.1:9000"
	vars["LOG_LEVEL"] = "debug"
	vars["WORKER_ID"] = "node-a"
	vars["WORKER_QUEUES"] = " emails, reports ,emails,"
	vars["WORKER_CONCURRENCY"] = "0"
	vars["LEASE_DURATION"] = "10m"
	vars["JOB_TIMEOUT"] = "9m"
	vars["RETRY_DELAY"] = "0s"
	vars["DB_MAX_CONNS"] = "25"
	cfg, err := LoadFrom(env(vars))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPAddr != "127.0.0.1:9000" || cfg.LogLevel != slog.LevelDebug || cfg.WorkerID != "node-a" {
		t.Errorf("cfg = %+v", cfg)
	}
	if !slices.Equal(cfg.WorkerQueues, []string{"emails", "reports"}) {
		t.Errorf("queues = %v, want trimmed and deduplicated", cfg.WorkerQueues)
	}
	if cfg.WorkerConcurrency != 0 || cfg.RetryDelay != 0 || cfg.Database.MaxConns != 25 {
		t.Errorf("cfg = %+v", cfg)
	}
}

func TestLoadReportsEveryProblem(t *testing.T) {
	vars := map[string]string{
		"ADMIN_TOKEN":        "short",
		"WORKER_CONCURRENCY": "lots",
		"LEASE_DURATION":     "5 minutes",
		"LOG_LEVEL":          "verbose",
		"WORKER_QUEUES":      "ok,Not-OK",
		"RETRY_DELAY":        "-1s",
		"REAP_INTERVAL":      "0s",
		"DB_MAX_CONNS":       "0",
	}
	_, err := LoadFrom(env(vars))
	if err == nil {
		t.Fatal("invalid configuration accepted")
	}
	for _, name := range []string{"DATABASE_URL", "ADMIN_TOKEN", "WORKER_CONCURRENCY", "LEASE_DURATION",
		"LOG_LEVEL", "WORKER_QUEUES", "RETRY_DELAY", "REAP_INTERVAL", "DB_MAX_CONNS"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("error does not mention %s:\n%v", name, err)
		}
	}
}

func TestJobTimeoutMustBeShorterThanLease(t *testing.T) {
	vars := base()
	vars["LEASE_DURATION"] = "1m"
	vars["JOB_TIMEOUT"] = "1m"
	_, err := LoadFrom(env(vars))
	if err == nil || !strings.Contains(err.Error(), "JOB_TIMEOUT must be shorter than LEASE_DURATION") {
		t.Errorf("error = %v", err)
	}
}

func TestBlankValuesUseDefaults(t *testing.T) {
	vars := base()
	vars["HTTP_ADDR"] = "   "
	cfg, err := LoadFrom(env(vars))
	if err != nil || cfg.HTTPAddr != ":8080" {
		t.Errorf("HTTP_ADDR = %q, %v", cfg.HTTPAddr, err)
	}
	vars["ADMIN_TOKEN"] = " "
	if _, err := LoadFrom(env(vars)); err == nil || !strings.Contains(err.Error(), "ADMIN_TOKEN is required") {
		t.Errorf("blank required variable: %v", err)
	}
}

func TestLoadDatabase(t *testing.T) {
	db, err := LoadDatabase(env(map[string]string{"DATABASE_URL": "postgres://db/jobs"}))
	if err != nil || db.URL != "postgres://db/jobs" || db.MaxConns != 10 {
		t.Errorf("LoadDatabase = %+v, %v", db, err)
	}
	if _, err := LoadDatabase(env(nil)); err == nil {
		t.Error("missing DATABASE_URL accepted")
	}
}
