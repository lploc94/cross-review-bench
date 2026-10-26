# Workflow

Document approval service for a small finance and legal team. A document is drafted by its owner,
submitted against a published workflow definition, and then moves through the definition's steps:
each step names one approver, an any-of or all-of group, or a quorum of a group. Every approver has
a working-time SLA; overdue tasks are escalated once. Every change writes an audit row and a
notification in the same transaction. Written in Java 21 with Spring Boot 3, Spring Data JPA,
Flyway and PostgreSQL.

## Concepts

- **Users and groups.** Users sign in with an API token, shown once when it is issued. Only the
  SHA-256 of the secret is stored, and a token can be revoked. Groups hold members and can be used
  as a step's approvers.
- **Definitions.** A definition has a name, a version and steps. A draft takes steps; publishing
  freezes it. Each document keeps the version it started with. Parallel steps share a step order.
  A draft is read on the admin routes only; signed-in users see published versions, and a draft
  is a 404 on their routes, as it is on the list.
- **Steps.** `SINGLE` names one approver. `ANY_OF` completes on the first decision by a member:
  an approval approves the step, a rejection rejects it. `ALL_OF` needs every member to approve.
  `QUORUM` needs a number of members to approve and rejects once that number can no longer be
  reached. The remaining open tasks of a decided step are cancelled.
- **Documents.** Statuses are `DRAFT`, `IN_REVIEW`, `APPROVED`, `REJECTED` and `WITHDRAWN`. The
  owner submits a draft, withdraws a document under review, and resubmits a rejected one, which
  starts a new round. Earlier rounds and their decisions stay on record.
- **Tasks.** One task per approver of the current step order. A task is due at its activation plus
  the step's SLA, counted in working hours (Monday to Friday, 09:00 to 17:00 in the configured zone).
  A decision on a task that is no longer open is a conflict. A decision that would move the
  document to a step with no active approver is refused with 400 and rolled back: the task and the
  document keep their state, and no notification is written. An overdue task is escalated once,
  and a decision made while the escalation runs is kept; the escalation timestamp is written
  without touching the decision's version.
- **Permissions.** A user sees a document as its owner, as an approver of one of its tasks (current
  or past), or as someone the owner granted `VIEW` or `COMMENT`. Admins see everything. Lists and
  counts apply the same rule, so titles of documents a user cannot see never appear. A document
  the caller may not see is a 404 on every route, including the task and decision routes; a 403 is
  only for a document the caller can see but may not change.
- **Notifications.** Each event is written to an outbox with an idempotency key and the recipient's
  account id; the address it was sent to is kept for delivery. A user's notifications follow the
  account, so changing an address keeps them. Dispatch is at-least-once; a redelivered event
  carries the same key. Email addresses are unique across accounts, compared without case, so a
  second account cannot take an address in use (409).
- **Errors.** Every error is an RFC 9457 problem detail with a `urn:workflow:problem:<slug>` type. A
  document the caller may not see is reported as not found. A request with an encoded, `;`, `\`,
  `//` or dot-segment path is refused with 400 `ambiguous-path` before authentication. Tomcat
  refuses some targets before the application runs, with its own 400: a backslash in the target
  and non-ASCII characters in it. Those answers come from the container, not from this API. A wrong
  request type is 415 and a response type the API cannot give is 406. An unexpected failure is a
  generic 500 `unexpected`; its message and stack stay in the log.

## Running

Requirements: JDK 21, Maven 3.9+, PostgreSQL 14+.

Configuration comes from the environment:

| Variable | Meaning |
|----------|---------|
| `DATABASE_URL` | libpq-style URL, for example `postgres://workflow:secret@localhost:5432/workflow`. Converted to the JDBC URL at startup; the port defaults to 5432. |
| `ADMIN_TOKEN` | Bearer token for the `/api/v1/admin/*` routes, at least 16 characters. The application will not start without it. |

Start the service:

```bash
export DATABASE_URL=postgres://workflow:secret@localhost:5432/workflow
export ADMIN_TOKEN=change-me-to-a-long-random-value
mvn spring-boot:run
```

Flyway migrates the schema on startup. Create a user, issue a token and publish a definition:

```bash
curl -s -X POST localhost:8080/api/v1/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"displayName":"Tomas Vale","email":"tomas@example.com","admin":false}'

curl -s -X POST localhost:8080/api/v1/admin/users/1/tokens -H "Authorization: Bearer $ADMIN_TOKEN"

curl -s -X POST localhost:8080/api/v1/admin/definitions \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Expenses","steps":[{"order":1,"kind":"SINGLE","assigneeId":1,"slaMinutes":480}]}'

curl -s -X POST localhost:8080/api/v1/admin/definitions/1/publish -H "Authorization: Bearer $ADMIN_TOKEN"
```

Other settings sit under `workflow.*` in `src/main/resources/application.yml`:
`business-zone`, `working-start`, `working-end`, `outbox-batch-size`, `outbox-max-attempts`,
`outbox-retry-base`, `escalation-batch-size`, `job-interval` and `scheduling-enabled`. Invalid
values fail the startup.

## Testing

The tests run against a real PostgreSQL database named by `DATABASE_URL`; there is no embedded
database. Integration tests share one Spring context and start each test from an empty schema.

```bash
export DATABASE_URL=postgres://workflow:secret@localhost:5432/workflow_test
mvn test
mvn test -Dtest=ApprovalConcurrencyTest   # one class
mvn spotless:check                         # formatting (google-java-format, GOOGLE style)
```

Unit tests (business calendar, step rules, the state machine, entities) need no database. Races
between approvers use two transactions and latches, so they do not depend on timing. Time comes
from a mutable test clock; the background jobs are switched off in tests and called directly.

## Layout

```
src/main/java/com/papertrail/workflow/
  api/          controllers, request DTOs, filters, problem-detail mapping
  domain/       entities, state machine, step rules, business calendar, exceptions
  service/      use cases and transactions; read models (Views)
  persistence/  Spring Data repositories, keyset and permission-filtered queries
  integration/  notifier interface, outbox dispatcher, scheduled jobs
  config/       typed configuration, datasource conversion, filter and scheduling wiring
src/main/resources/db/migration/   Flyway migrations
src/test/java/com/papertrail/workflow/  unit tests and integration tests, plus support (clock,
                                        notifier, base class, test data builder)
```

## API

Every route is under `/api/v1`. Admin routes (`/api/v1/admin/...`) take `Authorization: Bearer <ADMIN_TOKEN>`;
all other routes take a user's token. A missing or wrong token gets 401 with `WWW-Authenticate: Bearer`.
Lists are keyset-paged: pass `cursor` (the last id of the previous page) and `size` (1 to 100, default 20);
the response is `{"items": [...], "nextCursor": ...}`, and `nextCursor` is null on the last page.

### Documents and tasks (user)

| Method and path | Purpose |
|-----------------|---------|
| `POST /documents` | create a draft (201, `Location`) |
| `GET /documents?status=&owner=&definition=&shared=&cursor=&size=` | visible documents, newest first; `shared=true` keeps only those granted to the caller |
| `GET /documents/count?status=&owner=&definition=` | visible documents, counted |
| `GET /documents/summary` | the caller's visible documents per status |
| `GET /documents/{id}` | one document with its tasks |
| `PUT /documents/{id}` | edit a draft (owner) |
| `POST /documents/{id}/submit`, `/resubmit`, `/withdraw` | lifecycle moves (owner) |
| `GET /documents/{id}/audit?cursor=&size=` | the document's audit trail, oldest first |
| `GET /documents/{id}/rounds` | the tasks grouped by round, so earlier decisions stay visible |
| `GET /documents/{id}/access` | the owner, the approvers and the explicit grants |
| `GET /documents/{id}/permissions` | the explicit grants (anyone who can see the document) |
| `PUT /documents/{id}/permissions/{userId}`, `DELETE /documents/{id}/permissions/{userId}` | grant or change, and revoke (owner or admin) |
| `GET /tasks/mine`, `GET /tasks/mine/count` | my open tasks, most urgent first, and how many |
| `GET /tasks/decided?cursor=&size=` | tasks I decided (approved or rejected), and only those |
| `GET /tasks/{id}` | one task (its assignee, or anyone who can see its document) |
| `POST /tasks/{id}/decision` | approve or reject, with an optional comment |
| `GET /definitions?name=`, `GET /definitions/{id}` | published definitions |
| `GET /users/me`, `GET /users/me/tokens`, `POST /users/me/tokens/revoke` | my profile, my token prefixes, sign out everywhere |
| `GET /notifications/mine?cursor=&size=` | notifications addressed to my account: event, status and times, never the payload or address |
| `GET /calendar/working-hours`, `GET /calendar/due?from=&minutes=` | the business calendar, and the due time of a working-time allowance |

### Administration (admin token)

| Method and path | Purpose |
|-----------------|---------|
| `POST /admin/users` (201), `GET /admin/users?active=`, `GET /admin/users/{id}` | create and read users |
| `PATCH /admin/users/{id}` | change `displayName`, `email` and/or `active`; deactivating revokes all the user's tokens |
| `GET /admin/users/{id}/tokens`, `POST /admin/users/{id}/tokens` (201), `POST /admin/users/{id}/tokens/revoke` | token prefixes, issue a token (shown once), revoke all |
| `POST /admin/tokens/{prefix}/revoke` | revoke one token |
| `POST /admin/groups` (201), `GET /admin/groups`, `GET /admin/groups/{id}` | groups and their members |
| `PATCH /admin/groups/{id}`, `DELETE /admin/groups/{id}` | rename; delete unless a step still uses the group (409) |
| `PUT`, `DELETE /admin/groups/{id}/members/{userId}` | membership |
| `POST /admin/definitions` (201), `GET /admin/definitions?name=`, `GET /admin/definitions/{id}` | create a draft, list every version, read one |
| `POST /admin/definitions/{id}/steps`, `PUT`, `DELETE /admin/definitions/{id}/steps/{stepId}` | add, replace and remove steps of a draft (409 once published) |
| `DELETE /admin/definitions/{id}` | discard a draft (409 once published) |
| `POST /admin/definitions/{id}/publish` | publish a draft |
| `POST /admin/definitions/{id}/revise` (201) | start the next version of a published definition as a draft with the same steps |
| `GET /admin/outbox?status=&cursor=&size=`, `GET /admin/outbox/{id}` | notification rows for operators (recipient and payload left out) |
| `POST /admin/outbox/{id}/requeue`, `POST /admin/outbox/requeue-failed` | put a given-up event back in line; a pending event is refused (409) |
| `DELETE /admin/outbox/{id}` | discard a given-up event (409 unless it failed) |
| `GET /admin/tasks/overdue?cursor=&size=`, `GET /admin/users/{id}/tasks` | open tasks past their due time; one person's open tasks (404 for an unknown user) |
| `GET /admin/audit?cursor=&size=` | the audit trail of every document |
| `GET /admin/summary` | counts of users, documents per status, open and overdue tasks, outbox per status |
| `POST /admin/jobs/run` | run one escalation pass and one dispatch pass now |

Problems follow RFC 9457: `type` is `urn:workflow:problem:<slug>`, and a document the caller may not see is
reported as not found. The slugs a client can meet are `invalid-request`, `malformed-request`,
`validation-failed`, `not-found`, `no-such-route`, `forbidden`, `invalid-transition`, `conflict`,
`concurrent-update`, `unauthorized`, `ambiguous-path`, `method-not-allowed`, `unsupported-media-type`,
`not-acceptable` and `unexpected`.

## Operator rules

- A draft is the only definition that can change; a published one is refused with 409 when steps are added,
  replaced or removed, or when it is discarded. Revising it creates the next version and leaves the old one alone.
- Deactivating a user revokes their tokens. Reactivating does not restore them, so the user is issued a new one.
- An address is one account's: creating or changing a user to an address in use is a 409. Change the
  other account first, or keep the address on one account.
- Drafts are for admins until published. Users cannot read a draft by id, and a draft created on the
  admin route is read from `Location`, which is the admin path.
- A group that a step assigns to cannot be deleted, and a group cannot take the name of another group.
- A given-up outbox event is requeued or discarded only once it has failed; a requeue takes the row lock,
  so two operators requeuing the same event apply it once.
