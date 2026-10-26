# jobqueue

A background job queue backed by PostgreSQL. Producers enqueue jobs over an HTTP API; worker
goroutines lease them with `FOR UPDATE SKIP LOCKED`, run the handler registered for the job's
type and record the outcome. Failed attempts are retried after a fixed delay until the job runs
out of attempts and lands in the dead-letter queue, from where an operator can requeue it. Cron
schedules enqueue jobs periodically.

One binary runs everything: the API, the worker pool, the scheduler and the reaper that recovers
jobs from workers that died. Every instance can run all of them against the same database.

## Layout

| Path | What it holds |
|---|---|
| `cmd/jobqueue` | the service: configuration, logging, database pool, migrations, HTTP server, workers, scheduler, reaper, graceful shutdown |
| `cmd/jobctl` | a command-line client for the API |
| `internal/api` | HTTP handlers, routing, bearer-token auth, error mapping, request logging and metrics |
| `internal/domain` | the job and schedule model, the state machine, validation, the retry policy, error values |
| `internal/store` | PostgreSQL persistence: enqueue, lease, settle, reap, dead letters, schedules |
| `internal/worker` | the worker pool, the handler registry and the lease reaper |
| `internal/scheduler`, `internal/cron` | cron expression parsing and the loop that fires due schedules |
| `internal/builtin` | the built-in handlers `noop`, `sleep` and `http.post` |
| `internal/metrics` | counters, gauges and histograms in the Prometheus text format |
| `internal/migrate`, `migrations/` | the migration runner and the SQL files it embeds |
| `internal/config`, `internal/clock`, `internal/logging`, `internal/buildinfo` | environment configuration, an injectable clock, the JSON logger, build information |
| `internal/client`, `internal/testdb` | the Go API client used by jobctl; per-package test schemas |

## Job lifecycle

```
available ──lease──▶ running ──handler returns nil──▶ succeeded
    ▲                  │ ├── error, attempts left ──▶ available (run_at = now + RETRY_DELAY)
    │                  │ ├── error, no attempts left ──▶ dead ──requeue──▶ available
    │                  │ └── domain.Permanent(err) ──▶ failed
    └── lease expired ─┘   (reaper; dead when no attempts are left)
available ──cancel──▶ cancelled
```

- A lease belongs to one worker goroutine (`<WORKER_ID>/<queue>/<n>`). Completing, failing or
  extending a job is conditional on that owner still holding it, so a worker whose lease expired
  and whose job was handed to another worker gets `ErrLeaseLost` instead of overwriting the new
  attempt.
- `attempts` counts leases. A job is dead once `attempts >= max_attempts`.
- Handlers run with the timeout of their type (`JOB_TIMEOUT` unless registered with
  `worker.WithTimeout`). A handler that may outlive its lease calls `worker.ExtendLease(ctx)`;
  the `sleep` handler shows how.
- A panicking handler fails its attempt with the panic message; the worker carries on.
- `Stop` (on SIGTERM or SIGINT) stops leasing and waits for running handlers to return. It does
  not cancel them.

## Running

You need Go 1.25 and PostgreSQL 13 or later.

```sh
createdb jobqueue
export DATABASE_URL=postgres://localhost:5432/jobqueue?sslmode=disable
export ADMIN_TOKEN=$(openssl rand -hex 32)

go run ./cmd/jobqueue migrate          # optional: the service migrates on start too
go run ./cmd/jobqueue
```

`jobqueue migrate status` lists the migrations and when each was applied; `jobqueue version`
prints the build.

Enqueue and inspect jobs:

```sh
curl -s -X POST localhost:8080/v1/queues/default/jobs \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"http.post","payload":{"url":"https://example.com/hook","body":{"event":"paid"}}}'

export JOBQUEUE_TOKEN=$ADMIN_TOKEN
go run ./cmd/jobctl list -queue default
go run ./cmd/jobctl wait 1
go run ./cmd/jobctl schedule-put -spec '*/5 * * * *' -type noop heartbeat
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `DB_MAX_CONNS` | `10` | connection pool size |
| `ADMIN_TOKEN` | required | bearer token for every `/v1` route, at least 32 characters |
| `HTTP_ADDR` | `:8080` | listen address |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `SHUTDOWN_TIMEOUT` | `15s` | how long open HTTP requests may take to finish on shutdown |
| `WORKER_ID` | host-pid-random | lease owner prefix; must be unique per process |
| `WORKER_QUEUES` | `default` | comma-separated queues this instance works on |
| `WORKER_CONCURRENCY` | `4` | worker goroutines per queue; `0` runs the API only |
| `WORKER_POLL_INTERVAL` | `1s` | how often an idle worker looks for jobs |
| `LEASE_DURATION` | `5m` | how long a leased job belongs to its worker |
| `JOB_TIMEOUT` | `1m` | default handler timeout; must be shorter than `LEASE_DURATION` |
| `RETRY_DELAY` | `30s` | wait before a failed attempt runs again |
| `REAP_INTERVAL` | `30s` | how often expired leases are recovered |
| `SCHEDULER_INTERVAL` | `10s` | how often due schedules are fired |

The service logs JSON lines to stdout and exits with status 2 on invalid configuration, listing
every problem.

### HTTP API

All `/v1` routes need `Authorization: Bearer <ADMIN_TOKEN>`. Errors share one shape:
`{"error":{"code":"validation_failed","message":"…","fields":[{"field":"type","message":"is required"}],"request_id":"…"}}`
with status 400 (malformed body), 401, 404, 409 (wrong state), 413, 415 or 422 (validation).

| Route | |
|---|---|
| `POST /v1/queues/{queue}/jobs` | enqueue `{type, payload?, priority?, max_attempts?, run_at?}`; 201 |
| `GET /v1/jobs/{id}` | one job |
| `GET /v1/jobs?queue=&state=&after=&limit=` | jobs by ascending id; `next_after` is the cursor of the next page |
| `POST /v1/jobs/{id}/cancel` | cancel an available job |
| `GET /v1/dead?queue=&after=&limit=` | dead jobs |
| `POST /v1/dead/{id}/requeue` | make a dead job available again with fresh attempts |
| `GET /v1/schedules`, `GET/PUT/DELETE /v1/schedules/{name}` | cron schedules; `PUT` takes `{spec, queue, type, payload?, enabled?}` |
| `GET /healthz` | 200 when the database answers, 503 otherwise |
| `GET /metrics` | Prometheus metrics |

Cron specs have five fields (minute, hour, day of month, month, day of week) with ranges,
steps, lists and names, or a macro such as `@daily`. They are evaluated in UTC. A schedule that
missed several runs (no instance was running) fires once and continues from the current time.

## Testing

Tests that touch the database read `DATABASE_URL`; each test package creates its own schema,
applies the migrations into it and drops it at the end, so packages run in parallel against one
database. Without `DATABASE_URL` those tests are skipped.

```sh
export DATABASE_URL=postgres://localhost:5432/jobqueue_test?sslmode=disable
go test ./...
go test -race ./...
go vet ./... && go tool staticcheck ./...
```

Time is injected through `internal/clock`: tests drive leases, retries, schedules and the
background loops with a manual clock, and force interleavings with channels rather than sleeps.
Dependencies are vendored, so `GOFLAGS=-mod=vendor` builds and tests work offline.
