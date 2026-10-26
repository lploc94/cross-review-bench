"""Static report figures (PNG and SVG), following the dataviz method with its reference palette:
reviewer identity takes categorical slots 1-3 (blue, orange, aqua; validated all-pairs, light mode),
config is a second encoding (marker shape and line style), magnitudes use the sequential blue ramp,
values are labelled directly, grids and axes recede. Light mode only: the figures go into a report
page with a light surface.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402

SURFACE = "#fcfcfb"
TEXT = "#0b0b0b"
TEXT_2 = "#52514e"
GRID = "#e4e3df"
REVIEWER_COLOR = {"codex": "#2a78d6", "claude": "#eb6834", "agy": "#1baf7a"}
REVIEWER_LABEL = {"codex": "Codex (gpt-6-astra)", "claude": "Claude Code (claude-opus-5-5)", "agy": "Antigravity (gemini-4-argon)"}
CELL_COLOR = {**REVIEWER_COLOR, "none": "#8a8984"}
CONFIG_MARKER = {"high": "o", "max": "D"}
CONFIG_LINE = {"high": "-", "max": "--"}
SEQ_BLUE = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"]
CMAP = LinearSegmentedColormap.from_list("seq_blue", SEQ_BLUE)

plt.rcParams.update({
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
    "text.color": TEXT, "axes.labelcolor": TEXT_2, "xtick.color": TEXT_2, "ytick.color": TEXT_2,
    "axes.edgecolor": GRID, "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.8,
    "axes.spines.top": False, "axes.spines.right": False, "font.size": 10, "axes.titlesize": 12,
    "axes.titleweight": "bold", "axes.titlelocation": "left", "lines.linewidth": 2, "legend.frameon": False,
})


def split(system: str):
    r, _, c = system.partition("-")
    return r, c


def color(system: str) -> str:
    return REVIEWER_COLOR.get(split(system)[0], TEXT_2)


def _legend(ax, systems, *, below=True):
    reviewers = [r for r in REVIEWER_COLOR if any(split(s)[0] == r for s in systems)]
    configs = [c for c in CONFIG_MARKER if any(split(s)[1] == c for s in systems)]
    handles = [Line2D([], [], color=REVIEWER_COLOR[r], marker="o", linestyle="", markersize=8, label=REVIEWER_LABEL[r]) for r in reviewers]
    if len(configs) > 1:
        handles += [Line2D([], [], color=TEXT_2, marker=CONFIG_MARKER[c], linestyle=CONFIG_LINE[c], markersize=8, label=f"effort {c}") for c in configs]
    if below:
        _legend_below(ax, handles=handles, ncol=min(3, len(handles)), fontsize=9, labelcolor=TEXT)
    else:
        ax.legend(handles=handles, loc="lower left", fontsize=9, labelcolor=TEXT)


def _legend_below(ax, **kw):
    """A legend just under the axis label and tick labels, at any figure height."""
    fig = ax.figure
    fig.canvas.draw()
    bottom = ax.get_tightbbox(fig.canvas.get_renderer()).y0 - 6 * fig.dpi / 72
    y = ax.transAxes.inverted().transform((0, bottom))[1]
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, y), **kw)


def _save(fig, out: Path, name: str) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    for ext in ("png", "svg"):
        p = out / f"{name}.{ext}"
        fig.savefig(p, dpi=200 if ext == "png" else None, bbox_inches="tight")
        paths.append(p)
    plt.close(fig)
    return paths


def leaderboard(lb: pd.DataFrame, out: Path) -> list[Path]:
    """F1 per system with its 95% CI, best on top."""
    d = lb.sort_values("f1")
    fig, ax = plt.subplots(figsize=(7.5, 0.55 * len(d) + 1.4))
    y = np.arange(len(d))
    for k, (_, r) in enumerate(d.iterrows()):
        c = color(r["system"])
        ax.plot([r["f1_lo"], r["f1_hi"]], [k, k], color=c, linewidth=2, solid_capstyle="round")
        ax.plot(r["f1"], k, marker=CONFIG_MARKER.get(split(r["system"])[1], "o"), color=c, markersize=9, markeredgecolor=SURFACE, markeredgewidth=2)
        ax.annotate(f"{r['f1']:.3f}", (r["f1_hi"], k), xytext=(6, 0), textcoords="offset points", va="center", fontsize=9, color=TEXT)
    ax.set_yticks(y, d["system"])
    ax.set_xlabel("F1 (severity-weighted recall × precision), 95% bootstrap CI")
    ax.set_title("Leaderboard: F1 on the synthetic corpus")
    ax.grid(axis="y", visible=False)
    lo = max(0.0, float(d["f1_lo"].min()) - 0.05)
    ax.set_xlim(lo, min(1.0, float(d["f1_hi"].max()) + 0.08))
    _legend(ax, d["system"])
    return _save(fig, out, "leaderboard")


def precision_recall(lb: pd.DataFrame, out: Path) -> list[Path]:
    fig, ax = plt.subplots(figsize=(6.5, 5.2))
    for _, r in lb.iterrows():
        c = color(r["system"])
        ax.errorbar(r["wrecall"], r["precision"], xerr=[[r["wrecall"] - r["wrecall_lo"]], [r["wrecall_hi"] - r["wrecall"]]],
                    yerr=[[r["precision"] - r["precision_lo"]], [r["precision_hi"] - r["precision"]]], color=c, elinewidth=1.5, capsize=0,
                    marker=CONFIG_MARKER.get(split(r["system"])[1], "o"), markersize=9, markeredgecolor=SURFACE, markeredgewidth=2, linestyle="")
        ax.annotate(r["system"], (r["wrecall"], r["precision"]), xytext=(7, 7), textcoords="offset points", fontsize=9, color=TEXT)
    ax.set_xlabel("Severity-weighted recall")
    ax.set_ylabel("Precision")
    ax.set_title("Precision and recall, 95% CIs")
    _legend(ax, lb["system"])
    return _save(fig, out, "precision_recall")


def _spread(items, gap):
    """[y, x, label] sorted by y and pushed apart to at least `gap` (label placement only)."""
    items = sorted(items)
    for k in range(1, len(items)):
        items[k][0] = max(items[k][0], items[k - 1][0] + gap)
    return items


def recall_by_difficulty(rd: pd.DataFrame, out: Path, systems) -> list[Path]:
    levels = ["L1", "L2", "L3", "L4"]
    fig, ax = plt.subplots(figsize=(7, 4.6))
    ends = []
    for s in systems:
        d = rd[(rd["system"] == s) & rd["group"].isin(levels)].set_index("group").reindex(levels)
        r, c = split(s)
        ax.plot(levels, d["wrecall"], color=color(s), linestyle=CONFIG_LINE.get(c, "-"), marker=CONFIG_MARKER.get(c, "o"), markersize=8, markeredgecolor=SURFACE, markeredgewidth=1.5)
        last = d["wrecall"].dropna()
        if len(last):
            ends.append([float(last.iloc[-1]), levels.index(last.index[-1]), s])
    for (y, x, s) in _spread(ends, gap=0.045):
        ax.annotate(s, (x + 0.08, y), va="center", fontsize=9, color=TEXT)
    ax.set_ylim(0, 1.02)
    ax.set_xlim(-0.2, 3.9)
    ax.set_xlabel("Difficulty (L1 visible in the diff … L4 needs domain or cross-file reasoning)")
    ax.set_ylabel("Severity-weighted recall")
    ax.set_title("Recall by difficulty")
    _legend(ax, systems, below=False)
    return _save(fig, out, "recall_by_difficulty")


def category_heatmap(rc: pd.DataFrame, out: Path, systems) -> list[Path]:
    cats = sorted(c for c in rc["group"].unique() if c not in ("pooled", "unknown"))
    m = rc.pivot_table(index="system", columns="group", values="wrecall").reindex(index=list(systems), columns=cats)
    fig, ax = plt.subplots(figsize=(1.0 * len(cats) + 2.6, 0.55 * len(systems) + 1.8))
    im = ax.imshow(m.to_numpy(float), cmap=CMAP, vmin=0, vmax=1, aspect="auto")
    ax.set_xticks(range(len(cats)), cats, rotation=30, ha="right")
    ax.set_yticks(range(len(systems)), list(systems))
    ax.grid(False)
    for i in range(m.shape[0]):
        for j in range(m.shape[1]):
            v = m.iat[i, j]
            if np.isfinite(v):
                ax.text(j, i, f"{v:.2f}", ha="center", va="center", fontsize=8.5, color="#ffffff" if v > 0.55 else TEXT)
    for s in ax.spines.values():
        s.set_visible(False)
    _cell_gaps(ax, m.shape)
    cb = fig.colorbar(im, ax=ax, fraction=0.04, pad=0.02)
    cb.set_label("Severity-weighted recall", color=TEXT_2)
    cb.outline.set_visible(False)
    ax.set_title("Recall by bug category")
    return _save(fig, out, "category_heatmap")


def _cell_gaps(ax, shape):
    ax.set_xticks(np.arange(-0.5, shape[1], 1), minor=True)
    ax.set_yticks(np.arange(-0.5, shape[0], 1), minor=True)
    ax.grid(which="minor", color=SURFACE, linewidth=2)
    ax.tick_params(which="minor", length=0)


def track_b(tb: pd.DataFrame, out: Path) -> list[Path]:
    scen = ["B1", "B2", "B3", "B4"]
    names = {"B1": "B1\nrecognises a\ncorrect fix", "B2": "B2\ncatches a\nwrong fix", "B3": "B3\nholds against a\nfalse rebuttal", "B4": "B4\nconcedes to a\nvalid rebuttal"}
    systems = [s for s in ["codex-high", "claude-high", "agy-high"] if s in set(tb["system"])] or sorted(set(tb["system"]))
    fig, ax = plt.subplots(figsize=(8.5, 4.6))
    width = 0.8 / max(1, len(systems))
    for k, s in enumerate(systems):
        d = tb[tb["system"] == s].set_index("scenario").reindex(scen)
        x = np.arange(len(scen)) + (k - (len(systems) - 1) / 2) * width
        ax.bar(x, d["rate"], width=width, color=color(s), edgecolor=SURFACE, linewidth=2, label=REVIEWER_LABEL.get(split(s)[0], s))
        ax.errorbar(x, d["rate"], yerr=[d["rate"] - d["lo"], d["hi"] - d["rate"]], fmt="none", ecolor=TEXT_2, elinewidth=1.2, capsize=0)
        for xi, v in zip(x, d["rate"]):
            if np.isfinite(v):
                ax.annotate(f"{v:.0%}", (xi, 0.02), ha="center", fontsize=8, color="#ffffff")
    ax.set_xticks(range(len(scen)), [names[s] for s in scen], fontsize=9)
    ax.set_ylim(0, 1.05)
    ax.set_ylabel("Share of second rounds (Wilson 95% CI)")
    ax.set_title("Track B: the second round")
    ax.grid(axis="x", visible=False)
    _legend_below(ax, ncol=3, fontsize=9)
    return _save(fig, out, "track_b")


def track_c(cells: pd.DataFrame, out: Path) -> list[Path]:
    order = [c for c in ["codex", "claude", "agy", "none"] if c in set(cells["cell"])]
    orchs = sorted(set(cells["orchestrator"]))
    m = cells.pivot_table(index="orchestrator", columns="cell", values="fixed_rate").reindex(index=orchs, columns=order)
    reg = cells.pivot_table(index="orchestrator", columns="cell", values="regression_rate").reindex(index=orchs, columns=order)
    fig, ax = plt.subplots(figsize=(1.6 * len(order) + 2.4, 1.1 * len(orchs) + 1.8))
    im = ax.imshow(m.to_numpy(float), cmap=CMAP, vmin=0, vmax=1, aspect="auto")
    ax.set_xticks(range(len(order)), [f"review: {c}" if c != "none" else "no review" for c in order])
    ax.set_yticks(range(len(orchs)), [f"orchestrator: {o}" for o in orchs])
    ax.grid(False)
    for i in range(m.shape[0]):
        for j in range(m.shape[1]):
            v = m.iat[i, j]
            if np.isfinite(v):
                ax.text(j, i, f"{v:.0%} fixed\n{reg.iat[i, j]:.0%} regress", ha="center", va="center", fontsize=8.5, color="#ffffff" if v > 0.55 else TEXT)
    for s in ax.spines.values():
        s.set_visible(False)
    _cell_gaps(ax, m.shape)
    cb = fig.colorbar(im, ax=ax, fraction=0.04, pad=0.02)
    cb.set_label("Bugs fixed (hidden tests pass)", color=TEXT_2)
    cb.outline.set_visible(False)
    ax.set_title("Track C: fixing with review")
    return _save(fig, out, "track_c")


def time_per_run(a: pd.DataFrame, out: Path, systems) -> list[Path]:
    fig, ax = plt.subplots(figsize=(7.5, 0.55 * len(systems) + 1.4))
    data = [a.loc[a["system"] == s, "wall_s"].dropna().to_numpy() / 60 for s in systems]
    bp = ax.boxplot(data, orientation="horizontal", widths=0.5, patch_artist=True, showfliers=False, medianprops={"color": SURFACE, "linewidth": 2}, whiskerprops={"color": TEXT_2}, capprops={"color": TEXT_2})
    for patch, s in zip(bp["boxes"], systems):
        patch.set_facecolor(color(s))
        patch.set_edgecolor(SURFACE)
        patch.set_linewidth(2)
    for k, d in enumerate(data, start=1):
        if len(d):
            ax.annotate(f"median {np.median(d):.1f} min", (np.percentile(d, 75), k), xytext=(8, 10), textcoords="offset points", fontsize=8.5, color=TEXT)
    ax.set_yticks(range(1, len(systems) + 1), list(systems))
    ax.invert_yaxis()
    # wall_s spans the whole run: setup, round 1 and, where it ran, the Track B round
    ax.set_xlabel("Minutes per run (setup, round 1 and any second round)")
    ax.set_title("Time per run")
    ax.grid(axis="y", visible=False)
    return _save(fig, out, "time_per_run")
