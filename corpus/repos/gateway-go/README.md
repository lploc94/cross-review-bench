# gateway

An HTTP API gateway: a reverse proxy that matches requests to routes, authenticates consumers by
API key or HMAC signature, rate-limits them in Redis, and forwards to weighted upstreams with
retries, circuit breakers and active health checks. An admin API on a separate listener manages
consumers and credentials and serves health and Prometheus metrics.

The gateway is one Go binary with Redis as its only dependency. Routes come from a JSON file that is
validated at startup and reloaded on `SIGHUP`; consumers, credentials and rate-limit counters live
in Redis.

## Layout

```text
cmd/gateway/        the server: config, listeners, SIGHUP reload, graceful shutdown
cmd/gatewayctl/     admin CLI: consumers, keys, HMAC secrets, routes; signs HMAC requests
internal/config/    environment settings and the routes file, with validation
internal/core/      route table and matcher, weighted balancer, circuit breaker, retry and
                    rate-limit policies, the runtime that swaps tables on reload
internal/proxy/     the request path: match, authenticate, rate-limit, forward, relay
internal/auth/      API key and HMAC authenticators
internal/health/    active health checker, one goroutine per upstream
internal/store/     Redis: consumers, credentials, fixed-window counters (Lua scripts)
internal/api/       admin API (Go 1.22 ServeMux patterns)
internal/client/    Go client for the admin API, used by gatewayctl
internal/model/     consumers, credentials and the shared error values
internal/header/    hop-by-hop and gateway-owned header names
internal/clock/     real and manual clocks
internal/metrics/   Prometheus text exposition
internal/logging/   slog JSON logger that redacts credentials
internal/testredis/ per-test Redis key spaces for tests
```

## Request path

1. The path must be clean (absolute, no empty, `.` or `..` segments), or the answer is `400`.
2. The route table picks a route: routes with a `host` are tried before routes without; an exact
   `path` beats a `path_prefix`, and the longest prefix wins. Prefixes match whole segments
   (`/api` matches `/api` and `/api/x`, not `/apis`; `/api/` matches only below `/api`). A path that
   matches but whose method no route accepts gets `405` with `Allow`; no match at all is `404`.
3. The route's `auth` mode runs: `api_key` reads `Authorization: Bearer <key>` or `X-Api-Key`;
   `hmac` checks `Authorization: HMAC key_id=…, signature=…, timestamp=…` over the buffered body.
   Credential headers are not forwarded; the upstream gets the consumer in `X-Consumer-Id`.
4. The route's `rate_limit` counts the request per consumer (per client address on routes without
   auth) in a fixed window. Every limited response carries `RateLimit-Limit`, `RateLimit-Remaining`
   and `RateLimit-Reset`; a rejection is `429` with `Retry-After`. When Redis fails the request goes
   through and `gateway_rate_limit_errors_total` counts it.
5. The request is forwarded to a healthy upstream whose circuit breaker admits it, chosen by
   smooth weighted round-robin. Hop-by-hop headers are removed in both directions;
   `X-Forwarded-For`, `-Proto` and `-Host` are extended only when the peer is in `TRUSTED_PROXIES`
   and replaced otherwise, and `X-Real-Ip`, `X-Forwarded-Port` and `Forwarded` from other peers
   are dropped; `X-Request-Id` is propagated when well formed and generated if not. Request
   trailers are forwarded under the same rules as the header, transforms included.
6. Retries follow the route's `retry` policy, only for GET, HEAD, OPTIONS, PUT and DELETE unless
   `non_idempotent` is set, and only when the body was buffered: bodies up to `BODY_BUFFER_LIMIT`
   are held in memory, longer ones are streamed and sent once. Each retry waits an exponential
   backoff with jitter and prefers an upstream not tried yet.
7. The response streams back with its trailers, which follow the same rules as its header
   (hop-by-hop fields and the route's response transform); event streams and bodies of unknown
   length are flushed after every write. No response headers within the route's `timeout` is
   `504`, a connection failure `502`, open breakers `503 circuit_open`, no healthy upstream
   `503 no_healthy_upstream`. A client that goes away gets its connection aborted rather than a
   response that looks complete.

Every response the gateway produces itself is JSON:

```json
{"error":{"code":"rate_limited","message":"rate limit exceeded; retry after the window resets","request_id":"4f1c…"}}
```

## Routes file

```json
{
  "routes": [
    {
      "id": "orders",
      "host": "api.example.com",
      "path_prefix": "/orders",
      "methods": ["GET", "POST"],
      "upstreams": [
        {"url": "http://orders-a.internal:8080", "weight": 3},
        {"url": "http://orders-b.internal:8080"}
      ],
      "strip_prefix": false,
      "timeout": "5s",
      "auth": "api_key",
      "rate_limit": {"requests": 100, "window": "1m"},
      "retry": {"attempts": 3, "on_status": [502, 503, 504], "on_errors": ["connect", "timeout", "reset"],
                "backoff": "50ms", "max_backoff": "1s", "non_idempotent": false},
      "circuit_breaker": {"failure_ratio": 0.5, "min_requests": 10, "window": 20,
                          "open_duration": "30s", "half_open_probes": 1},
      "health_check": {"path": "/healthz", "interval": "10s", "timeout": "2s",
                       "healthy_threshold": 2, "unhealthy_threshold": 3},
      "transforms": {
        "request":  {"add": {"X-Env": "prod"}, "remove": ["X-Debug"], "rename": {"X-Ver": "X-Version"}},
        "response": {"remove": ["Server"]}
      }
    }
  ]
}
```

Only `id`, one of `path` or `path_prefix`, and `upstreams` are required; the values above for
`retry`, `circuit_breaker` and `health_check` are the defaults filled in when the object is present.
`auth` defaults to `none` and `timeout` to `30s`. Transforms run rename, then remove, then add; they
may not touch hop-by-hop fields, `Host`, `Content-Length`, `Trailer` or the headers the gateway
owns (`X-Request-Id`, `X-Forwarded-For`, `-Proto` and `-Host`, `X-Consumer-Id`).

Every problem is reported with the route and field, for example
`route "orders": retry.attempts: must be between 1 and 10, got 11`. Check a file without starting
the gateway:

```sh
go run ./cmd/gateway check-routes routes.json
```

On `SIGHUP` (or `POST /admin/v1/routes/reload`) the gateway reads the file again. An invalid file
is logged and the live table stays; a valid one is swapped in atomically, keeping the breaker and
health state of upstreams whose settings did not change.

## Running

You need Go 1.25 and Redis 6 or later. The gateway does not support Redis Cluster: its Lua
scripts derive key names from their arguments.

```sh
export REDIS_URL=redis://localhost:6379/0
export ROUTES_FILE=$PWD/routes.json
export ADMIN_TOKEN=$(openssl rand -hex 32)

go run ./cmd/gateway check-routes "$ROUTES_FILE"
go run ./cmd/gateway                    # proxy on :8080, admin API and /metrics on :9090
kill -HUP "$(pgrep -f cmd/gateway)"     # reload the routes file
```

`gateway version` prints the build. Manage consumers with `gatewayctl`:

```sh
export GATEWAY_ADMIN_URL=http://127.0.0.1:9090 GATEWAY_ADMIN_TOKEN=$ADMIN_TOKEN
go run ./cmd/gatewayctl consumer-create billing
go run ./cmd/gatewayctl key-issue c_3f9a0c2b7d14e6a8          # prints the key once
curl -H "X-Api-Key: gk_…" localhost:8080/orders/42

go run ./cmd/gatewayctl hmac-create c_3f9a0c2b7d14e6a8        # prints key_id and secret once
go run ./cmd/gatewayctl sign -key-id hk_… -secret … -method POST -path /orders -body-file order.json
```

### Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `REDIS_URL` | required | Redis connection URL |
| `REDIS_KEY_PREFIX` | `gw:` | prefix of every key the gateway writes |
| `ROUTES_FILE` | required | path of the routes file |
| `PROXY_ADDR` | `:8080` | proxy listener |
| `ADMIN_ADDR` | `:9090` | admin API, `/healthz`, `/readyz` and `/metrics` |
| `ADMIN_TOKEN` | required | bearer token of the admin API, at least 32 characters |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `SHUTDOWN_TIMEOUT` | `15s` | how long in-flight requests may finish on SIGTERM/SIGINT |
| `READ_HEADER_TIMEOUT` | `10s` | for reading request headers on both listeners |
| `IDLE_TIMEOUT` | `2m` | keep-alive idle timeout on both listeners |
| `UPSTREAM_DIAL_TIMEOUT` | `5s` | connecting to an upstream |
| `UPSTREAM_MAX_IDLE_CONNS` | `64` | idle connections kept per upstream host |
| `TRUSTED_PROXIES` | none | comma-separated CIDRs whose `X-Forwarded-*` and `X-Real-Ip` headers are believed |
| `BODY_BUFFER_LIMIT` | `1048576` | bytes of request body held for retries and HMAC; HMAC routes reject longer bodies with `413` |
| `HMAC_CLOCK_SKEW` | `5m` | how far an HMAC timestamp may be from the gateway's clock (at most `1h`) |

Logs are JSON lines on stdout. Credentials (`Authorization`, API keys, secrets, signatures, the
admin token) are never logged; the access log records the path without the query string.

### HMAC signatures

The signature is the hex HMAC-SHA256, keyed with the secret, of five lines joined by `\n`:

```text
POST                       method exactly as sent (methods are case-sensitive)
/orders/a%2Fb              path exactly as sent in the request line
a=1&b=2&b=3                query: pairs sorted by name then value, RFC 3986 escaping (%20 for space)
1717329600                 timestamp, Unix seconds, also sent in the header
9f86d081884c7d65…          hex SHA-256 of the body (of the empty string when there is none)
```

### Admin API

All `/admin/v1` endpoints require `Authorization: Bearer $ADMIN_TOKEN` and answer JSON.

| Method and path | |
|-----------------|-|
| `GET /admin/v1/health` | Redis and upstream health; `503` when Redis is down |
| `GET /admin/v1/routes`, `GET /admin/v1/routes/{id}` | live routes with upstream health and breaker state |
| `POST /admin/v1/routes/reload` | reload the routes file; `422` with the problems when it is invalid |
| `POST /admin/v1/consumers` | `{"name": "billing", "enabled": true}` |
| `GET /admin/v1/consumers?offset=0&limit=100` | page of consumers |
| `GET`, `PATCH`, `DELETE /admin/v1/consumers/{id}` | read, rename/enable/disable, delete with credentials |
| `POST`, `GET /admin/v1/consumers/{id}/keys` | issue a key (shown once), list keys |
| `DELETE /admin/v1/consumers/{id}/keys/{prefix}` | revoke a key |
| `POST`, `GET /admin/v1/consumers/{id}/hmac-secrets` | create a secret (shown once), list |
| `DELETE /admin/v1/consumers/{id}/hmac-secrets/{key_id}` | revoke a secret |

`GET /healthz` (liveness), `GET /readyz` (Redis reachable and routes loaded) and `GET /metrics`
need no token.

## Testing

Tests that touch Redis read `REDIS_URL`; each test gets its own key prefix
(`internal/testredis`), and its cleanup deletes exactly the keys under that prefix, so packages run
in parallel against one database and nothing is flushed. Without `REDIS_URL` those tests are
skipped.

```sh
export REDIS_URL=redis://localhost:6379/15
go test ./...
go test -race ./...
go vet ./... && go tool staticcheck ./...
```

Upstreams in tests are `httptest` servers or a recording `http.RoundTripper`. Time is injected
through `internal/clock`: tests drive route timeouts, retry backoff, breaker open durations, health
check intervals, rate-limit windows and signature timestamps with a manual clock, and force
interleavings with channels rather than sleeps. Dependencies are vendored, so
`GOFLAGS=-mod=vendor` builds and tests work offline.
