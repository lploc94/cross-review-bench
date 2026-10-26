from __future__ import annotations

from datetime import timedelta

import pytest

from etl.errors import UnknownSource
from etl.pipeline.datasets import DATASETS
from etl.sources.registry import SOURCES, CsvFormat, Dataset, SourceSpec, get_source


def test_unknown_sources_name_the_known_ones():
    with pytest.raises(UnknownSource, match="customers, orders, products"):
        get_source("invoices")


def test_every_source_is_bound_to_a_dataset_and_reads_its_zone():
    for spec in SOURCES.values():
        assert spec.dataset in DATASETS
        assert spec.required_columns
        assert spec.tz.key == spec.zone
        assert spec.lookback >= timedelta(0)


def test_specs_refuse_inconsistent_declarations():
    with pytest.raises(ValueError, match="unknown time zone"):
        SourceSpec("x", Dataset.ORDERS, CsvFormat(";", ","), ("a",), zone="Nowhere/Town")
    with pytest.raises(ValueError, match="lookback"):
        SourceSpec("x", Dataset.ORDERS, CsvFormat(";", ","), ("a",), lookback=timedelta(-1))
    with pytest.raises(ValueError, match="decimal separator"):
        CsvFormat(",", ",")
