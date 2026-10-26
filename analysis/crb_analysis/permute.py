"""Paired permutation tests (F13): within each task the two systems' task vectors (tp_t, v_t, f_t)
are swapped with probability 1/2, the aggregate metric recomputed, 10,000 permutations; two-sided
p with the +1 correction; Holm over the pairs."""

from __future__ import annotations

import numpy as np

from .load import SEED
from .metrics import TaskMatrix, f1, precision, wrecall

N_PERM = 10_000


def _metric(tp, v, f, w, name):
    r = wrecall(tp, np.broadcast_to(w, np.shape(tp)))
    p = precision(v, f)
    return {"wrecall": r, "precision": p, "f1": f1(p, np.nan_to_num(r))}[name]


def paired_test(tm: TaskMatrix, i: int, j: int, metric: str = "f1", *, n_perm: int = N_PERM, seed: int = SEED, within_task: bool = True):
    """(observed difference i - j, p). within_task=False shuffles task vectors across tasks instead
    (the wrong null; kept for the test that tells the two apart)."""
    w = tm.w.sum()
    a = np.stack([tm.tp[i], tm.v[i], tm.f[i]])
    b = np.stack([tm.tp[j], tm.v[j], tm.f[j]])
    obs = float(_metric(*a.sum(1), w, metric) - _metric(*b.sum(1), w, metric))
    rng = np.random.default_rng(seed)
    T = a.shape[1]
    if within_task:
        swap = rng.random((n_perm, T)) < 0.5
        pa = np.where(swap[:, None, :], b[None], a[None]).sum(-1)
        pb = np.where(swap[:, None, :], a[None], b[None]).sum(-1)
    else:
        both = np.concatenate([a, b], axis=1)
        order = np.argsort(rng.random((n_perm, 2 * T)), axis=1)
        pa = np.take_along_axis(np.broadcast_to(both, (n_perm, 3, 2 * T)), order[:, None, :T], axis=2).sum(-1)
        pb = np.take_along_axis(np.broadcast_to(both, (n_perm, 3, 2 * T)), order[:, None, T:], axis=2).sum(-1)
    d = _metric(pa[:, 0], pa[:, 1], pa[:, 2], w, metric) - _metric(pb[:, 0], pb[:, 1], pb[:, 2], w, metric)
    p = (1 + np.sum(np.abs(d) >= abs(obs) - 1e-12)) / (1 + n_perm)
    return obs, float(p)


def holm(pvalues):
    """Holm-adjusted p-values, in the input order."""
    p = np.asarray(pvalues, float)
    order = np.argsort(p)
    m = len(p)
    adj = np.empty(m)
    running = 0.0
    for rank, k in enumerate(order):
        running = max(running, min(1.0, (m - rank) * p[k]))
        adj[k] = running
    return adj
