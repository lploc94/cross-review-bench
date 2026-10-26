// Package config reads the service configuration from the environment and validates it, so
// that a misconfigured process fails at startup instead of at the first job.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
)

// minTokenLength is the shortest admin token accepted; shorter tokens are too easy to guess.
const minTokenLength = 32

// Database is the database connection configuration, the only part `jobqueue migrate` needs.
type Database struct {
	URL      string
	MaxConns int32
}

// Config is the complete service configuration.
type Config struct {
	Database        Database
	HTTPAddr        string
	AdminToken      string
	LogLevel        slog.Level
	ShutdownTimeout time.Duration // how long the HTTP server waits for open requests

	WorkerID           string // prefix of the lease owner names; must be unique per process
	WorkerQueues       []string
	WorkerConcurrency  int
	WorkerPollInterval time.Duration
	LeaseDuration      time.Duration
	JobTimeout         time.Duration // default handler timeout for types registered without one
	RetryDelay         time.Duration

	ReapInterval      time.Duration
	SchedulerInterval time.Duration
}

// Load reads the configuration from the process environment.
func Load() (Config, error) {
	return LoadFrom(os.LookupEnv)
}

// LoadFrom reads the configuration through lookup, which has the signature of os.LookupEnv.
// It reports every invalid or missing variable at once.
func LoadFrom(lookup func(string) (string, bool)) (Config, error) {
	r := reader{lookup: lookup}
	cfg := Config{
		Database:        readDatabase(&r),
		HTTPAddr:        r.string("HTTP_ADDR", ":8080"),
		AdminToken:      r.required("ADMIN_TOKEN"),
		LogLevel:        r.level("LOG_LEVEL", slog.LevelInfo),
		ShutdownTimeout: r.duration("SHUTDOWN_TIMEOUT", 15*time.Second),

		WorkerID:           r.string("WORKER_ID", defaultWorkerID()),
		WorkerQueues:       r.list("WORKER_QUEUES", []string{"default"}),
		WorkerConcurrency:  r.int("WORKER_CONCURRENCY", 4, 0, 256),
		WorkerPollInterval: r.duration("WORKER_POLL_INTERVAL", time.Second),
		LeaseDuration:      r.duration("LEASE_DURATION", 5*time.Minute),
		JobTimeout:         r.duration("JOB_TIMEOUT", time.Minute),
		RetryDelay:         r.duration("RETRY_DELAY", 30*time.Second),

		ReapInterval:      r.duration("REAP_INTERVAL", 30*time.Second),
		SchedulerInterval: r.duration("SCHEDULER_INTERVAL", 10*time.Second),
	}
	cfg.validate(&r)
	if len(r.errs) > 0 {
		return Config{}, fmt.Errorf("configuration: %w", errors.Join(r.errs...))
	}
	return cfg, nil
}

// LoadDatabase reads only the database settings through lookup.
func LoadDatabase(lookup func(string) (string, bool)) (Database, error) {
	r := reader{lookup: lookup}
	db := readDatabase(&r)
	if len(r.errs) > 0 {
		return Database{}, fmt.Errorf("configuration: %w", errors.Join(r.errs...))
	}
	return db, nil
}

func readDatabase(r *reader) Database {
	return Database{
		URL:      r.required("DATABASE_URL"),
		MaxConns: int32(r.int("DB_MAX_CONNS", 10, 1, 1000)),
	}
}

func (c Config) validate(r *reader) {
	if c.AdminToken != "" && len(c.AdminToken) < minTokenLength {
		r.fail("ADMIN_TOKEN", "must be at least %d characters", minTokenLength)
	}
	for _, q := range c.WorkerQueues {
		if err := domain.ValidateQueueName(q); err != nil {
			r.fail("WORKER_QUEUES", "queue %q %s", q, err)
		}
	}
	positive := []struct {
		name string
		d    time.Duration
	}{
		{"SHUTDOWN_TIMEOUT", c.ShutdownTimeout},
		{"WORKER_POLL_INTERVAL", c.WorkerPollInterval},
		{"LEASE_DURATION", c.LeaseDuration},
		{"JOB_TIMEOUT", c.JobTimeout},
		{"REAP_INTERVAL", c.ReapInterval},
		{"SCHEDULER_INTERVAL", c.SchedulerInterval},
	}
	for _, p := range positive {
		if p.d <= 0 {
			r.fail(p.name, "must be positive")
		}
	}
	if c.RetryDelay < 0 {
		r.fail("RETRY_DELAY", "must not be negative")
	}
	// Without lease renewal, a handler that outlives its lease is reaped and run a second time
	// while the first run is still going.
	if c.JobTimeout > 0 && c.LeaseDuration > 0 && c.JobTimeout >= c.LeaseDuration {
		r.fail("JOB_TIMEOUT", "must be shorter than LEASE_DURATION (%s)", c.LeaseDuration)
	}
}

// reader collects values and the problems found while reading them.
type reader struct {
	lookup func(string) (string, bool)
	errs   []error
}

func (r *reader) fail(name, format string, args ...any) {
	r.errs = append(r.errs, fmt.Errorf("%s %s", name, fmt.Sprintf(format, args...)))
}

func (r *reader) get(name string) (string, bool) {
	v, ok := r.lookup(name)
	v = strings.TrimSpace(v)
	return v, ok && v != ""
}

func (r *reader) required(name string) string {
	v, ok := r.get(name)
	if !ok {
		r.fail(name, "is required")
	}
	return v
}

func (r *reader) string(name, def string) string {
	if v, ok := r.get(name); ok {
		return v
	}
	return def
}

func (r *reader) int(name string, def, lo, hi int) int {
	v, ok := r.get(name)
	if !ok {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		r.fail(name, "must be an integer, got %q", v)
		return def
	}
	if n < lo || n > hi {
		r.fail(name, "must be between %d and %d, got %d", lo, hi, n)
		return def
	}
	return n
}

func (r *reader) duration(name string, def time.Duration) time.Duration {
	v, ok := r.get(name)
	if !ok {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		r.fail(name, "must be a duration such as 30s or 5m, got %q", v)
		return def
	}
	return d
}

func (r *reader) list(name string, def []string) []string {
	v, ok := r.get(name)
	if !ok {
		return def
	}
	var out []string
	seen := make(map[string]bool)
	for _, item := range strings.Split(v, ",") {
		item = strings.TrimSpace(item)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func (r *reader) level(name string, def slog.Level) slog.Level {
	v, ok := r.get(name)
	if !ok {
		return def
	}
	var l slog.Level
	if err := l.UnmarshalText([]byte(v)); err != nil {
		r.fail(name, "must be debug, info, warn or error, got %q", v)
		return def
	}
	return l
}

// defaultWorkerID names this process uniquely: host name and pid alone repeat when a container
// restarts with the same host name and pid 1.
func defaultWorkerID() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "worker"
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%s-%d-%s", host, os.Getpid(), hex.EncodeToString(b[:]))
}
