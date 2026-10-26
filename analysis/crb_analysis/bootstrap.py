"""Bootstrap over tasks, stratified by repo (F13: 10,000 resamples, seed 20261017).

Every replicate draws, within each repo, as many tasks as the repo has, with replacement; the same
draw applies to every system, so differences stay paired.
"""

from __future__ import annotations

import numpy as np
from scipy.stats import norm

from .load import SEED
from .metrics import TaskMatrix, f1, precision, wrecall

N_BOOT = 10_000


def stratified_indices(strata, n_boot: int = N_BOOT, seed: int = SEED) -> np.ndarray:
    """[n_boot, n_tasks] task indices, resampled within each stratum."""
    strata = np.asarray(strata, dtype=object)
    rng = np.random.default_rng(seed)
    cols = []
    for s in sorted(set(strata), key=str):
        members = np.flatnonzero(strata == s)
        cols.append(members[rng.integers(0, len(members), size=(n_boot, len(members)))])
    return np.concatenate(cols, axis=1) if cols else np.zeros((n_boot, 0), dtype=int)


def replicate_metrics(tm: TaskMatrix, idx: np.ndarray) -> dict[str, np.ndarray]:
    """wRecall, precision and F1 per replicate and system: arrays [n_boot, system]."""
    tp = tm.tp[:, idx].sum(-1).T
    v = tm.v[:, idx].sum(-1).T
    f = tm.f[:, idx].sum(-1).T
    w = tm.w[idx].sum(-1)[:, None]
    r = wrecall(tp, np.broadcast_to(w, tp.shape))
    p = precision(v, f)
    return {"wrecall": r, "precision": p, "f1": f1(p, np.nan_to_num(r))}


def percentile_ci(x: np.ndarray, level: float = 0.95, axis: int = 0):
    a = (1 - level) / 2 * 100
    return np.nanpercentile(x, a, axis=axis), np.nanpercentile(x, 100 - a, axis=axis)


def metric_cis(tm: TaskMatrix, n_boot: int = N_BOOT, seed: int = SEED) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """95% CI of each metric per system."""
    reps = replicate_metrics(tm, stratified_indices(tm.repo, n_boot, seed))
    return {k: percentile_ci(v) for k, v in reps.items()}


def mde(tm: TaskMatrix, i: int, j: int, metric: str = "f1", *, alpha: float = 0.05, pairs: int = 3, power: float = 0.8, n_boot: int = N_BOOT, seed: int = SEED) -> float:
    """Minimum detectable difference in `metric` between systems i and j: (z_{1-a/2} + z_power) x the
    bootstrap standard error of the paired difference, with a = alpha / pairs (Holm's strictest step)."""
    reps = replicate_metrics(tm, stratified_indices(tm.repo, n_boot, seed))[metric]
    se = np.nanstd(reps[:, i] - reps[:, j], ddof=1)
    return float((norm.ppf(1 - alpha / pairs / 2) + norm.ppf(power)) * se)
