"""The pre-registered metrics (METHODOLOGY, Metrics), built from per-task means.

For a system and task t, tp_t, v_t and f_t are the means over the system's runs of matched pool
weight, valid findings and findings; w_t is the task's pool weight. No ratio is taken per run, so
0/0 never occurs:

    wRecall   = sum_t tp_t / sum_t w_t   (tasks with w_t > 0)
    Precision = sum_t v_t / sum_t f_t    (1 when no system finding at all, reported as such)
    F1        = 2PR / (P + R), 0 when P + R = 0
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .load import system_order


def wrecall(tp, w):
    tp, w = np.asarray(tp, float), np.asarray(w, float)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(w > 0, tp / np.where(w > 0, w, 1), np.nan)


def precision(v, f):
    v, f = np.asarray(v, float), np.asarray(f, float)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(f > 0, v / np.where(f > 0, f, 1), 1.0)


def f1(p, r):
    p, r = np.asarray(p, float), np.asarray(r, float)
    s = p + r
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(s > 0, 2 * p * r / np.where(s > 0, s, 1), 0.0)


@dataclass
class TaskMatrix:
    """Per-task means of each system on the same tasks: arrays [system, task]; w, repo per task."""

    systems: list[str]
    tasks: list[str]
    tp: np.ndarray
    v: np.ndarray
    f: np.ndarray
    w: np.ndarray
    repo: np.ndarray
    dropped: list[str]

    def subset(self, mask) -> "TaskMatrix":
        mask = np.asarray(mask, bool)
        return TaskMatrix(self.systems, [t for t, m in zip(self.tasks, mask) if m], self.tp[:, mask], self.v[:, mask], self.f[:, mask], self.w[mask], self.repo[mask], self.dropped)

    def metrics(self) -> pd.DataFrame:
        tp, v, f, w = self.tp.sum(1), self.v.sum(1), self.f.sum(1), self.w.sum()
        r = wrecall(tp, np.full_like(tp, w))
        p = precision(v, f)
        return pd.DataFrame({"system": self.systems, "wrecall": r, "precision": p, "f1": f1(p, np.nan_to_num(r)), "no_findings": f == 0})


def task_matrix(a: pd.DataFrame, systems=None, *, tp_col="tp_weight", v_col="valid", f_col="findings") -> TaskMatrix:
    """Per-task means for the given systems over the tasks every one of them has runs on."""
    systems = system_order(a["system"]) if systems is None else list(systems)
    a = a[a["system"].isin(systems)]
    means = a.groupby(["system", "task"])[[tp_col, v_col, f_col]].mean()
    have = a.groupby("task")["system"].nunique()
    tasks = sorted(have[have == len(systems)].index)
    dropped = sorted(set(a["task"]) - set(tasks))
    info = a.groupby("task").agg(w=("pool_weight", "max"), repo=("repo", "first"))
    idx = pd.MultiIndex.from_product([systems, tasks])
    m = means.reindex(idx)
    shape = (len(systems), len(tasks))
    return TaskMatrix(
        systems, tasks,
        m[tp_col].to_numpy(float).reshape(shape), m[v_col].to_numpy(float).reshape(shape), m[f_col].to_numpy(float).reshape(shape),
        info.loc[tasks, "w"].to_numpy(float), info.loc[tasks, "repo"].to_numpy(object), dropped,
    )


def per_task_scores(tm: TaskMatrix):
    """r_t, p_t, F1_t per system and task (tasks with w_t > 0 only), for Bradley-Terry."""
    keep = tm.w > 0
    r = tm.tp[:, keep] / tm.w[keep]
    p = precision(tm.v[:, keep], tm.f[:, keep])
    return r, p, f1(p, r), [t for t, k in zip(tm.tasks, keep) if k]


def run_rates(a: pd.DataFrame) -> pd.DataFrame:
    """False-alarm rate (clean/decoy runs) and location accuracy (matched findings), per system."""
    out = []
    for s in system_order(a["system"]):
        x = a[a["system"] == s]
        quiet = x[x["kind"].isin(["clean", "decoy"])]
        matched = x["matched"].sum()
        out.append({
            "system": s,
            "false_alarm_rate": float(quiet["false_alarm"].astype(float).mean()) if len(quiet) else np.nan,
            "quiet_runs": len(quiet),
            "location_accuracy": float(x["matched_locations_ok"].sum() / matched) if matched else np.nan,
            "matched_findings": int(matched),
            "runs": len(x),
            "median_wall_s": float(x["wall_s"].median()) if x["wall_s"].notna().any() else np.nan,
            # round 1's output tokens where the CLI reported them (missing reports are left out, never 0)
            "median_output_tokens": float(tok.median()) if (tok := x.get("output_tokens", pd.Series(dtype=float)).dropna()).size else np.nan,
            "output_token_runs": int(tok.size),
        })
    return pd.DataFrame(out)


def pass_k(a: pd.DataFrame) -> pd.DataFrame:
    """pass^k (found in every run) and pass@k (in at least one) over the pool bugs, per system; k = the
    most runs a task has (3). A task with fewer scored runs (a run excluded as contaminated) cannot say
    whether a bug is found in all k: its bugs are left out and counted in `bugs_short`."""
    out = []
    for s in system_order(a["system"]):
        x = a[a["system"] == s]
        groups = [g for _, g in x.groupby("task")]
        k = max((len(g) for g in groups), default=0)
        every = anyone = total = short = 0
        for g in groups:
            ids = [b["id"] for b in g["bugs"].iloc[0]] if isinstance(g["bugs"].iloc[0], list) else []
            found = [set(fs) for fs in g["bugs_found"]]
            if len(found) < k:
                short += len(ids)
                continue
            for bug in ids:
                hits = sum(bug in fs for fs in found)
                total += 1
                every += hits == k
                anyone += hits > 0
        out.append({"system": s, "k": k, "bugs": total, "bugs_short": short, "pass_all": every / total if total else np.nan, "pass_any": anyone / total if total else np.nan})
    return pd.DataFrame(out)


def unplanted(a: pd.DataFrame) -> pd.DataFrame:
    """Secondary metric: real defects outside the answer key (pooled bugs) per system — how many
    there were, how many the system found in at least one run, and the weighted recall over them
    from per-task means."""
    out = []
    for s in system_order(a["system"]):
        x = a[a["system"] == s]
        total = anyone = 0
        tp = w = 0.0
        for _, g in x.groupby("task"):
            pooled = [b for b in (g["bugs"].iloc[0] or []) if b.get("pooled")]
            found = [set(fs) for fs in g["bugs_found"]]
            for b in pooled:
                hits = sum(b["id"] in fs for fs in found)
                total += 1
                anyone += hits > 0
                tp += b["weight"] * hits / len(found)
                w += b["weight"]
        out.append({"system": s, "pooled_bugs": total, "found_any": anyone, "wrecall": tp / w if w else np.nan})
    return pd.DataFrame(out)


def recall_by(a: pd.DataFrame, attr: str) -> pd.DataFrame:
    """Weighted recall restricted to pool bugs with each value of attr (severity, difficulty, category)."""
    rows = []
    for _, r in a.iterrows():
        found = set(r["bugs_found"])
        for b in r["bugs"] or []:
            g = b.get(attr) or ("pooled" if b.get("pooled") else "unknown")
            rows.append({"system": r["system"], "task": r["task"], "run": r["run_id"], "group": g, "found": b["weight"] * (b["id"] in found), "weight": b["weight"]})
    if not rows:
        return pd.DataFrame(columns=["system", "group", "wrecall", "tp", "w"])
    d = pd.DataFrame(rows)
    per_task = d.groupby(["system", "task", "group"]).agg(found=("found", "sum"), runs=("run", "nunique"), weight=("weight", "sum")).reset_index()
    per_task["tp_t"] = per_task["found"] / per_task["runs"]
    per_task["w_t"] = per_task["weight"] / per_task["runs"]
    g = per_task.groupby(["system", "group"]).agg(tp=("tp_t", "sum"), w=("w_t", "sum")).reset_index()
    g["wrecall"] = g["tp"] / g["w"]
    return g[["system", "group", "wrecall", "tp", "w"]]


def ranking(tm: TaskMatrix) -> list[str]:
    """Systems ordered by F1 (best first); ties by name."""
    m = tm.metrics()
    return list(m.sort_values(["f1", "system"], ascending=[False, True])["system"])


def loo_repo_rankings(a: pd.DataFrame, systems) -> pd.DataFrame:
    tm = task_matrix(a, systems)
    out = [{"left_out": "none", "ranking": ranking(tm)}]
    for repo in sorted(set(tm.repo)):
        out.append({"left_out": f"repo:{repo}", "ranking": ranking(tm.subset(tm.repo != repo))})
    return pd.DataFrame(out)


def loo_judge_rankings(a: pd.DataFrame, systems) -> pd.DataFrame:
    """Rankings with each judge's votes left out (score rows carry loo_judge from `crb score`)."""
    out = [{"left_out": "none", "ranking": ranking(task_matrix(a, systems))}]
    have = a["loo_judge"].dropna() if "loo_judge" in a else pd.Series(dtype=object)
    judges = sorted({j for d in have for j in d})
    for j in judges:
        b = a.copy()
        b["tp_loo"] = [d[j]["tp_weight"] if isinstance(d, dict) else np.nan for d in b["loo_judge"]]
        b["v_loo"] = [d[j]["valid"] if isinstance(d, dict) else np.nan for d in b["loo_judge"]]
        out.append({"left_out": f"judge:{j}", "ranking": ranking(task_matrix(b, systems, tp_col="tp_loo", v_col="v_loo"))})
    return pd.DataFrame(out)


def wilson(k: float, n: float, z: float = 1.959963984540054):
    """Wilson score interval for k successes of n; (nan, nan) when n = 0."""
    if n == 0:
        return (np.nan, np.nan)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def track_b(b: pd.DataFrame) -> pd.DataFrame:
    """Per system and scenario: runs with a second round, rate of the predicate holding, Wilson CI, new valid findings."""
    if b.empty:
        return pd.DataFrame(columns=["system", "scenario", "n", "rate", "lo", "hi", "na", "new_valid_round2"])
    out = []
    for (s, sc), g in b.groupby(["system", "scenario"]):
        run = g[g["outcome"] != "n/a"]
        k = int((run["outcome"] == True).sum())  # noqa: E712 (values are True, False or "n/a")
        lo, hi = wilson(k, len(run))
        out.append({"system": s, "scenario": sc, "n": len(run), "rate": k / len(run) if len(run) else np.nan, "lo": lo, "hi": hi, "na": int(len(g) - len(run)), "new_valid_round2": float(run["new_valid_round2"].mean()) if len(run) else np.nan})
    d = pd.DataFrame(out)
    order = {s: i for i, s in enumerate(system_order(d["system"]))}
    return d.sort_values(["scenario", "system"], key=lambda c: c.map(order) if c.name == "system" else c).reset_index(drop=True)


def track_c(c: pd.DataFrame, *, n_boot: int = 10_000, seed: int = 20261017) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Cells (orchestrator x cell): bug-fixed rate with a bootstrap CI over tasks, regression rate with a
    Wilson CI, rounds and wall time; and each reviewer cell's paired difference in fixed rate vs `none`."""
    if c.empty:
        return pd.DataFrame(), pd.DataFrame()
    c = c.copy()
    c["fixed_n"] = c["bugs_fixed"].map(len)
    c["testable_n"] = c["bugs_testable"].fillna(c["bugs"]).astype(float)
    rng = np.random.default_rng(seed)
    cells = []
    for (o, cell), g in c.groupby(["orchestrator", "cell"]):
        fx, ts = g["fixed_n"].to_numpy(float), g["testable_n"].to_numpy(float)
        rate = fx.sum() / ts.sum() if ts.sum() else np.nan
        idx = rng.integers(0, len(g), size=(n_boot, len(g)))
        with np.errstate(invalid="ignore", divide="ignore"):
            boots = fx[idx].sum(1) / ts[idx].sum(1)
        reg = int(g["regression"].sum())
        rlo, rhi = wilson(reg, len(g))
        cells.append({"orchestrator": o, "cell": cell, "loops": len(g), "fixed_rate": rate, "fixed_lo": np.nanpercentile(boots, 2.5), "fixed_hi": np.nanpercentile(boots, 97.5),
                      "regression_rate": reg / len(g), "regression_lo": rlo, "regression_hi": rhi, "mean_review_rounds": float(g["review_rounds"].mean()), "median_wall_s": float(g["wall_s"].median())})
    # the same ratio of sums as fixed_rate, over the tasks both cells ran; the bootstrap resamples tasks in pairs
    diffs = []
    for o, g in c.groupby("orchestrator"):
        per_task = g.groupby(["cell", "task"])[["fixed_n", "testable_n"]].sum()
        if "none" not in per_task.index.get_level_values("cell"):
            continue
        base = per_task.loc["none"]
        for cell in sorted(set(g["cell"]) - {"none"}):
            h = per_task.loc[cell]
            tasks = sorted(set(h.index) & set(base.index))
            if not tasks:
                continue
            fh, th = h.loc[tasks, "fixed_n"].to_numpy(float), h.loc[tasks, "testable_n"].to_numpy(float)
            fb, tb = base.loc[tasks, "fixed_n"].to_numpy(float), base.loc[tasks, "testable_n"].to_numpy(float)
            idx = rng.integers(0, len(tasks), size=(n_boot, len(tasks)))
            with np.errstate(invalid="ignore", divide="ignore"):
                diff = fh.sum() / th.sum() - fb.sum() / tb.sum()
                boots = fh[idx].sum(1) / th[idx].sum(1) - fb[idx].sum(1) / tb[idx].sum(1)
            diffs.append({"orchestrator": o, "cell": cell, "tasks": len(tasks), "diff_vs_none": float(diff),
                          "lo": float(np.nanpercentile(boots, 2.5)), "hi": float(np.nanpercentile(boots, 97.5))})
    return pd.DataFrame(cells), pd.DataFrame(diffs)
