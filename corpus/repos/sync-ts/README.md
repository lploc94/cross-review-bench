# sync-ts

Offline-first document sync. Each device keeps a full replica of its user's documents in SQLite,
writes to it without a network, and syncs with a server that keeps the shared state in PostgreSQL.
Concurrent edits merge field by field: the write with the greater hybrid logical clock timestamp
wins, so every replica that has seen the same writes holds the same documents.

Built with Node.js 22+, TypeScript (strict, ESM, project references), Fastify 5, PostgreSQL (`pg`),
SQLite (`better-sqlite3`), zod and pino, as three npm workspaces:

| Package | |
|---|---|
| `@sync/shared` | hybrid logical clock, collections and their field schemas, merge rule, wire protocol |
| `@sync/server` | HTTP API, push and pull services, PostgreSQL migrations, admin scripts |
| `@sync/client` | `SyncClient` (local replica, outbox, sync loop), HTTP transport, command-line client |

## Concepts

**Collections.** Documents live in two collections, each a fixed set of optional fields checked
by a zod schema on the client and again on the server:

| Collection | Fields |
|---|---|
| `notes` | `title` (≤200 chars), `body` (≤8000), `pinned` (boolean), `tags` (≤20 non-empty strings of ≤40), `color` (`none`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`) |
| `tasks` | `title` (≤200), `done` (boolean), `dueDate` (`YYYY-MM-DD` or null), `priority` (0–3), `notes` (≤4000), `noteId` (a document id or null) |

Document ids are 1–64 letters, digits, `_` or `-`, chosen by the client. Documents are never
deleted.

**Hybrid logical clock.** Every replica, and the server, runs an HLC: a physical time in
milliseconds, a counter for events within the same millisecond, and the node id that breaks the
remaining ties. Timestamps travel as `<15-digit wall ms>:<5-digit counter>:<node>`, which sorts
in timestamp order as plain text. A clock never goes backwards: receiving a timestamp moves it
past that timestamp, and a replica stores its last timestamp so a restart continues after it even
if the system clock went back. A remote timestamp more than `MAX_CLOCK_DRIFT_MS` ahead of the
local physical clock is refused.

**Mutations and merging.** A local `set` of some fields of a document becomes one mutation: a
client-chosen UUID, the collection, the document id, the fields and one HLC timestamp. It is
applied to the replica and queued in the outbox in the same transaction. Each field of a
document carries the timestamp of the write that set it; a write replaces a field only when its
timestamp is greater. The server applies the same rule, so the order in which mutations arrive
does not change the result.

**Push.** `POST /v1/sync/push` takes up to `PUSH_MAX_MUTATIONS` mutations and applies them in one
transaction. Mutation ids already recorded for the user are acknowledged without being applied
again, so a client that lost an answer can simply send the batch again. Every field write that
wins becomes an event in the user's change feed and updates the stored document. One invalid
mutation rejects the whole request (422 with its `index`), as does a timestamp too far ahead
(422 `clock_drift`). The answer lists every mutation id of the request and the server's clock,
which the client merges into its own. Pushes of one user are serialized, so events get their
sequence numbers in commit order.

**Pull.** `GET /v1/sync/pull?after=<seq>&limit=<n>` returns the user's events with `seq > after`
in ascending order, at most `limit` (`PULL_DEFAULT_LIMIT` by default, at most `PULL_MAX_LIMIT`),
with `nextAfter` (the last event's seq, or `after`) and `hasMore`. Sequence numbers increase but
are shared by all users, so a user's feed has gaps. A device's own events come back too and
change nothing, because their timestamps are not newer than what the replica holds. Pulling with
`after = N` records `N` as the device's cursor; `GET /v1/sync/status` returns it with the user's
latest seq.

**Client sync.** `SyncClient.sync()` pushes the outbox in batches, oldest first, removing what
the server acknowledged; then it pulls pages until `hasMore` is false, applying each page
together with the new cursor and clock in one SQLite transaction. A failure leaves everything
applied before it in place, and the next `sync()` continues from there: the outbox still holds
every unacknowledged mutation and the cursor points after the last applied page. The error is a
`SyncError` whose `retryable` tells whether trying again later can help (network failures and
5xx answers) or not (4xx answers, a protocol mismatch, an answer that breaks the protocol). The
client does not retry by itself. Calls to `sync()` while one runs share it.

**Devices and tokens.** A user has up to 50 devices. Each device authenticates with
`Authorization: Bearer sd_<device id>_<secret>`; only the sha256 of the secret is stored, and
the token is shown once, when the device is registered. Any device of a user can register
another one.

**Protocol version.** Requests to `/v1/sync/*` must send `Sync-Protocol: 1`; a missing or other
version is answered 426 `protocol_mismatch` with the server's version. Every answer carries the
`Sync-Protocol` header.

## API

| Method | Path | |
|---|---|---|
| GET | `/health` | 200 when the database answers, 503 otherwise; no token |
| POST | `/v1/sync/push` | `{ "mutations": [...] }` → `{ "acked": [...], "serverHlc" }` |
| GET | `/v1/sync/pull?after=&limit=` | `{ "events": [...], "nextAfter", "hasMore" }` |
| GET | `/v1/sync/status` | `{ "latestSeq", "cursor" }` |
| GET | `/v1/documents/:collection/:id` | the server's state of a document, with its field timestamps |
| GET | `/v1/me` | the calling device and its user |
| GET | `/v1/devices` | the user's devices with their cursors |
| POST | `/v1/devices` | `{ "name" }` → 201 `{ "device", "token" }` |

Every route except `/health` needs a device token. Errors always have the shape
`{ "error": { "code", "message", "details"? } }`:

| Status | Codes |
|---|---|
| 400 | `validation_error`, `bad_request` |
| 401 | `unauthorized` |
| 404 | `not_found` |
| 409 | `device_limit` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `invalid_mutation`, `clock_drift` |
| 426 | `protocol_mismatch` |
| 500 | `internal_error` |
| 503 | `unavailable` |

Example:

```sh
curl -s localhost:3000/v1/sync/push \
  -H "Authorization: Bearer $SYNC_TOKEN" \
  -H "Sync-Protocol: 1" \
  -H "Content-Type: application/json" \
  -d '{"mutations":[{"mutationId":"6f1c2a8e-0b7d-4f3a-9c5e-2d4b8a1e7f60","collection":"notes",
       "docId":"groceries","op":"set","fields":{"title":"Groceries"},
       "hlc":"001894701600000:00000:laptop-1"}]}'
```

## Layout

```
packages/shared/src/core/   clock, HLC, ids, collections, merge, documents, protocol schemas, errors
packages/server/
  migrations/               plain SQL, applied in order by src/db/migrate.ts
  src/api/                  routes, plugins (auth, protocol, errors), zod schemas, serializers
  src/services/             push, pull, accounts, auth, documents, stats, consistency check
  src/domain/               accounts, tokens, errors
  src/repositories/         one module per table: SQL and row mappers
  src/db/                   pool, transactions, migration runner
  src/infra/logger.ts       pino with the Authorization header and tokens redacted
  src/config/env.ts         environment variables, validated at startup
  src/scripts/              migrate and admin command-line tools
  src/app.ts, src/main.ts   wiring and process entry point
packages/client/src/
  store/                    SQLite database, schema migrations (PRAGMA user_version), stores
  sync/                     SyncClient, push and pull phases, remote apply, change and state events
  transport/                transport interface, HTTP transport, errors
  cli/                      command-line client
packages/*/test/            vitest suites; test/helpers have the app builders and fixtures
```

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | `postgres://…` |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | listen address |
| `LOG_LEVEL` | `info` | pino level |
| `DATABASE_POOL_MAX` | `10` | |
| `SERVER_NODE_ID` | `server` | the server's HLC node id; give each instance its own |
| `MAX_CLOCK_DRIFT_MS` | `60000` | how far ahead of the server clock a mutation may be |
| `PUSH_MAX_MUTATIONS` | `500` | mutations per push |
| `PULL_MAX_LIMIT`, `PULL_DEFAULT_LIMIT` | `1000`, `200` | events per pull page |
| `BODY_LIMIT_BYTES` | `33554432` | largest request body (a full push of the largest documents fits) |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | graceful shutdown limit |

The server refuses to start, listing every problem, when a variable is invalid. See
`.env.example`. The command-line client reads `SYNC_SERVER_URL`, `SYNC_TOKEN`, `SYNC_DB`
(default `replica.sqlite`) and `SYNC_TIMEOUT_MS` (default `30000`); `--server`, `--token` and
`--db` override them.

## Running

```sh
npm ci
npm run build
set -a; . ./.env; set +a                 # or export the variables another way
npm run migrate
npm run admin -- create-user --email ada@example.test --name Ada --device laptop
npm start
```

`create-user` prints the user, its first device and that device's token. `npm start` serves the
API; on SIGTERM or SIGINT it stops accepting requests, finishes the ones in flight and closes its
connections.

The command-line client works on a local replica:

```sh
export SYNC_SERVER_URL=http://localhost:3000 SYNC_TOKEN=sd_…
npm run cli -- set notes groceries title=Groceries tags=home,weekly
npm run cli -- sync
npm run cli -- list notes
npm run cli -- status
```

It exits 0 on success, 1 on a failure, 2 on a usage error and 75 on a failure worth retrying
later.

Admin scripts (`npm run admin -- <command>`): `create-user`, `add-device --email --device`,
`list-devices --email`, `stats --email` (events, documents, how many events each device has
still to pull) and `verify --email`, which replays the user's events and exits 1 when the stored
documents disagree with them.

## Testing

The suites need a PostgreSQL database of their own:

```sh
export DATABASE_URL=postgres://sync:sync@localhost:5432/sync_test
npx vitest run                                        # whole suite
npx vitest run packages/client/test/e2e               # one directory
npx tsc -b
npx eslint .
```

The global setup applies the migrations to `DATABASE_URL`, and every table is truncated before
each test of every package, so never point it at data you want to keep. Test files run one at a
time. The client suites run real `SyncClient`s against the real server in process: their
transport sends requests through Fastify's `inject` and can fail a request, lose its answer or
hold it until the test releases it. Server and clients run on manual clocks the tests move, and
replicas are in memory or in temporary files.
