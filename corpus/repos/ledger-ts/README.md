# ledger-ts

A double-entry ledger and wallet HTTP API. Tenants hold accounts in eight currencies, move money
between them with idempotent transfers, reserve funds with holds, quote FX conversions, and receive
signed webhooks for everything that happens on their ledger.

Built with Node.js 22+, TypeScript (strict, ESM), Fastify 5, PostgreSQL (`pg`), Redis (`ioredis`),
zod and pino.

## Concepts

**Tenants and API keys.** Every row except the currency list belongs to a tenant, and every query
is scoped by the caller's tenant: an id owned by another tenant answers 404. Clients authenticate
with `Authorization: Bearer lk_<prefix>_<secret>`; only the sha256 of the secret is stored. Each
key carries scopes, and each route requires exactly one of them:

| Scope | Grants |
|---|---|
| `accounts:read` / `accounts:write` | read / open and close accounts |
| `transfers:read` / `transfers:write` | read transfers and account entries / post transfers |
| `holds:read` / `holds:write` | read / create, capture and void holds |
| `fx:read` | read rates and quotes |
| `webhooks:manage` | manage webhook endpoints and read events |

Requests are rate limited per API key in a fixed one-minute window (`RATE_LIMIT_PER_MINUTE`);
over the limit the API answers 429 with `Retry-After`.

**Money.** Amounts are integers of the currency's minor unit, carried as decimal strings on the
wire (`"amount": "1050"` is 10.50 USD) and as `bigint` in the code. Exponents follow ISO 4217:
USD, EUR, GBP, CHF 2; JPY, VND 0; KWD, BHD 3.

**Accounts.** `wallet` accounts never go below zero available; `system` accounts (funding,
settlement) may. `available = balance − held`.

**Transfers.** A transfer moves an amount between two accounts of its currency. It writes two
entries, a negative debit and a positive credit that sum to zero, each with the balance it leaves.
Both accounts are locked in ascending id order inside the transaction, so concurrent transfers
are serialized without deadlocks.

**Idempotency.** `POST /transfers` requires an `Idempotency-Key` header (1–255 visible ASCII
characters). A retry with the same key and body returns the original response with
`Idempotent-Replayed: true`; the same key with a different body is 409 `idempotency_conflict`.
Keys are claimed in the transfer's own transaction, so a request that fails can be retried with
the same key. Keys are scoped by tenant.

**Holds.** A hold reserves part of an account's available funds for up to seven days. It can be
captured in full into another account while `now < expires_at`, or voided at any time while
active; voiding is also how the funds of an expired, uncaptured hold are released.

**FX.** Rates are scaled integers (`rate_scaled / 10^8` units of quote per unit of base), each
effective from `effective_at`. Conversion uses bigint arithmetic only and rounds half to even.
Rates are loaded with `npm run seed-fx-rates`.

**Webhooks and events.** Changes write events to a transactional outbox (`transfer.posted`,
`hold.created`, `hold.captured`, `hold.voided`). The dispatcher posts each event to the tenant's
active endpoints with

```
X-Ledger-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
```

keyed with the endpoint's secret (returned once, when the endpoint is created). Verify the HMAC
over the raw body and reject timestamps more than five minutes off.

Delivery guarantees:

- **At least once.** An event is marked delivered only when every endpoint accepted it (2xx);
  otherwise it is retried for all endpoints with exponential backoff (`OUTBOX_BACKOFF_BASE_MS`
  doubling up to `OUTBOX_BACKOFF_MAX_MS`). Deduplicate on the event `id`.
- **Ordered per aggregate.** Events of the same aggregate (one transfer, one hold) are delivered
  in creation order, and an event that keeps failing holds back the later events of its
  aggregate. Events of different aggregates do not wait for each other.

## API

| Method | Path | Scope |
|---|---|---|
| GET | `/health/live` | none |
| POST | `/accounts` | `accounts:write` |
| GET | `/accounts`, `/accounts/:id` | `accounts:read` |
| POST | `/accounts/:id/close` | `accounts:write` |
| GET | `/accounts/:id/entries` | `transfers:read` |
| POST | `/transfers` | `transfers:write` |
| GET | `/transfers`, `/transfers/:id` | `transfers:read` |
| POST | `/holds`, `/holds/:id/capture`, `/holds/:id/void` | `holds:write` |
| GET | `/holds`, `/holds/:id` | `holds:read` |
| GET | `/fx/rates/:base/:quote`, `/fx/quote?from=&to=&amount=` | `fx:read` |
| POST, GET | `/webhooks` | `webhooks:manage` |
| DELETE | `/webhooks/:id` | `webhooks:manage` |
| GET | `/events`, `/events/:id` | `webhooks:manage` |

Lists use offset pagination (`limit` 1–100, default 25; `offset`) and answer
`{ "data": [...], "pagination": { "limit", "offset", "has_more" } }`, newest first. Lists that
filter by creation time take `created_from` (inclusive) and `created_to` (exclusive), ISO 8601
timestamps with a time zone: `created_from <= created_at < created_to`.

Errors always have the shape `{ "error": { "code", "message", "details"? } }`:

| Status | Codes |
|---|---|
| 400 | `validation_error`, `bad_request` |
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `conflict`, `idempotency_conflict`, `invalid_hold_state` |
| 422 | `insufficient_funds`, `currency_mismatch`, `account_closed` |
| 429 | `rate_limited` |
| 500 | `internal_error` |

Example:

```sh
curl -s localhost:3000/transfers \
  -H "Authorization: Bearer $LEDGER_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"from_account_id":"…","to_account_id":"…","amount":"1050","currency":"USD"}'
```

## Layout

```
migrations/          plain SQL, applied in order by src/db/migrate.ts
src/
  api/               routes, plugins (auth, rate limit, errors), zod schemas, serializers
  services/          use cases: transfers, holds, idempotency, outbox dispatcher, webhooks, FX
  domain/            money, currencies, FX math, scopes, errors, entity types and rules
  repositories/      one module per table: SQL and row mappers
  db/                pool, transactions, migration runner
  infra/             config-free adapters: logger, clock, Redis, rate limiter, HTTP webhook sender
  config/env.ts      environment variables, validated at startup
  scripts/           command-line tools (migrate, tenants, API keys, FX rates, ledger checks)
  app.ts, main.ts    wiring and process entry point
test/                vitest suites; test/helpers has the app builder and fixtures
```

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | `postgres://…` |
| `REDIS_URL` | required | `redis://…` |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | listen address |
| `LOG_LEVEL` | `info` | pino level |
| `DATABASE_POOL_MAX` | `10` | |
| `RATE_LIMIT_PER_MINUTE` | `600` | per API key |
| `OUTBOX_BATCH_SIZE` | `50` | events claimed per dispatcher batch |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | idle wait between batches |
| `OUTBOX_BACKOFF_BASE_MS`, `OUTBOX_BACKOFF_MAX_MS` | `5000`, `3600000` | retry backoff |
| `WEBHOOK_TIMEOUT_MS` | `5000` | per delivery |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | graceful shutdown limit |

The service refuses to start, listing every problem, when a variable is invalid. See
`.env.example`.

## Running

```sh
npm ci
npm run build
npm run migrate
npm run create-tenant -- --name "Acme"        # prints the tenant id and its first API key
npm run seed-fx-rates -- --tenant <id> --file rates.json
npm start
```

`npm start` serves the API and runs the outbox dispatcher in the same process. On SIGTERM or
SIGINT it stops accepting requests, finishes in-flight requests and the current dispatcher
batch, then closes its connections.

Operational scripts:

- `npm run api-keys -- issue|list|revoke --tenant <id> …` manages API keys.
- `npm run verify-ledger [-- --tenant <id>]` checks that transfers balance and that balances and
  held amounts match the entries and holds; it exits 1 and prints the problems when they do not.
- `npm run show-transfer -- <transfer id>` prints any tenant's transfer with its entries and
  account names, for support investigations.

## Testing

The suites need a PostgreSQL database and a Redis logical database of their own:

```sh
export DATABASE_URL=postgres://ledger:ledger@localhost:5432/ledger_test
export REDIS_URL=redis://localhost:6379/15
npx vitest run                         # whole suite
npx vitest run test/api/holds.test.ts  # one file
npx tsc --noEmit
npx eslint .
```

The global setup applies the migrations to `DATABASE_URL`; before each test every table except
the currency list is truncated and the Redis database is flushed (`FLUSHDB`), so never point
these variables at data you want to keep. Test files run one at a time. Time-dependent behaviour
(hold expiry, rate-limit windows, retry schedules, timestamps) runs on a manual clock that the
tests move, and webhooks go to a recording fake sender.
