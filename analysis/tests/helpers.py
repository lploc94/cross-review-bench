"""Small invented score rows for unit tests."""

import pandas as pd


def bug(id, severity, difficulty="L1", category="logic", pooled=False):
    w = {"critical": 4, "high": 3, "medium": 2, "low": 1}[severity]
    return {"id": id, "weight": w, "severity": severity, "difficulty": None if pooled else difficulty, "category": None if pooled else category, "pooled": pooled}


def run(system, task, n, tp, valid, findings, bugs=(), found=(), *, kind="buggy", repo="r1", matched=0, loc_ok=0, false_alarm=None, wall_s=60.0):
    reviewer, config = system.split("-")
    return {
        "track": "A", "set": "final", "run_id": f"final/A/{config}/{reviewer}/{task}/{n}", "task": task, "repo": repo, "kind": kind, "language": "go",
        "reviewer": reviewer, "config": config, "system": system, "synthetic": kind != "realbug", "n": n,
        "tp_weight": tp, "pool_weight": sum(b["weight"] for b in bugs), "findings": findings, "valid": valid, "matched": matched,
        "matched_locations_ok": loc_ok, "verdict": "REVISE" if findings else "APPROVE", "false_alarm": false_alarm,
        "bugs_found": list(found), "bugs": list(bugs), "wall_s": wall_s, "loo_judge": None,
    }


def frame(rows):
    return pd.DataFrame(rows)
