# authz

A multi-tenant authentication and authorisation service. People log in with an email and a
password, get a short-lived JWT access token and a rotating refresh token, belong to
organisations, and act inside them through roles that carry permissions, organisation-wide or
on a single project. Every change inside an organisation lands in an append-only audit log.

Built with Python 3.13, FastAPI, SQLAlchemy 2 (async, psycopg 3), Alembic, PostgreSQL, Redis,
pydantic-settings, argon2-cffi, PyJWT and structlog; managed with uv.

## Concepts

**Users.** An email address (trimmed and lower-cased, unique case-insensitively), an argon2id
password hash and an optional `disabled_at`. The argon2 parameters come from the configuration;
when they change, a user's hash is upgraded the next time they log in. Users are created with the
admin CLI.

**Sessions and tokens.** `POST /v1/auth/login` opens a session (a login on one device) and returns
two tokens:

- an **access token**: an HS256 JWT with the claims `iss`, `sub` (user id), `sid` (session id),
  `iat`, `exp` and `jti`, valid for `ACCESS_TOKEN_TTL_SECONDS`. It is signed with the first
  secret of `JWT_SECRETS` and accepted when any of them verifies it, so a secret can be rotated
  by putting the new one first and dropping the old one once its last tokens have expired. Each
  request also checks that the session is still open and the user still enabled.
- an opaque **refresh token** (only its SHA-256 is stored). `POST /v1/auth/refresh` spends it
  and returns a new pair in the same session; a used, expired or unknown refresh token, or one
  whose session was revoked or has expired, answers 401.

`POST /v1/auth/logout` revokes the current session; `GET /v1/sessions` lists the caller's open
sessions and `DELETE /v1/sessions/{id}` revokes one of them. Login failures all look alike (same
status, body and, through a dummy argon2 verification for unknown addresses, similar timing), so
the API does not reveal which addresses have accounts.

**Rate limits.** Fixed-window counters in Redis (INCR and EXPIRE in one Lua script): logins per
(email, client IP), refreshes per client IP. Over the limit the API answers 429 with
`Retry-After`.

**Organisations.** Every organisation-scoped route lives under `/v1/orgs/{org_id}/…` and first
resolves the caller's membership; a caller who is not a member gets 404 for the organisation, as
if it did not exist. Whoever creates an organisation becomes its first owner, and an organisation
always keeps at least one owner.

**Roles and permissions.** Permissions are strings of the form `resource:action`:

| Permission | Grants |
|---|---|
| `org:read` | see the organisation |
| `org:manage` | rename it; grant or take away ownership |
| `projects:read`, `projects:write`, `projects:delete` | read; create, edit and archive; delete projects |
| `members:read`, `members:manage` | list members and role assignments; change roles, assign roles, remove members |
| `roles:read`, `roles:manage` | list roles; create, edit and delete custom roles |
| `invitations:manage` | invite people and list pending invitations |
| `audit:read` | read the audit log |

Each organisation has four built-in roles that inherit from each other, plus any custom roles:

| Role | Own permissions | Inherits from |
|---|---|---|
| `viewer` | `org:read`, `projects:read`, `members:read`, `roles:read` | |
| `member` | `projects:write` | `viewer` |
| `admin` | `projects:delete`, `members:manage`, `roles:manage`, `invitations:manage`, `audit:read` | `member` |
| `owner` | `org:manage` | `admin` |

A custom role may name a parent role and inherits its permissions; a parent that would make a
role inherit from itself is refused. Built-in roles cannot be changed or deleted, and a role in
use (by a membership, an assignment, a pending invitation or a child role) cannot be deleted.

A member's permissions come from the role of their membership plus their **role assignments**.
An assignment is organisation-wide or limited to one project: a project-limited assignment only
counts when the permission is checked on that project. Nobody can hand out, take away or create
a role that carries a permission they do not hold themselves, so an admin cannot make anyone an
owner or demote one.

All decisions go through `AuthorizationService.check(principal, permission, resource)`; routes
declare what they need with the `require(permission, resource_from=…)` dependency.

**Invitations.** Someone with `invitations:manage` invites an address with a role. The random
token is emailed (only its hash is stored) and expires after `INVITATION_TTL_SECONDS`. The
invited person logs in with that address and calls `POST /v1/invitations/{token}/accept`; an
invitation is used once.

**Audit log.** Each change inside an organisation writes an event (`actor_id`, `action`,
`target_type`, `target_id`, `data`, client `ip`, `created_at`) in the same transaction as the
change, so an event exists exactly when its change does. Events are never updated (a trigger
refuses it). `GET /v1/orgs/{org_id}/audit` pages through them newest first with an opaque
cursor.

## API

| Method | Path | Needs |
|---|---|---|
| GET | `/health` | none |
| POST | `/v1/auth/login`, `/v1/auth/refresh` | none |
| POST | `/v1/auth/logout` | access token |
| GET, PATCH | `/v1/me` | access token |
| GET | `/v1/sessions` | access token |
| DELETE | `/v1/sessions/{session_id}` | access token (own sessions) |
| GET | `/v1/permissions` | access token |
| POST, GET | `/v1/orgs` | access token |
| GET | `/v1/orgs/{org_id}` | `org:read` |
| PATCH | `/v1/orgs/{org_id}` | `org:manage` |
| GET | `/v1/orgs/{org_id}/members`, `/members/{user_id}` | `members:read` |
| PATCH | `/v1/orgs/{org_id}/members/{user_id}` | `members:manage` |
| DELETE | `/v1/orgs/{org_id}/members/{user_id}` | membership (leaving) or `members:manage` |
| GET | `/v1/orgs/{org_id}/roles`, `/roles/{role_id}` | `roles:read` |
| POST, PATCH, DELETE | `/v1/orgs/{org_id}/roles…` | `roles:manage` |
| GET | `/v1/orgs/{org_id}/role-assignments?user_id=&project_id=` | `members:read` |
| POST, DELETE | `/v1/orgs/{org_id}/role-assignments…` | `members:manage` |
| GET | `/v1/orgs/{org_id}/projects?include_archived=&cursor=&limit=` | membership; lists readable projects |
| POST | `/v1/orgs/{org_id}/projects` | `projects:write` |
| GET | `/v1/orgs/{org_id}/projects/{project_id}` | `projects:read` on the project |
| PATCH | `/v1/orgs/{org_id}/projects/{project_id}` | `projects:write` on the project |
| DELETE | `/v1/orgs/{org_id}/projects/{project_id}` | `projects:delete` on the project |
| POST, GET | `/v1/orgs/{org_id}/invitations` | `invitations:manage` |
| POST | `/v1/invitations/{token}/accept` | access token of the invited address |
| GET | `/v1/orgs/{org_id}/audit?cursor=&limit=&action=` | `audit:read` |

Paginated lists answer `{"data": [...], "next_cursor": "…" | null}` (`limit` 1–200, default 50);
other lists answer `{"data": [...]}`. Errors always have the shape
`{"error": {"code", "message", "details"?}}`:

| Status | Codes |
|---|---|
| 401 | `authentication_failed`, `invalid_credentials`, `invalid_token` |
| 403 | `permission_denied` |
| 404 | `not_found` |
| 409 | `conflict` |
| 410 | `gone` (expired invitation) |
| 422 | `validation_error`, `invalid_input` |
| 429 | `rate_limited` |
| 500, 503 | `internal_error`, `service_unavailable` |

Example:

```sh
TOKEN=$(curl -s localhost:8000/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"…"}' | jq -r .access_token)
curl -s localhost:8000/v1/orgs -H "Authorization: Bearer $TOKEN"
```

## Layout

```
migrations/            Alembic environment and versions; the only owner of the schema
src/authz/
  api/                 routers, request/response schemas, dependencies (auth, require), error
                       handler, request middleware
  services/            use cases: auth, tokens, authorisation, organisations, members, roles,
                       projects, invitations, audit
  domain/              permissions and built-in roles, role-graph policy, principals, emails,
                       pagination cursors
  repositories/        SQLAlchemy queries, one module per aggregate
  models/              ORM mappings
  infra/               database, Redis, rate limiter, clock, argon2 hashing, randomness, mail
  config.py            settings from the environment, validated at startup
  errors.py            DomainError and its subclasses
  logging.py           structlog JSON logging with secret redaction
  container.py         builds every adapter and service from the settings
  app.py, main.py      FastAPI app and process entry point
  cli.py               admin commands
tests/                 pytest suites; tests/helpers has the clock, test doubles and factories
```

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | `postgres://…` or `postgresql://…` |
| `REDIS_URL` | required | `redis://…` |
| `JWT_SECRETS` | required | comma-separated, each at least 32 characters; the first signs |
| `ENVIRONMENT` | `development` | `development`, `test` or `production` (no API docs) |
| `HOST`, `PORT` | `0.0.0.0`, `8000` | listen address |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warning`, `error` |
| `DATABASE_POOL_SIZE` | `10` | |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | must be shorter than the refresh token TTL |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | 30 days, at most the session TTL |
| `SESSION_TTL_SECONDS` | `7776000` | 90 days; a session never outlives it |
| `JWT_ISSUER`, `JWT_LEEWAY_SECONDS` | `authz`, `5` | |
| `ARGON2_TIME_COST`, `ARGON2_MEMORY_COST_KIB`, `ARGON2_PARALLELISM` | `3`, `65536`, `4` | |
| `LOGIN_RATE_LIMIT`, `LOGIN_RATE_WINDOW_SECONDS` | `10`, `300` | per email and IP |
| `REFRESH_RATE_LIMIT`, `REFRESH_RATE_WINDOW_SECONDS` | `60`, `60` | per IP |
| `INVITATION_TTL_SECONDS` | `604800` | 7 days |
| `PUBLIC_BASE_URL` | `http://localhost:8000` | base of links in emails; https in production |
| `TRUST_PROXY_HEADERS` | `false` | take the client IP from `X-Forwarded-For` |
| `MAIL_BACKEND` | `log` | `log` (logs recipient and subject only) or `smtp` |
| `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_STARTTLS` | | SMTP delivery |

The service refuses to start, listing every problem, when a variable is missing or invalid. See
`.env.example`. Logs are JSON lines; values of keys such as `password`, `token`,
`refresh_token`, `authorization` or `*_secret` are replaced by `[redacted]`, and requests are
logged with their route template, never the raw path.

## Running

```sh
uv sync
export DATABASE_URL=postgres://authz:authz@localhost:5432/authz
export REDIS_URL=redis://localhost:6379/0
export JWT_SECRETS=$(openssl rand -hex 32)
uv run alembic upgrade head
uv run python -m authz.cli create-user --email ada@example.com --name "Ada Example"
uv run python -m authz.cli create-org --name "Example Org" --owner-email ada@example.com
uv run python -m authz.main
```

`create-user` prompts for the password (or reads one line with `--password-stdin`); both
commands print the created record as JSON. `uvicorn --factory authz.app:create_app_from_env`
serves the same app.

## Testing

The suites need a PostgreSQL database and a Redis logical database of their own:

```sh
export DATABASE_URL=postgres://authz:authz@localhost:5432/authz_test
export REDIS_URL=redis://localhost:6379/15
uv run --frozen pytest -q                          # whole suite
uv run --frozen pytest -q tests/api/test_auth.py   # one file
uv run --frozen mypy
uv run --frozen ruff check .
```

A session fixture applies the Alembic migrations to `DATABASE_URL` once; before each test that
uses the database every table is truncated and the Redis database is flushed (`FLUSHDB`), so
never point these variables at data you want to keep. The API tests drive the real app through
`httpx.AsyncClient` with `ASGITransport`. Time runs on a `FrozenClock` that tests move by hand
(token, session and invitation expiry, rate-limit windows, audit timestamps), random tokens come
from a seeded source, and emails go to a recording mailer. Fixtures live in `tests/conftest.py`
and helpers in `tests/helpers/`, so a test file in any directory under `tests/` can run on its
own.
