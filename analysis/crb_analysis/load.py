"""Read results/scores.jsonl into one table per track.

Track A rows are runs; a system is one reviewer at one config (``codex-high``). Real-bug tasks
(``kind == "realbug"``) are kept apart from the synthetic corpus everywhere.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

SEED = 20261017
SEVERITY_WEIGHT = {"critical": 4, "high": 3, "medium": 2, "low": 1}
DIFFICULTIES = ["L1", "L2", "L3", "L4"]
SEVERITIES = ["critical", "high", "medium", "low"]


@dataclass
class Scores:
    a: pd.DataFrame  # Track A runs
    b: pd.DataFrame  # Track B second rounds
    c: pd.DataFrame  # Track C loops


def read_scores(path: str | Path) -> Scores:
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    by_track = {t: [r for r in rows if r.get("track") == t] for t in "ABC"}
    a = pd.DataFrame(by_track["A"])
    if not a.empty:
        a["system"] = a["reviewer"] + "-" + a["config"]
        a["synthetic"] = a["kind"] != "realbug"
    b = pd.DataFrame(by_track["B"])
    if not b.empty:
        b["system"] = b["reviewer"] + "-" + b["config"]
    c = pd.DataFrame(by_track["C"])
    return Scores(a=a, b=b, c=c)


def system_order(systems) -> list[str]:
    """Systems in a fixed order: reviewer codex, claude, agy; config high before max. Unknown ones last."""
    rev = {"codex": 0, "claude": 1, "agy": 2}
    cfg = {"high": 0, "max": 1}

    def key(s: str):
        r, _, c = s.partition("-")
        return (cfg.get(c, 9), rev.get(r, 9), s)

    return sorted(set(systems), key=key)
