package config

import (
	"strings"
	"testing"
)

func TestQueueOverridesAtStartup(t *testing.T) {
	load := func(queues, concurrency, overrides string) (Config, error) {
		vars := base()
		vars["WORKER_QUEUES"] = queues
		vars["WORKER_CONCURRENCY"] = concurrency
		vars["WORKER_QUEUE_CONCURRENCY"] = overrides
		return LoadFrom(env(vars))
	}

	cfg, err := load("mail,billing", "0", "billing=3")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.WorkerConcurrency != 0 || len(cfg.WorkerQueueConcurrency) != 1 || cfg.WorkerQueueConcurrency["billing"] != 3 {
		t.Errorf("config = %d, %v", cfg.WorkerConcurrency, cfg.WorkerQueueConcurrency)
	}

	for _, bad := range []string{"invoices=1", "mail=0", "mail=-1", "mail=1,billing=2,mail=1", "mail:2", "mail=1.5"} {
		if _, err := load("mail,billing", "4", bad); err == nil || !strings.Contains(err.Error(), "WORKER_QUEUE_CONCURRENCY") {
			t.Errorf("%q: error = %v, want a WORKER_QUEUE_CONCURRENCY error", bad, err)
		}
	}
	_, err = load("mail,billing", "4", "invoices=1,mail=0,mail=2")
	if err == nil || strings.Count(err.Error(), "WORKER_QUEUE_CONCURRENCY") != 3 {
		t.Errorf("error = %v, want the unknown queue, the bad value and the repeated queue reported", err)
	}
}
