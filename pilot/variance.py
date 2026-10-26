"""Pilot variance on the blinded scores (labels X/Y/Z): per-task SD of F1_t, run-to-run SD within a
task, the share of the task-mean variance that comes from the k runs, and the minimum detectable
F1 difference now and scaled to the planned task count.

uv run --project analysis python pilot/variance.py ~/.crbench/pilot-blind/scores.jsonl [--tasks 144]
"""

import argparse
import json
import math

import numpy as np

from crb_analysis.bootstrap import mde
from crb_analysis.load import read_scores
from crb_analysis.metrics import f1, per_task_scores, precision, task_matrix, wrecall


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("scores")
    ap.add_argument("--tasks", type=int, default=144, help="planned synthetic task count")
    args = ap.parse_args(argv)
    a = read_scores(args.scores).a
    syn = a[a["synthetic"]]
    systems = sorted(set(syn["system"]))
    tm = task_matrix(syn, systems)
    _, _, f1_t, kept = per_task_scores(tm)
    out = {"tasks": len(tm.tasks), "tasks_with_bugs": len(kept), "dropped": tm.dropped, "systems": {}}
    for i, s in enumerate(systems):
        runs = syn[syn["system"] == s].copy()
        runs["f1_run"] = [float(f1(precision(v, f), wrecall(tp, w))) if w > 0 else np.nan
                          for tp, w, v, f in zip(runs["tp_weight"], runs["pool_weight"], runs["valid"], runs["findings"])]
        by_task = runs[runs["pool_weight"] > 0].groupby("task")["f1_run"]
        k = float(by_task.size().mean())
        within = float(by_task.var(ddof=1).mean())  # run-to-run variance inside a task
        between = float(np.nanvar(f1_t[i], ddof=1))  # variance of the per-task F1 across tasks
        out["systems"][s] = {"f1_t_sd": math.sqrt(between), "run_sd_within_task": math.sqrt(within), "k": k,
                             "share_from_runs": (within / k) / between if between else None}
    pairs = [(i, j) for i in range(len(systems)) for j in range(i + 1, len(systems))]
    scale = math.sqrt(len(tm.tasks) / args.tasks)
    out["mde_f1"] = {f"{systems[i]}~{systems[j]}": {"pilot": (m := mde(tm, i, j, "f1", pairs=len(pairs))), f"at_{args.tasks}_tasks": m * scale} for i, j in pairs}
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
