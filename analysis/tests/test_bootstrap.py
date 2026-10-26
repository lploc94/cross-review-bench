import numpy as np

from crb_analysis.bootstrap import metric_cis, stratified_indices
from crb_analysis.metrics import TaskMatrix


def test_indices_stay_in_their_stratum_and_are_deterministic():
    strata = np.array(["a"] * 5 + ["b"] * 3 + ["c"] * 2, dtype=object)
    i1 = stratified_indices(strata, 200, 7)
    assert i1.shape == (200, 10)
    assert np.array_equal(i1, stratified_indices(strata, 200, 7))
    assert not np.array_equal(i1, stratified_indices(strata, 200, 8))
    for row in i1[:20]:
        counts = {s: sum(strata[k] == s for k in row) for s in "abc"}
        assert counts == {"a": 5, "b": 3, "c": 2}


def test_ci_contains_the_known_mean():
    rng = np.random.default_rng(1)
    T = 240
    tp = np.clip(rng.normal(0.6, 0.15, T), 0, 1)[None]
    tm = TaskMatrix(["s"], [f"t{i}" for i in range(T)], tp, np.ones((1, T)), np.ones((1, T)), np.ones(T), np.array([f"r{i % 4}" for i in range(T)], dtype=object), [])
    lo, hi = metric_cis(tm, 2000, 3)["wrecall"]
    assert lo[0] < 0.6 < hi[0]
    assert hi[0] - lo[0] < 0.06
