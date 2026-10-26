"""`python -m crb_analysis.report --scores results/scores.jsonl --out report/`

Computes every pre-registered statistic from the scores and writes the leaderboard (JSON and CSV),
markdown tables and figures. No network; all randomness comes from the seed.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import kendalltau

from . import figures, tables
from .bootstrap import N_BOOT, metric_cis, mde
from .bt import strengths
from .load import SEED, read_scores, system_order
from .metrics import loo_judge_rankings, loo_repo_rankings, pass_k, per_task_scores, recall_by, run_rates, task_matrix, track_b, track_c, unplanted
from .permute import N_PERM, holm, paired_test

PRIMARY_CONFIG = "high"
ALPHA = 0.05


def _clean(x):
    if isinstance(x, (np.floating, float)):
        return None if math.isnan(float(x)) else float(x)
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, np.bool_):
        return bool(x)
    return x


def build(scores_path, out, results=None, *, n_boot: int = N_BOOT, n_perm: int = N_PERM, seed: int = SEED) -> dict:
    out = Path(out)
    tdir, fdir = out / "tables", out / "figures"
    sc = read_scores(scores_path)
    a = sc.a
    syn = a[a["synthetic"]]
    real = a[~a["synthetic"]]
    systems = system_order(syn["system"])
    written: list[Path] = []

    # leaderboard: metrics with stratified bootstrap CIs, run rates, pass^k, Bradley-Terry
    tm = task_matrix(syn, systems)
    syn = syn[syn["task"].isin(tm.tasks)]  # a task some system lacks leaves every synthetic statistic
    lb = tm.metrics()
    cis = metric_cis(tm, n_boot, seed)
    for k, (lo, hi) in cis.items():
        lb[f"{k}_lo"], lb[f"{k}_hi"] = lo, hi
    lb = lb.merge(run_rates(syn), on="system").merge(pass_k(syn).rename(columns={"pass_all": "pass_all_k", "pass_any": "pass_any_k", "bugs": "pass_k_bugs", "bugs_short": "pass_k_bugs_short"}), on="system")
    _, _, f1_t, kept = per_task_scores(tm)
    strata = np.array([tm.repo[tm.tasks.index(t)] for t in kept], dtype=object)
    bt, (bt_lo, bt_hi) = strengths(f1_t, strata, n_boot, seed)
    lb["bt"], lb["bt_lo"], lb["bt_hi"] = bt, bt_lo, bt_hi
    lb["reviewer"] = [s.partition("-")[0] for s in lb["system"]]
    lb["config"] = [s.partition("-")[2] for s in lb["system"]]
    lb["tasks"] = len(tm.tasks)
    if not real.empty:
        rs = [s for s in systems if s in set(real["system"])]
        rtm = task_matrix(real, rs)
        # each real bug has a repository of its own, so its bootstrap is stratified by language instead
        lang = real.groupby("task")["language"].first()
        rtm = replace(rtm, repo=lang.loc[rtm.tasks].to_numpy(object))
        rm = rtm.metrics().set_index("system")
        rcis = metric_cis(rtm, n_boot, seed)
        for k in ("f1", "wrecall", "precision"):
            rlo, rhi = rcis[k]
            lb[f"realbug_{k}"] = [rm[k].get(s, np.nan) for s in lb["system"]]
            lb[f"realbug_{k}_lo"] = [dict(zip(rs, rlo)).get(s, np.nan) for s in lb["system"]]
            lb[f"realbug_{k}_hi"] = [dict(zip(rs, rhi)).get(s, np.nan) for s in lb["system"]]
        lb["realbug_tasks"] = len(rtm.tasks)
    lb = lb.sort_values("f1", ascending=False).reset_index(drop=True)
    lb.insert(0, "rank", range(1, len(lb) + 1))

    # pairwise tests on the primary config (F13): within-task permutation, Holm over the pairs, per metric
    prim = [s for s in systems if s.endswith(f"-{PRIMARY_CONFIG}")]
    ptm = task_matrix(syn, prim)
    pairs = [(i, j) for i in range(len(prim)) for j in range(i + 1, len(prim))]
    tests = []
    for metric in ("f1", "wrecall", "precision"):
        res = [paired_test(ptm, i, j, metric, n_perm=n_perm, seed=seed) for i, j in pairs]
        adj = holm([p for _, p in res]) if res else []
        for (i, j), (d, p), q in zip(pairs, res, adj):
            tests.append({"metric": metric, "a": prim[i], "b": prim[j], "diff": d, "p": p, "p_holm": q,
                          "winner": (prim[i] if d > 0 else prim[j]) if q < ALPHA else "none",
                          "mde": mde(ptm, i, j, metric, alpha=ALPHA, pairs=len(pairs), n_boot=n_boot, seed=seed)})
    tests = pd.DataFrame(tests)

    # consistency: real bugs vs synthetic (Kendall tau on F1), leave-one-repo-out, leave-one-judge-out
    tau = {"tau": None, "p": None, "systems": 0}
    if not real.empty and "realbug_f1" in lb:
        both = lb.dropna(subset=["realbug_f1"])
        if len(both) >= 3:
            t, p = kendalltau(both["f1"], both["realbug_f1"])
            tau = {"tau": _clean(t), "p": _clean(p), "systems": len(both)}
    loo_repo = loo_repo_rankings(syn, systems)
    loo_judge = loo_judge_rankings(syn, systems)

    # breakdowns
    langs = []
    for lang, g in syn.groupby("language"):
        m = task_matrix(g, systems).metrics()
        m.insert(0, "language", lang)
        langs.append(m)
    by_lang = pd.concat(langs, ignore_index=True) if langs else pd.DataFrame()
    rd, rc, rsev = recall_by(syn, "difficulty"), recall_by(syn, "category"), recall_by(syn, "severity")
    up = unplanted(syn)
    tb = track_b(sc.b)
    cells, diffs = track_c(sc.c, n_boot=n_boot, seed=seed)

    # outputs
    cols = ["rank", "system", "reviewer", "config", "tasks", "f1", "f1_lo", "f1_hi", "wrecall", "wrecall_lo", "wrecall_hi", "precision", "precision_lo", "precision_hi", "no_findings",
            "false_alarm_rate", "location_accuracy", "k", "pass_all_k", "pass_any_k", "pass_k_bugs", "pass_k_bugs_short", "median_wall_s", "median_output_tokens", "bt", "bt_lo", "bt_hi"]
    cols += [c for c in [f"realbug_{k}{e}" for k in ("f1", "wrecall", "precision") for e in ("", "_lo", "_hi")] + ["realbug_tasks"] if c in lb]
    board = lb[cols]
    payload = {
        "scores": str(scores_path), "seed": seed, "n_boot": n_boot, "n_perm": n_perm, "primary_config": PRIMARY_CONFIG, "alpha": ALPHA,
        "tasks": len(tm.tasks), "tasks_dropped": tm.dropped,
        "leaderboard": [{k: _clean(v) for k, v in r.items()} for r in board.to_dict("records")],
        "pairwise": [{k: _clean(v) for k, v in r.items()} for r in tests.to_dict("records")],
        "realbug_tasks_dropped": rtm.dropped if not real.empty else [],
        "kendall_tau_realbugs": tau,
        "loo_repo": [{"left_out": r["left_out"], "ranking": r["ranking"]} for _, r in loo_repo.iterrows()],
        "loo_judge": [{"left_out": r["left_out"], "ranking": r["ranking"]} for _, r in loo_judge.iterrows()],
        "unplanted": [{k: _clean(v) for k, v in r.items()} for r in up.to_dict("records")],
    }
    for d in [out] + ([Path(results)] if results else []):
        d.mkdir(parents=True, exist_ok=True)
        (d / "leaderboard.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        board.to_csv(d / "leaderboard.csv", index=False)
        written += [d / "leaderboard.json", d / "leaderboard.csv"]

    show = board.assign(**{"F1 [95% CI]": [f"{r.f1:.3f} {tables.ci(r.f1_lo, r.f1_hi)}" for r in board.itertuples()],
                           "wRecall [95% CI]": [f"{r.wrecall:.3f} {tables.ci(r.wrecall_lo, r.wrecall_hi)}" for r in board.itertuples()],
                           "Precision [95% CI]": [f"{r.precision:.3f} {tables.ci(r.precision_lo, r.precision_hi)}" for r in board.itertuples()],
                           "BT [95% CI]": [f"{r.bt:+.2f} {tables.ci(r.bt_lo, r.bt_hi, 2)}" for r in board.itertuples()]})
    show = show[["rank", "system", "F1 [95% CI]", "wRecall [95% CI]", "Precision [95% CI]", "false_alarm_rate", "location_accuracy", "pass_all_k", "pass_any_k", "BT [95% CI]", "median_wall_s", "median_output_tokens"]]
    written.append(tables.write(show, tdir / "leaderboard.md", "Leaderboard (synthetic corpus)", f"{len(tm.tasks)} tasks; bootstrap over tasks stratified by repo, {n_boot:,} resamples, seed {seed}. Precision is 1 for a system with no findings. pass^k / pass@k: share of pool bugs found in all / any of the k runs, over the tasks a system has all k runs of (the leaderboard JSON gives the bugs counted and those left out)."))
    if "realbug_f1" in board:
        real_show = pd.DataFrame({"system": board["system"]} | {
            f"{name} [95% CI]": [f"{v:.3f} {tables.ci(lo, hi)}" for v, lo, hi in zip(board[f"realbug_{k}"], board[f"realbug_{k}_lo"], board[f"realbug_{k}_hi"])]
            for k, name in (("f1", "F1"), ("wrecall", "wRecall"), ("precision", "Precision"))})
        written.append(tables.write(real_show, tdir / "realbugs.md", "Real-bug control set",
                                    f"{int(board['realbug_tasks'].iloc[0])} real bugs scored ({len(rtm.dropped)} left out: some system has no scored run on them); "
                                    f"bootstrap over tasks stratified by language, {n_boot:,} resamples, seed {seed}. "
                                    f"Kendall tau, synthetic vs real-bug F1: {tables.fmt(tau['tau'])} (p {tables.fmt(tau['p'])}, {tau['systems']} systems)."))
    written.append(tables.write(tests, tdir / "pairwise.md", f"Pairwise tests, config {PRIMARY_CONFIG}", f"Within-task permutation, {n_perm:,} permutations; Holm over {len(pairs)} pairs per metric; a winner needs Holm-adjusted p < {ALPHA}. MDE: minimum detectable difference at 80% power."))
    if not by_lang.empty:
        written.append(tables.write(by_lang, tdir / "by_language.md", "Metrics by language"))
    for name, d in [("difficulty", rd), ("category", rc), ("severity", rsev)]:
        piv = d.pivot_table(index="system", columns="group", values="wrecall").reindex(systems).reset_index()
        written.append(tables.write(piv, tdir / f"recall_by_{name}.md", f"Severity-weighted recall by {name}", "Pooled bugs carry no difficulty or category and appear as `pooled`."))
    written.append(tables.write(up, tdir / "unplanted.md", "Real defects outside the answer key", "Secondary metric: pooled bugs (confirmed by the audit, found by some reviewer) per system; found_any = found in at least one run; wrecall from per-task means over the k runs."))
    written.append(tables.write(tb, tdir / "track_b.md", "Track B: second round", "Rate = share of second rounds meeting the scenario's predicate; Wilson 95% CI; n/a runs had no round-1 issue on the bug or decoy."))
    if not cells.empty:
        written.append(tables.write(cells, tdir / "track_c.md", "Track C: cells", "Fixed rate: bugs whose hidden tests pass, bootstrap CI over loops; regression: visible tests fail, Wilson CI."))
        written.append(tables.write(diffs, tdir / "track_c_vs_none.md", "Track C: each review cell minus no review", "Fixed rate (fixed / testable bugs) of the cell minus that of no review, over the tasks both ran; bootstrap CI resampling those tasks in pairs."))
    written.append(tables.write(pd.DataFrame([{"left_out": r["left_out"], "ranking": r["ranking"]} for _, r in pd.concat([loo_repo, loo_judge]).iterrows()]),
                                tdir / "robustness.md", "Rankings by F1 with one repo or one judge left out",
                                f"Kendall tau, synthetic vs real-bug F1: {tables.fmt(tau['tau'])} (p {tables.fmt(tau['p'])}, {tau['systems']} systems)."))

    written += figures.leaderboard(lb, fdir)
    written += figures.precision_recall(lb, fdir)
    written += figures.recall_by_difficulty(rd, fdir, systems)
    written += figures.category_heatmap(rc, fdir, systems)
    if not tb.empty:
        written += figures.track_b(tb, fdir)
    if not cells.empty:
        written += figures.track_c(cells, fdir)
    written += figures.time_per_run(syn, fdir, systems)
    return {"written": [str(p) for p in written], "leaderboard": payload["leaderboard"], "pairwise": payload["pairwise"]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="crb_analysis.report", description=__doc__.splitlines()[0])
    ap.add_argument("--scores", required=True, help="scores.jsonl from `crb score`")
    ap.add_argument("--out", required=True, help="report directory: tables/, figures/, leaderboard.json/.csv")
    ap.add_argument("--results", help="also write leaderboard.json/.csv here (default: the scores file's directory when it is named results)")
    ap.add_argument("--n-boot", type=int, default=N_BOOT)
    ap.add_argument("--n-perm", type=int, default=N_PERM)
    args = ap.parse_args(argv)
    results = args.results
    if results is None and Path(args.scores).resolve().parent.name == "results":
        results = str(Path(args.scores).resolve().parent)
    res = build(args.scores, args.out, results, n_boot=args.n_boot, n_perm=args.n_perm)
    print(json.dumps({"written": len(res["written"]), "out": args.out, "results": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
