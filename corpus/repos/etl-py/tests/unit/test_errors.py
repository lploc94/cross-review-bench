from __future__ import annotations

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from etl.errors import (
    EXIT_CODES,
    EXIT_UNEXPECTED,
    ConfigError,
    EtlError,
    InvalidRequest,
    NotFound,
    QualityCheckFailed,
    RunLocked,
    RunNotFound,
    SchemaMismatch,
    SchemaNotCurrent,
    SourceFileNotFound,
    SourceFormatError,
    TooManyRejects,
    UnknownSource,
    WatermarkConflict,
    describe_error,
    exit_code_for,
)


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (InvalidRequest("x"), 2),
        (ConfigError(["x"]), 3),
        (UnknownSource("x", ["orders"]), 4),
        (RunNotFound(1), 4),
        (SourceFileNotFound("/x"), 4),
        (SourceFormatError("x"), 10),
        (SchemaMismatch("orders", missing=["a"]), 11),
        (TooManyRejects("orders", rejected=2, read=3, max_ratio=0.5), 12),
        (QualityCheckFailed(["c"]), 13),
        (WatermarkConflict("orders"), 14),
        (RunLocked("orders"), 15),
        (SchemaNotCurrent("0003", "0004"), 16),
        (EtlError("x"), 20),
        (ValueError("x"), EXIT_UNEXPECTED),
    ],
)
def test_each_error_class_has_its_exit_code(error, code):
    assert exit_code_for(error) == code


def test_exit_codes_are_distinct_per_class_family():
    families = {klass: code for klass, code in EXIT_CODES.items() if klass is not NotFound}
    assert len(set(families.values())) == len(families)
    assert 0 not in EXIT_CODES.values()


def test_database_errors_are_described_without_their_parameters(db):
    with pytest.raises(DBAPIError) as caught, db.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO etl.watermarks (source, high_water, updated_at) VALUES (:s, now(), :u)"
            ),
            {"s": "ada@example.com", "u": None},
        )

    assert isinstance(caught.value.orig, psycopg.Error)
    description = describe_error(caught.value)
    assert description.startswith("database error: null value in column")
    assert "ada@example.com" not in description
    assert describe_error(KeyError("ada@example.com")) == "internal error: KeyError"
