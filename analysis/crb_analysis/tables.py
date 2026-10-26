"""Markdown tables (GitHub pipe tables) without extra dependencies."""

from __future__ import annotations

import math
from pathlib import Path

import pandas as pd


def fmt(x, digits: int = 3) -> str:
    if x is None:
        return "—"
    if isinstance(x, bool):
        return "yes" if x else "no"
    if isinstance(x, float):
        if math.isnan(x):
            return "—"
        return f"{x:.{digits}f}"
    if isinstance(x, (list, tuple)):
        return " > ".join(map(str, x))
    return str(x)


def markdown(df: pd.DataFrame, digits: int = 3) -> str:
    cols = list(df.columns)
    out = ["| " + " | ".join(cols) + " |", "|" + "|".join("---" for _ in cols) + "|"]
    for _, r in df.iterrows():
        out.append("| " + " | ".join(fmt(r[c], digits).replace("|", "\\|") for c in cols) + " |")
    return "\n".join(out) + "\n"


def write(df: pd.DataFrame, path: Path, title: str, note: str = "", digits: int = 3) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = f"# {title}\n\n" + (f"{note}\n\n" if note else "") + markdown(df, digits)
    path.write_text(body, encoding="utf-8")
    return path


def ci(lo, hi, digits: int = 3) -> str:
    return f"[{fmt(float(lo), digits)}, {fmt(float(hi), digits)}]"
