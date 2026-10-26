# etl

A batch ETL service for a retailer's warehouse. It reads export files from three source
systems (shop orders, CRM customers, the product catalogue), normalises and deduplicates their
rows, and loads them into PostgreSQL incrementally: one run per file, all-or-nothing, with
rejected rows recorded, data-quality checks after every load, and daily sales and customer
reports.

Built with Python 3.13, Typer, SQLAlchemy 2 Core (sync, psycopg 3), Alembic, PostgreSQL,
pydantic-settings and structlog; managed with uv.

## Concepts

**Sources.** Declared in code in `src/etl/sources/registry.py`. Each names its file format, the
columns its exports must have, the IANA zone of its naive timestamps, how ambiguous local times
are read, and the lookback of its incremental window:

| Source | Format | Timestamps | Lookback |
|---|---|---|---|
| `orders` | CSV, `;` delimiter, decimal comma; one row per order line | `DD.MM.YYYY HH:MM[:SS]`, Europe/Berlin, ambiguous times read as the earlier one | 6 h |
| `customers` | JSON Lines, UTF-8 | ISO 8601, UTC when no offset is given | 1 h |
| `products` | CSV, `,` delimiter, `.` decimals, UTF-8 with or without a BOM | ISO 8601, UTC when no offset is given | 1 h |

Any file may be gzip-compressed (recognised by its content, not its name). Readers stream the
file and number its lines. A header that lacks a required column or names one twice fails the
run (`SchemaMismatch`); columns the source does not declare are ignored.

**Normalisation.** Money is a `Decimal` with an ISO 4217 currency and never has more decimals
than the currency's minor unit (12.345 EUR or 100.5 JPY is refused, not rounded). Timestamps
become UTC `timestamptz`: a local time in a DST gap (02:30 on the spring-forward night in
Berlin) is refused, a time in a fold (02:30 on the fall-back night) is resolved by the source's
policy (`earlier`, `later` or `reject`). Emails are trimmed and lower-cased, phone numbers become
`+` and digits (a trunk prefix written `(0)` right after the country code is dropped, kept as 0
for Italy; a `(0)` anywhere else refuses the number, and so the row), country codes are
upper-case ISO 3166 alpha-2, and empty strings become NULL where the column is nullable.

**Rejects.** A row that cannot be parsed or normalised, or whose `updated_at` lies more than
`MAX_FUTURE_SKEW_SECONDS` in the future, is written to `etl.rejects` with its line number,
column, reason and raw values, and the run goes on (an orders line that cannot be split
into its fields, or whose `order_id` cannot be read, also fails the run, see Deduplication and
loading). Order lines rejected along with another line of their version or order keep only
`{order_id, position}`. Stored payloads are made safe for `jsonb`: NUL characters and lone
surrogates become U+FFFD, non-finite numbers (infinity, NaN) are written as text, and
keys that become equal get a suffix (`#2`, `#3`, ...) so no value is lost. When rejected rows exceed
`MAX_REJECT_RATIO` of the rows read, the run fails (`TooManyRejects`). Rejects are written in
their own transactions, so they stay recorded when the run fails.

**Incremental loads.** `etl.watermarks` keeps, per source, the newest `updated_at` loaded so
far. A run takes the rows with `updated_at > watermark - lookback` and skips the others; the
lookback picks up rows that reach an export late. The watermark moves forward to the newest row
staged by the run, in the run's own transaction, and never backwards.

**Deduplication and loading.** Rows are staged in a temporary table per run. Within the batch,
the row with the greatest `updated_at` wins for each natural key, a tie going to the row further
down the file. Across runs, `INSERT … ON CONFLICT … DO UPDATE … WHERE` replaces a stored row
only when the incoming one is strictly newer, so a late or re-read old row never overwrites
newer data.

- `warehouse.products`: one row per SKU (type 1).
- `warehouse.customers`: type 2. A newer row that changes an attribute closes the current
  version (`valid_to`) and opens a new one (`valid_from`, `is_current`) at its `updated_at`.
- `warehouse.orders` and `warehouse.order_lines`: the lines of one order version share its
  `updated_at`; the newest version replaces the stored order and all of its lines. A version
  is loaded whole or not at all: lines that disagree on the order's own columns are rejected
  together. When a line is rejected and its `order_id` and `updated_at` can still be read, the
  other lines of that version are rejected too ("another line of this order version was
  rejected"). When a rejected line's `order_id` can be read but its `updated_at` cannot, every
  line of that order the run would load is rejected ("another line of this order was rejected
  and its version is unknown"); lines at or before the window's cutoff are skipped as usual.
  A rejected line whose `order_id` cannot be read (empty, too long, a NUL character) fails
  the run (`SourceFormatError`, "line N: an order line has no readable order_id"), after its
  reject is recorded.
  An orders line the reader cannot split into its fields (the wrong number of fields) fails
  the run (`SourceFormatError`, "line N: an order line could not be split into its fields"),
  after its reject is recorded: a stray or missing delimiter can fall inside the `order_id` or
  next to it, so the line may belong to any order version, and loading the others could
  replace a stored order with a part of it. In each case the stored order stays as it was.
  These rejects count in the run's rejected rows. Orders reference
  `customers.customer_key` and lines `products.product_key` when the dimension row exists.

**Runs.** `etl.runs` records each run (`running`, `succeeded` or `failed`, row counts, error).
A PostgreSQL advisory lock per source stops two runs of one source at once (`RunLocked`); a
run left `running` by a process that died is marked failed by the next run. Everything a run
writes to the warehouse, the watermark and its check results commit together or not at all.

**Quality checks.** Declared per table in `src/etl/quality/registry.py`: not-null, unique,
accepted values, referential (every order's customer exists) and row-count delta against the
previous successful run. They run inside the load transaction; a failing `error` check fails
the run and rolls the load back, a failing `warn` check is recorded. Results land in
`etl.check_results`, failed runs included. Check details name columns and counts, never values.

**Reports.** Days are calendar days in `REPORTING_ZONE`, so an order placed at 23:30 UTC in
summer belongs to the next day in Berlin, and the day of a DST change has 23 or 25 hours.

- `daily-sales`: per day, country and currency, the number of orders and their revenue
  (cancelled orders are left out; currencies are never added together).
- `customers`: current customers per country, as of now or the end of a given day.

Each report prints a table (or JSON) and writes a CSV file to `REPORT_DIR`.

## CLI

```
etl run <source> <path> [--json]             load one export file
etl status [--source S] [--json]             per source: running?, watermark, latest runs
etl runs list [--source S] [--status S] [--limit N] [--json]
etl runs show <run-id> [--json]              counts, check results, reject reasons
etl rejects list <run-id> [--reason R] [--after LINE] [--limit N] [--json]
etl rejects prune --before D [--source S] [--yes]
etl checks list [--source S] [--json]        declared checks and their last results
etl checks run [--source S] [--json]         evaluate the checks now, record nothing
etl report daily-sales [--from D] [--to D] [--json]
etl report customers [--as-of D] [--json]
etl watermark list [--json]
etl watermark show <source> [--json]
etl watermark reset <source> [--to INSTANT] [--yes]
etl sources list [--json]
etl sources show <source> [--json]           how the source's files are read
etl db check [--config alembic.ini] [--json] reachable, schema revision against the code
etl db upgrade [--config alembic.ini]        apply missing migrations
etl settings [--json]                        effective configuration, password masked
```

`python -m etl` is the same command. `watermark reset` without `--to` removes the watermark, so
the next run reads every row; it takes the source's run lock first. `rejects list` shows line,
column and reason, never the rejected values; `rejects prune` deletes rejects recorded before
the start of a day in `REPORTING_ZONE` (never today's), since they keep raw rows with personal
data. `checks run` evaluates in a read-only transaction and exits 13 when an error-level check
fails. Exit codes:

| Code | Error |
|---|---|
| 0 | success |
| 1 | unexpected error |
| 2 | invalid request (bad date, bad option value) |
| 3 | invalid configuration |
| 4 | not found (source, run or file) |
| 10 | `SourceFormatError`: unreadable file, or an orders line that cannot be split into its fields or has no readable `order_id` |
| 11 | `SchemaMismatch`: required columns missing |
| 12 | `TooManyRejects` |
| 13 | `QualityCheckFailed` |
| 14 | `WatermarkConflict`: the watermark changed during the run |
| 15 | `RunLocked`: another run of the source is in progress |
| 16 | `SchemaNotCurrent`: the database schema is behind the code (`db check`) |
| 20 | other `EtlError` |

The mapping lives in `src/etl/errors.py` (`EXIT_CODES`).

## Layout

```
migrations/            Alembic environment and versions; the only owner of the schema
src/etl/
  cli/                 Typer commands: arguments and output only
  api/                 the operations the commands call (runs, rejects, checks, reports,
                       watermarks, sources, database); builds the context from the settings
  pipeline/            one run: lock, window, extract, stage, merge, checks, watermark
  sources/             source registry, CSV and JSON Lines readers
  transform/           field parsing, normalisers per dataset, in-batch dedup queries
  load/                staging tables and the newer-wins merges per dataset
  quality/             check types, the declared checks, the check runner
  store/               etl schema: runs, watermarks, rejects, check results
  reports/             daily sales, customer counts, CSV writer
  domain/              money and currencies, timestamps and DST, contact data, records
  schemas/             pydantic models of command output and reports
  infra/               table definitions, database engine, migration state, advisory locks,
                       clock, files
  config.py            settings from the environment, validated at startup
  errors.py            EtlError and its subclasses, exit codes
  logging.py           structlog JSON logging with personal-data redaction
tests/                 pytest suites; tests/helpers has the clock, file builders, factories
                       and database helpers
```

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | `postgres://…` or `postgresql://…` |
| `DATABASE_POOL_SIZE` | `5` | 3–50; a run holds three connections |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warning`, `error` |
| `REPORT_DIR` | `reports` | where report CSV files are written |
| `REPORTING_ZONE` | `UTC` | IANA zone of report days |
| `MAX_REJECT_RATIO` | `0.05` | 0–1; a run fails above it |
| `BATCH_SIZE` | `1000` | rows per staging insert and per reject write |
| `MAX_FUTURE_SKEW_SECONDS` | `300` | rows further in the future are rejected |

The command refuses to start, listing every problem, when a variable is missing or invalid.
See `.env.example`. Logs are JSON lines on stderr; values of keys such as `email`, `full_name`,
`phone`, `payload`, `row` or `database_url` are replaced by `[redacted]` at any depth.

## Running

```sh
uv sync
export DATABASE_URL=postgres://etl:etl@localhost:5432/warehouse
export REPORTING_ZONE=Europe/Berlin
uv run etl db upgrade          # or: uv run alembic upgrade head
uv run etl run products exports/products.csv
uv run etl run customers exports/customers.jsonl.gz
uv run etl run orders exports/orders.csv
uv run etl runs list
uv run etl report daily-sales --from 2026-03-01 --to 2026-03-31
```

Load dimensions before orders: orders reference the customers and products already loaded.

## Testing

The suites need a PostgreSQL database of their own:

```sh
export DATABASE_URL=postgres://etl:etl@localhost:5432/etl_test
uv run --frozen pytest -q                                     # whole suite
uv run --frozen pytest -q tests/pipeline/test_watermarks.py   # one file
uv run --frozen mypy
uv run --frozen ruff check .
```

A session fixture applies the Alembic migrations to `DATABASE_URL` once; before each test that
uses the database every table is truncated, so never point it at data you want to keep. Source
files are written into `tmp_path` by small builders (`write_csv`, `write_jsonl` and their gzip
variants); the CLI tests drive the real Typer app through `CliRunner`. Time runs on a
`FrozenClock` that tests move by hand (run timestamps, watermarks, future-skew limits, report
windows). Fixtures live in `tests/conftest.py` and helpers in `tests/helpers/`, so a test file
in any directory under `tests/` can run on its own.
