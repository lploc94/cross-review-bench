"""Figure layout: a legend below the plot never overlaps the axis label or the tick labels, whatever
the number of systems (a short figure with one system once put it on the x label). Systems are invented."""

import matplotlib

matplotlib.use("Agg")

import pandas as pd
import pytest

from crb_analysis import figures


def _board(systems):
    rows = []
    for k, s in enumerate(systems):
        f1 = 0.5 + 0.05 * k
        rows.append({"system": s, "f1": f1, "f1_lo": f1 - 0.03, "f1_hi": f1 + 0.03,
                     "wrecall": f1, "wrecall_lo": f1 - 0.03, "wrecall_hi": f1 + 0.03,
                     "precision": f1, "precision_lo": f1 - 0.03, "precision_hi": f1 + 0.03})
    return pd.DataFrame(rows)


def _overlaps(fig):
    fig.canvas.draw()
    r = fig.canvas.get_renderer()
    ax = fig.axes[0]
    leg = ax.get_legend().get_window_extent(r)
    label = ax.xaxis.label.get_window_extent(r)
    ticks = [t.get_window_extent(r) for t in ax.get_xticklabels() if t.get_text()]
    return any(leg.overlaps(b) for b in [label, *ticks])


@pytest.mark.parametrize("systems", [["codex-high"], ["codex-high", "claude-high"], ["codex-high", "claude-high", "agy-high", "codex-max", "claude-max"]])
@pytest.mark.parametrize("draw", ["leaderboard", "precision_recall"])
def test_legend_below_clears_the_axis(monkeypatch, tmp_path, systems, draw):
    kept = {}
    monkeypatch.setattr(figures, "_save", lambda fig, out, name: kept.setdefault("fig", fig) and [])
    getattr(figures, draw)(_board(systems), tmp_path)
    assert not _overlaps(kept["fig"])


def test_track_b_legend_clears_the_axis(monkeypatch, tmp_path):
    kept = {}
    monkeypatch.setattr(figures, "_save", lambda fig, out, name: kept.setdefault("fig", fig) and [])
    tb = pd.DataFrame([{"system": "codex-high", "scenario": s, "rate": 0.5, "lo": 0.4, "hi": 0.6} for s in ["B1", "B2", "B3", "B4"]])
    figures.track_b(tb, tmp_path)
    assert not _overlaps(kept["fig"])
