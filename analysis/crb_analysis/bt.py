"""Bradley-Terry strengths from per-task pairwise wins (F13, Metrics): on each task with w_t > 0, the
system with the higher F1_t wins, a tie is half a win each. Fitted with Hunter's MM algorithm,
vectorised over bootstrap replicates; strengths reported as log-strengths centred on 0."""

from __future__ import annotations

import numpy as np

from .bootstrap import N_BOOT, percentile_ci, stratified_indices
from .load import SEED

MAX_ITER = 2000
TOL = 1e-10
EPS = 1e-6  # a small prior win each way keeps a never-losing system finite


def win_matrix(scores: np.ndarray) -> np.ndarray:
    """scores [system, task] -> W[i, j] = tasks where i beats j (+1/2 per tie)."""
    s = scores[:, None, :] - scores[None, :, :]
    w = (s > 0).sum(-1) + 0.5 * (s == 0).sum(-1)
    np.fill_diagonal(w, 0)
    return w.astype(float)


def fit(wins: np.ndarray) -> np.ndarray:
    """MM fit; wins [..., S, S]. Returns log-strengths [..., S] with mean 0."""
    w = wins + EPS * (1 - np.eye(wins.shape[-1]))
    n = w + np.swapaxes(w, -1, -2)
    total = w.sum(-1)
    p = np.ones(w.shape[:-1])
    for _ in range(MAX_ITER):
        denom = (n / (p[..., :, None] + p[..., None, :])).sum(-1)
        new = total / denom
        new /= np.exp(np.log(new).mean(-1, keepdims=True))
        if np.max(np.abs(new - p)) < TOL:
            p = new
            break
        p = new
    return np.log(p)


def strengths(scores: np.ndarray, strata, n_boot: int = N_BOOT, seed: int = SEED):
    """(log-strengths [S], (lo [S], hi [S])) with a stratified bootstrap over tasks."""
    est = fit(win_matrix(scores))
    idx = stratified_indices(strata, n_boot, seed)
    S = scores.shape[0]
    wins = np.zeros((idx.shape[0], S, S))
    for i in range(S):
        for j in range(S):
            if i != j:
                d = scores[i, idx] - scores[j, idx]  # [B, T], one pair at a time to bound memory
                wins[:, i, j] = (d > 0).sum(-1) + 0.5 * (d == 0).sum(-1)
    boots = fit(wins)
    return est, percentile_ci(boots)
