import math

import numpy as np

from crb_analysis.metrics import pass_k, recall_by, task_matrix, run_rates, f1, precision, wrecall, track_b, track_c, unplanted, wilson
from helpers import bug, frame, run

T1 = [bug("B1", "high"), bug("B2", "medium", "L3", "concurrency")]  # w = 5
T3 = [bug("B1", "high")]  # w = 3


def rows():
    r = []
    # X: task 1 finds both bugs then only B1; reports one false finding on the clean task in run 1
    r += [run("x-high", "t1", 1, 5, 2, 3, T1, ["B1", "B2"], matched=2, loc_ok=1), run("x-high", "t1", 2, 3, 2, 1, T1, ["B1"], matched=1, loc_ok=1)]
    r += [run("x-high", "t2", 1, 0, 0, 1, kind="clean", false_alarm=True), run("x-high", "t2", 2, 0, 0, 0, kind="clean", false_alarm=False)]
    r += [run("x-high", "t3", 1, 0, 0, 0, T3), run("x-high", "t3", 2, 0, 0, 0, T3)]
    # Y: never reports anything
    for t, b, k in [("t1", T1, "buggy"), ("t2", [], "clean"), ("t3", T3, "buggy")]:
        r += [run("y-high", t, n, 0, 0, 0, b, kind=k, false_alarm=False if k == "clean" else None) for n in (1, 2)]
    # Z: only invalid findings
    for t, b, k in [("t1", T1, "buggy"), ("t2", [], "clean"), ("t3", T3, "buggy")]:
        r += [run("z-high", t, n, 0, 0, 2, b, kind=k, false_alarm=True if k == "clean" else None) for n in (1, 2)]
    return frame(r)


def test_hand_computed_metrics():
    m = task_matrix(rows()).metrics().set_index("system")
    # X: sum tp_t = 4 of w 8; v 2 of f 2.5
    assert math.isclose(m.loc["x-high", "wrecall"], 0.5)
    assert math.isclose(m.loc["x-high", "precision"], 0.8)
    assert math.isclose(m.loc["x-high", "f1"], 2 * 0.8 * 0.5 / 1.3)
    # Y: no findings: precision 1 (flagged), recall 0, F1 0; Z: P = R = 0 gives F1 0
    assert m.loc["y-high", "precision"] == 1.0 and bool(m.loc["y-high", "no_findings"])
    assert m.loc["y-high", "f1"] == 0.0 and m.loc["z-high", "f1"] == 0.0
    assert np.isfinite(m[["wrecall", "precision", "f1"]].to_numpy()).all()


def test_ratio_helpers_never_divide_by_zero():
    assert np.isnan(wrecall(0, 0))
    assert precision(0, 0) == 1.0
    assert f1(0, 0) == 0.0


def test_pass_k_and_recall_by_severity():
    pk = pass_k(rows()).set_index("system")
    assert pk.loc["x-high", "k"] == 2 and pk.loc["x-high", "bugs"] == 3
    assert math.isclose(pk.loc["x-high", "pass_all"], 1 / 3) and math.isclose(pk.loc["x-high", "pass_any"], 2 / 3)
    sev = recall_by(rows(), "severity").set_index(["system", "group"])
    assert math.isclose(sev.loc[("x-high", "high"), "wrecall"], 0.5)  # 3 of 6 across t1, t3
    assert math.isclose(sev.loc[("x-high", "medium"), "wrecall"], 0.5)  # found in one of two runs
    diff = recall_by(rows(), "difficulty").set_index(["system", "group"])
    assert math.isclose(diff.loc[("x-high", "L3"), "wrecall"], 0.5)


def test_pass_k_counts_only_tasks_with_all_k_runs():
    # a contaminated run leaves x-high one run of t1, whose bugs it found
    r = rows()
    keep = ~((r["system"] == "x-high") & (r["task"] == "t1") & (r["n"] == 2))
    pk = pass_k(r[keep]).set_index("system")
    # t1's two bugs leave pass^k and pass@k (one run of two); t3's bug stays (both runs)
    assert pk.loc["x-high", "k"] == 2 and pk.loc["x-high", "bugs"] == 1 and pk.loc["x-high", "bugs_short"] == 2
    assert pk.loc["x-high", "pass_all"] == 0.0 and pk.loc["x-high", "pass_any"] == 0.0
    # a system where every task has all k runs loses nothing
    assert pk.loc["y-high", "bugs_short"] == 0 and pk.loc["y-high", "bugs"] == 3


def test_run_rates():
    rr = run_rates(rows()).set_index("system")
    assert rr.loc["x-high", "false_alarm_rate"] == 0.5
    assert rr.loc["z-high", "false_alarm_rate"] == 1.0
    assert math.isclose(rr.loc["x-high", "location_accuracy"], 2 / 3)
    assert np.isnan(rr.loc["y-high", "location_accuracy"])


def test_task_matrix_keeps_only_tasks_every_system_ran():
    r = rows()
    r = r[~((r["system"] == "y-high") & (r["task"] == "t3"))]
    tm = task_matrix(r)
    assert tm.tasks == ["t1", "t2"] and tm.dropped == ["t3"]


def test_track_b_rates_and_wilson():
    import pandas as pd
    b = pd.DataFrame([{"system": "x-high", "scenario": "B1", "outcome": o, "new_valid_round2": 1} for o in [True, True, False, "n/a"]])
    t = track_b(b).iloc[0]
    assert (t["n"], t["na"]) == (3, 1) and math.isclose(t["rate"], 2 / 3)
    lo, hi = wilson(2, 3)
    assert math.isclose(t["lo"], lo) and lo < 2 / 3 < hi
    assert all(np.isnan(wilson(0, 0)))


def test_track_c_difference_vs_none_is_the_difference_of_the_cell_rates():
    import pandas as pd

    def loop(cell, task, bugs, fixed):
        return {"orchestrator": "o", "cell": cell, "task": task, "bugs": bugs, "bugs_testable": bugs, "bugs_fixed": [f"B{i + 1}" for i in range(fixed)],
                "regression": False, "review_rounds": 1, "wall_s": 1.0}
    # same bugs fixed in total (4 of 6) but spread differently over tasks of 1, 2 and 3 bugs; t4 has no testable bug
    c = pd.DataFrame([loop("none", "t1", 1, 1), loop("none", "t2", 2, 0), loop("none", "t3", 3, 3), loop("none", "t4", 0, 0),
                      loop("rev", "t1", 1, 0), loop("rev", "t2", 2, 2), loop("rev", "t3", 3, 2), loop("rev", "t4", 0, 0)])
    cells, diffs = track_c(c, n_boot=500)
    rates = cells.set_index("cell")["fixed_rate"]
    d = diffs.iloc[0]
    assert math.isclose(rates["rev"], 4 / 6) and math.isclose(rates["none"], 4 / 6)
    assert math.isclose(d["diff_vs_none"], rates["rev"] - rates["none"], abs_tol=1e-12)  # a mean of per-task ratios gives +0.17
    assert d["tasks"] == 4 and np.isfinite(d["lo"]) and np.isfinite(d["hi"]) and d["lo"] <= 0 <= d["hi"]


def test_unplanted_counts_only_pooled_bugs():
    planted, p1, p2 = bug("B1", "high"), bug("P1", "medium", pooled=True), bug("P2", "low", pooled=True)
    r = frame([
        run("x-high", "t1", 1, 5, 2, 2, [planted, p1], ["B1", "P1"], matched=2), run("x-high", "t1", 2, 3, 1, 1, [planted, p1], ["B1"], matched=1),
        run("x-high", "t2", 1, 0, 0, 0, [p2], kind="clean"), run("x-high", "t2", 2, 1, 1, 1, [p2], ["P2"], kind="clean", matched=1),
        run("y-high", "t1", 1, 3, 1, 1, [planted, p1], ["B1"], matched=1), run("y-high", "t1", 2, 3, 1, 1, [planted, p1], ["B1"], matched=1),
        run("y-high", "t2", 1, 0, 0, 0, [p2], kind="clean"), run("y-high", "t2", 2, 0, 0, 0, [p2], kind="clean"),
    ])
    u = unplanted(r).set_index("system")
    assert u.loc["x-high", "pooled_bugs"] == 2 and u.loc["x-high", "found_any"] == 2
    # per-task means: P1 found in 1 of 2 runs (2 * 1/2), P2 in 1 of 2 (1 * 1/2) over weights 2 + 1
    assert math.isclose(u.loc["x-high", "wrecall"], (1 + 0.5) / 3)
    assert u.loc["y-high", "found_any"] == 0 and u.loc["y-high", "wrecall"] == 0
