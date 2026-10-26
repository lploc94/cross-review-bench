# Innkeep booking

Reservation service for a small chain of guest houses. Each property has its own time zone, check-in
and check-out times, currency and refund policy; room types hold nightly inventory, and guests book
rooms through short-lived holds that become reservations when paid. Written in Java 21 with Spring
Boot 3, Spring Data JPA, Flyway and PostgreSQL.

## Concepts

- **Properties and room types.** A property has an IANA time zone, check-in and check-out times, an
  ISO 4217 currency (at most two minor units, since money is stored to cents) and a policy (full
  refund days, partial refund percent, weekend surcharge, length-of-stay rule). A room type has a
  capacity, a base nightly rate and an extra-guest fee.
- **Inventory.** One row per room type and night (local date of the property) with `total`, `held`
  and `booked`. Availability is `total - held - booked`. Inventory writes take
  their nights in ascending date order, the order holds use, so the two cannot deadlock.
- **Holds.** A guest holds rooms for a stay for a time limit (default 15 minutes). Creating a hold
  takes every night in ascending order with a conditional update, so a stay gets all its nights or
  none. Confirming turns the hold into a reservation; an expired hold is refused even before the
  cleanup job has run. A hold cannot start before today in the property's time zone, and it
  cannot be confirmed once its check-in day has passed there (410 `hold-expired`); it is left to
  expire. Every change to a hold locks that hold's row and no other row: the property and room type
  rows are not locked, so other holds, releases and reprices go ahead while a confirmation is
  charging. A confirmation may wait for its own hold lock. A release or expiry as a whole is bounded
  by `booking.lock-timeout` (default `PT3S`, 1 ms to 30 s): each hold row and each inventory row it
  takes is waited for at most that long. So a release can answer 503 `busy` (see Errors) while an
  admin write holds an inventory row. The expiry sweep skips a hold it cannot lock and pages past
  it, so the other due holds still expire; the skipped hold is found again by the next run.
- **Pricing.** The rules run in a fixed order, and the price lines are stored with the reservation so
  later rule changes do not alter it: nightly rate (seasonal rate, else base), weekend surcharge on
  Friday and Saturday nights by property-local date, length-of-stay discount, extra-guest fee. Money
  is rounded with HALF_EVEN to the currency's minor units.
- **Reservations.** Status moves `CONFIRMED` to `CHECKED_IN` (on or after the check-in date, before
  check-out) to `COMPLETED`, or to `CANCELLED`. A cancellation made at or before the full-refund
  deadline is refunded in full; later ones follow the property policy. Cancelling twice is a
  conflict, never a second refund. Charges and refunds are recorded in a ledger with idempotency
  keys.
- **Errors.** Every error the API raises is an RFC 9457 problem detail with a
  `urn:innkeep:problem:<slug>` type. A lock that cannot be taken in time, or a deadlock, is a 503
  with type `urn:innkeep:problem:busy` and `Retry-After: 1`: send the same request again. An
  unexpected failure is a 500 with type `urn:innkeep:problem:internal-error` and a generic detail.
  The framework's own 406 and 415 responses keep their status and carry type `about:blank`.
- **Logs.** Each request is logged with its route template
  (`/api/v1/reservations/{reference}`), never its raw path. Service and payment logs name internal
  ids and amounts only: hold ids and reservation references work as credentials, so neither is
  logged. Hibernate's own SQL error logging is off, since its messages print the database detail,
  which names key values; the app logs the exception class and the SQLState instead.

## Running

Requirements: JDK 21, Maven 3.9+, PostgreSQL 14+.

Configuration comes from the environment:

| Variable | Meaning |
|----------|---------|
| `DATABASE_URL` | libpq-style URL, for example `postgres://booking:secret@localhost:5432/booking`. Converted to the JDBC URL at startup; the port defaults to 5432. |
| `ADMIN_TOKEN` | Bearer token for the `/api/v1/admin/*` routes. The application will not start without it. |

Start the service:

```bash
export DATABASE_URL=postgres://booking:secret@localhost:5432/booking
export ADMIN_TOKEN=change-me
mvn spring-boot:run
```

Flyway migrates the schema on startup. Try it:

```bash
curl -s localhost:8080/api/v1/properties
curl -s -X POST localhost:8080/api/v1/admin/properties \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"code":"harbour-house","name":"Harbour House","timeZone":"Europe/Lisbon",
       "checkInTime":"15:00","checkOutTime":"11:00","currency":"EUR",
       "policy":{"fullRefundDays":7,"partialRefundPercent":50,"weekendSurchargePercent":10,
                 "losMinNights":3,"losDiscountPercent":5}}'
```

Other settings sit under `booking.*` in `src/main/resources/application.yml`: `hold-ttl`,
`hold-cleanup-interval`, `hold-cleanup-batch-size`, `max-rooms-per-booking`, `max-nights-per-stay`,
`max-retry-attempts` and `scheduling-enabled`. Invalid values fail the startup.

## Testing

The tests run against a real PostgreSQL database named by `DATABASE_URL`; there is no embedded
database. Each integration test starts from an empty schema.

```bash
export DATABASE_URL=postgres://booking:secret@localhost:5432/booking_test
mvn test
mvn test -Dtest=HoldServiceTest      # one class
mvn spotless:check                    # formatting (google-java-format, GOOGLE style)
```

Unit tests (pricing, policies, date ranges, money) need no database. Concurrency tests force the
interleavings with latches and two transactions, so they do not depend on timing. Time comes from a
mutable test clock, and scheduled jobs are switched off in tests and called directly.

## Layout

```
src/main/java/com/innkeep/booking/
  api/          controllers, DTO records, filters, problem-detail mapping
  domain/       entities, value objects, pricing, cancellation policy, exceptions
  service/      use cases and transactions
  persistence/  Spring Data repositories and their queries
  config/       typed configuration, datasource conversion, filters and security wiring
src/main/resources/db/migration/   Flyway migrations
src/test/java/com/innkeep/booking/  tests, grouped as api, config, persistence, service, unit
                                    and support (test clock, fixtures, base class)
```

## API

| Method and path | Access | Purpose |
|-----------------|--------|---------|
| `GET /api/v1/properties` | public | list properties |
| `GET /api/v1/properties/{code}` | public | one property |
| `GET /api/v1/properties/{code}/room-types` | public | room types of a property |
| `GET /api/v1/properties/{code}/room-types/{roomType}` | public | one room type |
| `GET /api/v1/properties/{code}/room-types/{roomType}/calendar` | public | night by night: rooms free, nightly price |
| `GET /api/v1/properties/{code}/availability` | public | room types with enough rooms, minimum availability and quoted total |
| `GET /api/v1/properties/{code}/occupancy` | public | rooms held and booked per night |
| `POST /api/v1/properties/{code}/quotes` | public | per-night price breakdown |
| `POST /api/v1/properties/{code}/holds` | public | create a hold (201, `Location`) |
| `GET /api/v1/holds/{id}`, `POST /api/v1/holds/{id}/release`, `POST /api/v1/holds/{id}/confirm` | public | hold lifecycle |
| `GET /api/v1/reservations/{reference}` | public | one reservation with its price lines |
| `GET /api/v1/reservations/{reference}/cancellation-quote` | public | refund a cancellation would get |
| `POST /api/v1/reservations/{reference}/cancel` | public | cancel and refund |
| `GET /api/v1/admin/reservations` | admin | paged list with filters (property, status, dates, guest email, guest name) |
| `POST /api/v1/admin/reservations/{reference}/check-in` | admin | check a guest in |
| `GET /api/v1/admin/reservations/{reference}/ledger` | admin | charges and refunds |
| `GET /api/v1/admin/reservations/summary` | admin | reservations per status |
| `GET /api/v1/admin/properties/{code}/arrivals`, `.../departures`, `.../in-house` | admin | a day's guests (`date`) |
| `GET /api/v1/admin/properties/{code}/revenue` | admin | charged, refunded and net money for a period |
| `POST /api/v1/admin/properties`, `PUT /api/v1/admin/properties/{code}`, `PUT .../policy` | admin | create a property, change its details or policy |
| `POST .../room-types`, `PUT .../room-types/{roomType}/rates` | admin | add a room type, change its rates |
| `POST/GET/PUT/DELETE .../room-types/{roomType}/seasonal-rates[/{id}]` | admin | seasonal rates (same priority may not overlap) |
| `GET/PUT .../room-types/{roomType}/inventory`, `PUT .../inventory/range` | admin | inventory per night and for a range |
| `GET /api/v1/admin/holds`, `GET /api/v1/admin/holds/summary`, `POST /api/v1/admin/holds/{id}/expire` | admin | hold list, counts, manual expiry |
| `POST /api/v1/admin/maintenance/run` | admin | expire holds and complete stays now |

The admin routes need `Authorization: Bearer <ADMIN_TOKEN>`. Without it they answer 401 with
`WWW-Authenticate: Bearer`. The guest-facing reservation routes are addressed by the booking
reference; the reference is the only credential they check.

Actuator exposes `/actuator/health`, which includes the database.
