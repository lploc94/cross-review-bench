from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import insert

from etl.infra.tables import customers, products, runs
from etl.quality.checks import AcceptedValues, NotNull, Referential, RowCountDelta, Severity, Unique
from etl.quality.registry import CHECKS, checks_for, find_check
from etl.quality.runner import blocking_failures, run_checks

NOW = datetime(2026, 3, 1, tzinfo=UTC)


class History:
    def __init__(self, **previous: Decimal) -> None:
        self._previous = previous

    def previous_observed(self, check_name):
        return self._previous.get(check_name)


def add_customer(connection, customer_id, *, current=True, country="DE", valid_to=None):
    connection.execute(
        insert(customers).values(
            customer_id=customer_id,
            country=country,
            valid_from=NOW,
            valid_to=valid_to,
            is_current=current,
            updated_at=NOW,
            loaded_at=NOW,
            run_id=1,
        )
    )


def seed_run(connection):
    connection.execute(
        insert(runs).values(id=1, source="customers", path="-", status="running", started_at=NOW)
    )


def test_check_names_are_unique_and_tables_have_checks():
    names = [check.name for check in CHECKS]
    assert len(names) == len(set(names))
    assert find_check("orders.customer_id.references_customers") is not None
    assert {check.table.name for check in checks_for([customers])} == {"customers"}


def test_unique_with_a_filter_counts_duplicated_keys_among_current_rows(db):
    later = datetime(2026, 3, 2, tzinfo=UTC)
    check = Unique(customers, ("customer_id",), where=customers.c.is_current, label="u")
    with db.begin() as connection:
        seed_run(connection)
        add_customer(connection, "C-1", current=False, valid_to=later)
        add_customer(connection, "C-1")
        outcome = check.evaluate(connection, History())
        assert outcome.passed
        unfiltered = Unique(customers, ("customer_id",)).evaluate(connection, History())
        assert (unfiltered.passed, unfiltered.observed) == (False, Decimal(1))
        connection.rollback()


def test_not_null_accepted_values_and_referential_count_offending_rows(db):
    with db.begin() as connection:
        seed_run(connection)
        add_customer(connection, "C-1", country=None)
        add_customer(connection, "C-2", country="ZZ")
        add_customer(connection, "C-3", country="FR")

        not_null = NotNull(customers, "country").evaluate(connection, History())
        accepted = AcceptedValues(customers, "country", {"DE", "FR"}).evaluate(
            connection, History()
        )
        referential = Referential(customers, "customer_id", products, "product_id").evaluate(
            connection, History()
        )
        connection.rollback()

    assert (not_null.passed, not_null.details) == (False, "1 row with NULL country")
    # NULL is not an unexpected value; ZZ is
    assert (accepted.passed, accepted.observed) == (False, Decimal(1))
    assert (referential.passed, referential.observed) == (False, Decimal(3))


def test_row_count_delta_needs_a_non_empty_baseline(db):
    check = RowCountDelta(customers, Decimal("0.5"))
    with db.begin() as connection:
        seed_run(connection)
        for n in range(3):
            add_customer(connection, f"C-{n}")
        no_history = check.evaluate(connection, History())
        from_empty = check.evaluate(connection, History(**{check.name: Decimal(0)}))
        within = check.evaluate(connection, History(**{check.name: Decimal(2)}))
        beyond = check.evaluate(connection, History(**{check.name: Decimal(7)}))
        connection.rollback()

    assert no_history.passed
    assert from_empty.passed
    assert within.passed  # 50% exactly is within tolerance
    assert not beyond.passed


def test_only_failed_error_level_checks_block_the_commit(db):
    checks = [
        NotNull(customers, "country", Severity.WARN),
        NotNull(customers, "email", Severity.ERROR),
        NotNull(customers, "customer_id", Severity.ERROR),
    ]
    with db.begin() as connection:
        seed_run(connection)
        add_customer(connection, "C-1", country=None)
        results = run_checks(connection, checks, History())
        connection.rollback()

    assert [result.passed for result in results] == [False, False, True]
    assert blocking_failures(results) == ["customers.email.not_null"]
