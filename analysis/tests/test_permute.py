import numpy as np

from crb_analysis.metrics import TaskMatrix
from crb_analysis.permute import holm, paired_test


def tm_of(tp, v, f, w):
    T = len(w)
    return TaskMatrix(["a", "b"], [f"t{i}" for i in range(T)], np.array(tp, float), np.array(v, float), np.array(f, float), np.array(w, float), np.array(["r"] * T, dtype=object), [])


def test_identical_systems_give_roughly_uniform_p():
    rng = np.random.default_rng(5)
    ps = []
    for _ in range(200):
        T = 40
        w = rng.integers(1, 8, T).astype(float)
        tp = rng.binomial(1, 0.5, (2, T)) * w
        f = rng.integers(1, 5, (2, T)).astype(float)
        v = np.minimum(f, rng.integers(0, 4, (2, T)))
        ps.append(paired_test(tm_of(tp, v, f, w), 0, 1, "f1", n_perm=400, seed=int(rng.integers(1e9)))[1])
    ps = np.array(ps)
    assert 0.4 < ps.mean() < 0.6
    assert (ps < 0.05).mean() < 0.12


def test_a_strong_difference_is_detected():
    T = 40
    w = np.full(T, 4.0)
    d, p = paired_test(tm_of([w * 0.9, w * 0.3], [np.full(T, 3.0), np.full(T, 1.0)], [np.full(T, 3.0), np.full(T, 3.0)], w), 0, 1, "f1", n_perm=2000)
    assert d > 0 and p < 0.01


def test_labels_are_swapped_within_a_task():
    # tasks differ wildly; a is a little better on every one: only the within-task null sees it
    T = 30
    w = np.geomspace(1, 1000, T)
    tp = np.stack([w * 0.55, w * 0.50])
    f = np.stack([w, w])
    v = np.stack([w * 0.8, w * 0.75])
    tm = tm_of(tp, v, f, w)
    _, within = paired_test(tm, 0, 1, "f1", n_perm=5000)
    _, between = paired_test(tm, 0, 1, "f1", n_perm=5000, within_task=False)
    assert within < 0.001
    assert between > 0.2


def test_holm():
    assert np.allclose(holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06])
    assert np.allclose(holm([0.5, 0.9]), [1.0, 1.0])
