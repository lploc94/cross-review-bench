import numpy as np

from crb_analysis.bt import fit, strengths, win_matrix


def test_recovers_known_strengths():
    true = np.array([1.0, 0.0, -1.0])
    rng = np.random.default_rng(11)
    # Gumbel noise on the log-strengths: pairwise win odds are exactly Bradley-Terry
    scores = true[:, None] + rng.gumbel(size=(3, 6000))
    est = fit(win_matrix(scores))
    assert np.allclose(est, true - true.mean(), atol=0.08)


def test_ties_are_half_a_win_and_ci_brackets_the_estimate():
    scores = np.array([[1, 1, 0.5, 0.2], [1, 0, 0.5, 0.1], [0, 0, 0.5, 0.0]], float)
    w = win_matrix(scores)
    assert w[0, 1] == 2 + 0.5 * 2 - 0  # wins on tasks 2 and 4, ties on 1 and 3
    assert w[0, 1] + w[1, 0] == 4
    est, (lo, hi) = strengths(scores, ["r"] * 4, n_boot=500, seed=2)
    assert np.all(lo <= est + 1e-9) and np.all(est <= hi + 1e-9)
    assert est[0] > est[1] > est[2]
