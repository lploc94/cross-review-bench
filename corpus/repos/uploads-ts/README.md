# uploads-ts

A multi-tenant file upload service. Tenants store files under folder-like paths, upload them in
one request or in resumable chunks, download them with their API key or through signed links,
and stay within a byte quota. New files are scanned for malware before anyone can download them.
Bytes live on the local disk or in an S3-compatible bucket.

Built with Node.js 22+, TypeScript (strict, ESM), Fastify 5, `@fastify/multipart`, PostgreSQL
(`pg`), zod and pino. The S3 client (SigV4 signing, XML parsing) is written in-repo over Node's
`fetch`.

## Concepts

**Tenants and API keys.** Every file and upload session belongs to a tenant, and every query is
scoped by the caller's tenant: an id or path owned by another tenant answers 404. Clients
authenticate with `Authorization: Bearer up_<prefix>_<secret>`; only the sha256 of the secret is
stored. Each key carries scopes, and each route requires exactly one of them:

| Scope | Grants |
|---|---|
| `files:read` | list files, read metadata, download, create signed links |
| `files:write` | upload with `PUT /v1/files/…` or `POST /v1/files` |
| `files:delete` | delete files |
| `uploads:write` | resumable upload sessions |
| `tenant:read` | read the tenant's usage and quota |
| `tenant:admin` | change the quota |

**Paths.** A path is a name chosen by the tenant, such as `reports/2030/q1.pdf`. It is stored in
Unicode NFC, so composed and decomposed forms name the same file. Rejected: an empty path, a
leading `/`, empty, `.` or `..` segments (so also a trailing `/` and `//`), backslashes, control
characters, more than 1024 bytes of UTF-8 in total or 255 in one segment, and `by-id` as the
first segment (it would collide with the `/v1/files/by-id/…` routes). One live file exists per
tenant and path. Paths are only names: storage keys are built from the tenant and file ids
(`t/<tenant id>/<file id>`), never from a path.

**Content types.** The stored `contentType` is sniffed from the first 4 KiB of the bytes, never
taken from the client: PNG, JPEG, GIF, WebP, PDF, ZIP and gzip by signature, UTF-8 text as
`text/plain; charset=utf-8`, anything else `application/octet-stream`. What the client declared is
kept as `declaredType`, for reference only. Width and height are recorded for PNG, GIF and JPEG
images (a JPEG's frame header is looked for in its first 64 KiB).

**Quota.** `usedBytes` counts the stored files plus the declared size of every open upload
session. Bytes are reserved before they are stored when the size is known up front (a
`Content-Length`, a session's declared size), otherwise as soon as the body has been stored;
either way, an upload that does not fit fails with 422 `quota_exceeded` and leaves nothing
behind. Replacing a file (`overwrite=true`) needs room for both files until the new one is
recorded. Deleting a file, aborting a session and the expiry of a session release their bytes.
Lowering the quota below the current usage removes nothing; it only stops new uploads.

**Scanning.** A new file is `pending_scan` and cannot be downloaded (409 `file_not_available`)
until the scan worker has scanned it: a clean file becomes `available`, an infected one
`quarantined` and is never served. A scan that fails (scanner unreachable, unreadable object) is
retried with exponential backoff (`SCAN_BACKOFF_BASE_S` doubling up to `SCAN_BACKOFF_MAX_S`);
after `SCAN_MAX_ATTEMPTS` failed attempts the file is quarantined. With `SCANNER=http` the bytes
are POSTed to `SCANNER_URL`, which answers 200 with `{"result":"clean"}` or
`{"result":"infected"}`; anything else counts as a failed attempt. `SCANNER=noop` marks every file
clean.

**Downloads.** A download answers the stored content type, `Content-Length`,
`Content-Disposition: attachment` with the original file name (characters outside printable ASCII
and `"`/`\` replaced by `_`), `X-Content-Type-Options: nosniff`, `Cache-Control: private`, and the
file's sha256 as a strong `ETag`; a matching `If-None-Match` answers 304.

**Signed links.** `POST /v1/files/by-id/:id/signed-url` with `{"expiresIn": <seconds>}` (1 to
`SIGNED_URL_MAX_TTL_S`) returns `{"url": "/v1/public/<id>?exp=<unix seconds>&sig=<hex>",
"expiresAt": "<ISO 8601>"}`. Anyone holding the link can download the file without an API key
until `exp`; `sig` is the HMAC-SHA256 of `<id>.<exp>` keyed with `SIGNING_SECRET`. A wrong
signature is 403 `invalid_signature`, an expired link 403 `signed_url_expired`, a link to a
deleted file 404. Signatures are redacted from the logs.

**Resumable uploads.** A session is created with the path and the total size, which is reserved
against the quota at once. Chunks are sent with `PATCH` and an `Upload-Offset` header that must
equal the session's current offset; a chunk that starts elsewhere is 409 `offset_mismatch`, and
the answer's `Upload-Offset` header tells where to continue. One chunk is written at a time (409
`chunk_in_progress` while another is being written; a writer that disappears loses its claim
after `UPLOAD_CHUNK_LEASE_S`). A chunk may not run past the declared size (413), and a session
takes at most 10,000 chunks. Once the offset equals the size, `complete` assembles the chunks into
a file; before that it is 409 `upload_incomplete`. Sessions expire `UPLOAD_SESSION_TTL_S` after
they are created; an expired or aborted session releases its bytes and its staged chunks.

**Deletion and cleanup.** Deleting a file marks its row deleted, releases its bytes and removes
its storage object right away. A background cleanup job (every `CLEANUP_INTERVAL_S`) expires
sessions past their expiry, removes the objects of deleted files whose removal failed once
`DELETED_GRACE_S` has passed, and removes staged chunks that belong to no open session. Several
instances can run the scan worker and the cleanup job at once: rows are claimed with
`FOR UPDATE SKIP LOCKED`.

## API

| Method | Path | Scope | Success |
|---|---|---|---|
| GET | `/health/live`, `/health/ready` | none | 200 (`/health/ready` 503 without the database) |
| GET | `/v1/files?limit=&after=` | `files:read` | 200 |
| PUT | `/v1/files/<path>[?overwrite=true]` | `files:write` | 201, or 200 when it replaced a file |
| POST | `/v1/files[?overwrite=true]` (multipart) | `files:write` | 201, or 200 when it replaced a file |
| GET | `/v1/files/<path>` | `files:read` | 200 (304 on a matching `If-None-Match`) |
| DELETE | `/v1/files/<path>` | `files:delete` | 204 |
| GET | `/v1/files/by-id/:id` | `files:read` | 200 (304) |
| GET | `/v1/files/by-id/:id/meta` | `files:read` | 200 |
| POST | `/v1/files/by-id/:id/signed-url` | `files:read` | 200 |
| GET | `/v1/public/:id?exp=&sig=` | none (signed) | 200 (304) |
| POST | `/v1/uploads[?overwrite=true]` | `uploads:write` | 201 with `Location` |
| PATCH | `/v1/uploads/:id` | `uploads:write` | 204 |
| HEAD | `/v1/uploads/:id` | `uploads:write` | 200 |
| POST | `/v1/uploads/:id/complete` | `uploads:write` | 201, or 200 when it replaced a file |
| DELETE | `/v1/uploads/:id` | `uploads:write` | 204 |
| GET | `/v1/tenant` | `tenant:read` | 200 |
| PATCH | `/v1/tenant` | `tenant:admin` | 200 |

Paths in URLs are percent-encoded segment by segment (`/v1/files/team%20notes/week%201.txt`).

- **`PUT /v1/files/<path>`** takes the file's bytes as the body, of any content type, with a
  `Content-Length` or chunked. Without `overwrite=true` an existing file at the path is 409
  `path_exists`.
- **`POST /v1/files`** takes `multipart/form-data` with a `path` field followed by one file part;
  the part's file name becomes the file's `originalName`.
- Both answer 413 `payload_too_large` for more than `MAX_UPLOAD_BYTES`, announced or not.
- **Files** are returned as `{ id, path, size, sha256, contentType, declaredType, originalName,
  status, image: { width, height } | null, createdAt, updatedAt }`.
- **`GET /v1/files`** lists live files in byte order of their paths: `limit` 1 to
  `LIST_MAX_LIMIT` (default 100, or `LIST_MAX_LIMIT` when lower), and `after` the `nextCursor` of
  the previous page. It answers `{ "data": [...], "nextCursor": "<opaque>" | null }`.
- **`POST /v1/uploads`** takes `{ "path", "size", "contentType"? }` and returns the session
  `{ id, path, size, offset, state, declaredType, overwrite, fileId, createdAt, expiresAt }`.
  `overwrite` is checked when the session is created and again when it completes.
- **`PATCH`, `HEAD` and `POST /v1/uploads`** answer with `Upload-Offset`, `Upload-Length` and
  `Upload-Expires` headers. A session that is completed, aborted or expired answers 409
  `upload_session_state` with its state in `details.state`.
- **`PATCH /v1/tenant`** takes `{ "quotaBytes" }`. Tenants are returned as `{ id, name,
  quotaBytes, usedBytes, availableBytes, createdAt }`.

Errors always have the shape `{ "error": { "code", "message", "details"? } }`:

| Status | Codes |
|---|---|
| 400 | `validation_error`, `bad_request` |
| 401 | `unauthorized` |
| 403 | `forbidden`, `invalid_signature`, `signed_url_expired` |
| 404 | `not_found` |
| 409 | `conflict`, `path_exists`, `file_not_available`, `upload_session_state`, `chunk_in_progress`, `upload_incomplete`, `offset_mismatch` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `quota_exceeded` |
| 500 | `internal_error` |
| 502 | `storage_error` (with `details.storageCode`; backend messages are only logged) |

Example:

```sh
curl -s -X PUT localhost:3000/v1/files/reports/2030/q1.pdf \
  -H "Authorization: Bearer $UPLOADS_TOKEN" \
  -H "Content-Type: application/pdf" \
  --data-binary @q1.pdf
```

## Layout

```
migrations/          plain SQL, applied in order by src/db/migrate.ts
src/
  api/               routes, plugins (auth, errors), zod schemas, serializers, request bodies
  services/          use cases: uploads, resumable sessions, files and signed links, scanning,
                     cleanup, tenants and API keys
  domain/            paths, content sniffing, image dimensions, cursors, scopes, errors, entities
  repositories/      one module per table: SQL and row mappers
  db/                pool, transactions, migration runner
  storage/           the storage driver interface, the local and S3 drivers, the S3 client
  infra/             config-free building blocks: logger, clock, streams, XML, background loops
  config/env.ts      environment variables, validated at startup
  client/            a typed client for the API
  scripts/           command-line tools (migrate, tenants and API keys)
  app.ts, main.ts    wiring and process entry point
scripts/uploadctl.ts command-line client built on src/client
test/                vitest suites; test/helpers has the app builder, fixtures and a fake S3
```

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | `postgres://…` |
| `SIGNING_SECRET` | required | at least 32 characters; keys the signed links |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | listen address |
| `LOG_LEVEL` | `info` | pino level |
| `DATABASE_POOL_MAX` | `10` | |
| `STORAGE_DRIVER` | `local` | `local` or `s3` |
| `STORAGE_LOCAL_ROOT` | `.data/storage` | local driver: `objects/` and `staging/` below it |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | required for `s3` | path-style requests to `<endpoint>/<bucket>/<key>` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | required for `s3` | |
| `S3_REQUEST_TIMEOUT_MS` | `30000` | longest wait for a response, and longest pause while sending |
| `MAX_UPLOAD_BYTES` | `104857600` (100 MiB) | per file, at most 5 GiB |
| `UPLOAD_SESSION_TTL_S` | `86400` | lifetime of a resumable session |
| `UPLOAD_CHUNK_LEASE_S` | `600` | longest time one chunk may take |
| `SIGNED_URL_MAX_TTL_S` | `604800` | longest signed-link lifetime |
| `LIST_MAX_LIMIT` | `1000` | largest listing page |
| `SCANNER` | `noop` | `noop` or `http` |
| `SCANNER_URL` | required for `http` | |
| `SCANNER_TIMEOUT_MS` | `30000` | per scan |
| `SCAN_MAX_ATTEMPTS` | `5` | failed attempts before quarantine |
| `SCAN_BACKOFF_BASE_S`, `SCAN_BACKOFF_MAX_S` | `30`, `3600` | retry backoff |
| `SCAN_BATCH_SIZE` | `10` | files claimed per scan batch |
| `SCAN_POLL_INTERVAL_MS` | `2000` | idle wait between batches |
| `SCAN_CLAIM_LEASE_S` | `300` | how long a claimed file is left to its worker |
| `CLEANUP_INTERVAL_S` | `300` | wait between cleanup runs |
| `CLEANUP_BATCH_SIZE` | `100` | rows per cleanup batch |
| `DELETED_GRACE_S` | `86400` | wait before cleanup removes a deleted file's object |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | graceful shutdown limit |

The service refuses to start, listing every problem, when a variable is invalid. See
`.env.example`.

## Running

```sh
npm ci
npm run build
npm run migrate
npm run admin -- create-tenant --name "Northwind Archive" --quota-bytes 10737418240
                                              # prints the tenant id and its first API key
npm start
```

`npm start` serves the API and runs the scan worker and the cleanup job in the same process. On
SIGTERM or SIGINT it stops the background jobs after their current run, stops accepting requests,
finishes in-flight requests, then closes its connections; after `SHUTDOWN_TIMEOUT_MS` it exits
anyway.

Operational scripts:

- `npm run admin -- issue-key|list-keys|revoke-key --tenant <id> …` manages API keys
  (`--scopes files:read,files:write`; all scopes by default).
- `npm run uploadctl -- put|upload|get|list|delete|signed-url|usage …` talks to a running
  service as one tenant, with `UPLOADS_URL` and `UPLOADS_TOKEN` set. `upload` uses a resumable
  session and continues one with `--session <id>`; `get` never overwrites a local file.

## Testing

The suites need a PostgreSQL database of their own:

```sh
export DATABASE_URL=postgres://uploads:uploads@localhost:5432/uploads_test
npx vitest run                          # whole suite
npx vitest run test/api/uploads.test.ts # one file
npx tsc --noEmit
npx eslint .
```

The global setup applies the migrations to `DATABASE_URL`, and before each test every table
except `schema_migrations` is truncated, so never point it at data you want to keep. Test files
run one at a time. Each test app stores files in a fresh temporary directory; S3 tests run against
an in-process fake S3 (`test/helpers/fakeS3.ts`) that checks every request's SigV4 signature.
Time-dependent behaviour (session expiry, chunk leases, scan backoff, signed-link expiry) runs on
a manual clock that the tests move, and scans go to a fake scanner whose verdicts the tests
choose.
