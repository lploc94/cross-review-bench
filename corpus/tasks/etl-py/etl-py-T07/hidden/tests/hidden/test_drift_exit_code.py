"""SchemaDrift exits with the code the README documents for it, and with no other error's."""

from __future__ import annotations

import re

from etl.errors import EXIT_CODES, SchemaDrift, exit_code_for
from etl.pipeline.runner import Pipeline
from tests.helpers.db import ROOT
from tests.helpers.factories import product_row, write_products

ROW = re.compile(r"^\|\s*(\d+)\s*\|(.*)\|\s*$")


def documented_codes() -> list[tuple[int, str]]:
    """The rows of the README's exit code table: code and description."""
    table = []
    for line in (ROOT / "README.md").read_text(encoding="utf-8").splitlines():
        match = ROW.match(line)
        if match:
            table.append((int(match.group(1)), match.group(2)))
    return table


def documented_drift_code() -> int:
    (code,) = [code for code, text in documented_codes() if "SchemaDrift" in text]
    return code


def drift() -> SchemaDrift:
    return SchemaDrift("products", undeclared=["colour"])


def test_schema_drift_has_the_documented_code_of_its_own():
    documented = documented_drift_code()
    others = {code for klass, code in EXIT_CODES.items() if klass is not SchemaDrift}

    assert exit_code_for(drift()) == documented
    assert documented not in others
    assert [code for code, _ in documented_codes()].count(documented) == 1


def test_the_command_exits_with_the_documented_code(cli, monkeypatch, tmp_path):
    def refuse(self, source, path):
        error = drift()
        error.run_id = 1
        raise error

    monkeypatch.setattr(Pipeline, "run", refuse)

    result = cli("run", "products", write_products(tmp_path, [product_row()]))

    assert result.exit_code == documented_drift_code()
    assert "undeclared columns: colour" in result.stderr
