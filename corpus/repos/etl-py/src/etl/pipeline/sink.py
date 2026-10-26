"""Collects a run's rejected rows and writes them to `etl.rejects` in batches.

Rejects are written in transactions of their own, apart from the load: they stay recorded when
the run fails and its warehouse writes are rolled back, which is when they matter most.
"""

from __future__ import annotations

import math
import re
from typing import Any

from sqlalchemy import Engine

from etl.infra.clock import Clock
from etl.store import rejects
from etl.store.rejects import Reject

# PostgreSQL text and jsonb cannot hold NUL characters, and UTF-8 cannot encode lone
# surrogates (JSON escapes such as "\ud800" produce them).
_UNSTORABLE = re.compile("[\x00\ud800-\udfff]")
_REPLACEMENT = "\ufffd"


def safe_payload(value: Any) -> Any:
    """`value` in a form jsonb accepts: NUL characters and lone surrogates in its strings (keys
    included) replaced, and non-finite floats (a JSON number too large for a float reads as
    infinity) written as text. A key the replacement changes into a name the object already
    has gets the first free suffix (`a\ufffd#2`, `a\ufffd#3`, ...); keys that needed no
    replacement keep their names, so no value is lost."""
    if isinstance(value, str):
        return _UNSTORABLE.sub(_REPLACEMENT, value)
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        names = {key: safe_payload(key) for key in value}
        # Names no replacement touched stay as they are; changed ones take what is left.
        taken = {key for key, name in names.items() if name == key}
        safe: dict[Any, Any] = {}
        for key, item in value.items():
            name = names[key]
            if name != key:
                name = _unused_key(name, taken)
                taken.add(name)
            safe[name] = safe_payload(item)
        return safe
    if isinstance(value, list | tuple):
        return [safe_payload(item) for item in value]
    return value


def _unused_key(name: Any, taken: set[Any]) -> Any:
    if name not in taken:
        return name
    number = 2
    while f"{name}#{number}" in taken:
        number += 1
    return f"{name}#{number}"


class RejectSink:
    def __init__(
        self,
        engine: Engine,
        *,
        run_id: int,
        source: str,
        clock: Clock,
        flush_every: int = 500,
    ) -> None:
        self._engine = engine
        self._run_id = run_id
        self._source = source
        self._clock = clock
        self._flush_every = max(1, flush_every)
        self._pending: list[Reject] = []
        self._count = 0

    @property
    def count(self) -> int:
        """Rejects added so far, written or not."""
        return self._count

    def add(self, line_no: int, reason: str, column: str | None, payload: Any) -> None:
        self._pending.append(Reject(line_no, safe_payload(reason), column, safe_payload(payload)))
        self._count += 1
        if len(self._pending) >= self._flush_every:
            self.flush()

    def flush(self) -> None:
        if not self._pending:
            return
        with self._engine.begin() as connection:
            rejects.insert_many(
                connection,
                run_id=self._run_id,
                source=self._source,
                items=self._pending,
                created_at=self._clock.now(),
            )
        self._pending.clear()
