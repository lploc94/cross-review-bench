"""Write tests/fixtures/scores.jsonl: an invented final set in the shape `crb score` writes.

Invented data only: repos alpha-ts, beta-py, gamma-go, delta-java; latent abilities per system.
Run: uv run --project analysis python analysis/tests/make_fixture.py
"""

import json
from pathlib import Path

import numpy as np

RNG = np.random.default_rng(424242)
REPOS = [("alpha-ts", "ts"), ("beta-py", "python"), ("gamma-go", "go"), ("delta-java", "java")]
CATEGORIES = ["logic", "boundary", "concurrency", "security", "data-integrity", "api-contract", "resource-leak", "performance"]
SEVERITY_WEIGHT = {"critical": 4, "high": 3, "medium": 2, "low": 1}
DIFF_FACTOR = {"L1": 1.0, "L2": 0.8, "L3": 0.55, "L4": 0.35}
# system: (detection ability, false-finding rate per run, median seconds)
SYSTEMS = {
    ("codex", "high"): (0.82, 0.6, 140), ("claude", "high"): (0.76, 0.9, 110), ("agy", "high"): (0.62, 1.4, 190),
    ("codex", "max"): (0.86, 0.6, 260), ("claude", "max"): (0.80, 0.8, 200),
}
JUDGES = ["codex", "claude", "agy"]
N = 3


def tasks():
    out = []
    for repo, lang in REPOS:
        for k in range(8):
            kind = "clean" if k == 6 else "decoy" if k == 7 else "buggy"
            nb = 0 if kind != "buggy" else 1 + int(RNG.random() < 0.35) + int(RNG.random() < 0.1)
            bugs = []
            for b in range(nb):
                sev = RNG.choice(list(SEVERITY_WEIGHT), p=[0.12, 0.38, 0.38, 0.12])
                bugs.append({"id": f"B{b + 1}", "weight": SEVERITY_WEIGHT[sev], "severity": str(sev), "difficulty": str(RNG.choice(list(DIFF_FACTOR))), "category": str(RNG.choice(CATEGORIES)), "pooled": False})
            if kind == "buggy" and k == 0:
                bugs.append({"id": "P1", "weight": 2, "severity": "medium", "difficulty": None, "category": None, "pooled": True})
            out.append({"task": f"{repo}-T{k + 1:02d}", "repo": repo, "language": lang, "kind": kind, "bugs": bugs})
    for i, (repo, lang) in enumerate(REPOS[:3]):
        out.append({"task": f"real-{i + 1:02d}", "repo": f"oss-{lang}", "language": lang, "kind": "realbug",
                    "bugs": [{"id": "B1", "weight": 3, "severity": "high", "difficulty": "L3", "category": "logic", "pooled": False}]})
    return out


def a_row(t, reviewer, config, n):
    ability, noise, secs = SYSTEMS[(reviewer, config)]
    found = [b["id"] for b in t["bugs"] if RNG.random() < ability * (DIFF_FACTOR.get(b["difficulty"], 0.5))]
    extra = int(RNG.poisson(noise))
    matched = len(found) + int(RNG.random() < 0.2 and len(found))  # sometimes the same bug twice
    findings = matched + extra
    valid = matched + int(RNG.binomial(extra, 0.3))
    tp = sum(b["weight"] for b in t["bugs"] if b["id"] in found)
    loc_ok = int(RNG.binomial(matched, 0.85))
    quiet = t["kind"] in ("clean", "decoy")
    loo = {}
    for j in JUDGES:
        drop = int(RNG.random() < 0.08 and valid)
        loo[j] = {"tp_weight": tp if not drop or not found else tp - next(b["weight"] for b in t["bugs"] if b["id"] == found[0]), "valid": valid - drop, "matched": matched - drop}
    return {
        "track": "A", "set": "final", "run_id": f"final/A/{config}/{reviewer}/{t['task']}/{n}", "task": t["task"], "repo": t["repo"], "kind": t["kind"],
        "reviewer": reviewer, "config": config, "model": "m", "effort": config, "n": n, "class": "ok",
        "tp_weight": tp, "pool_weight": sum(b["weight"] for b in t["bugs"]), "findings": findings, "valid": valid, "matched": matched,
        "matched_locations_ok": loc_ok, "verdict": "REVISE" if findings else "APPROVE", "false_alarm": (findings > valid) if quiet else None,
        "bugs_found": sorted(found), "bugs": t["bugs"], "wall_s": float(round(secs * RNG.lognormal(0, 0.35), 1)), "provisional": False,
        "language": t["language"], "loo_judge": loo,
    }


def main():
    rows = []
    ts = tasks()
    for t in ts:
        for (reviewer, config) in SYSTEMS:
            for n in range(1, N + 1):
                row = a_row(t, reviewer, config, n)
                rows.append(row)
                if config == "high" and t["kind"] in ("buggy", "decoy"):
                    scenario = "B4" if t["kind"] == "decoy" else ["B1", "B2", "B3"][n - 1]
                    flagged = bool(row["bugs_found"]) if t["kind"] == "buggy" else RNG.random() < 0.6
                    good = {"codex": 0.8, "claude": 0.7, "agy": 0.55}[reviewer]
                    rows.append({"track": "B", "set": "final", "run_id": row["run_id"], "task": t["task"], "repo": t["repo"], "kind": t["kind"], "reviewer": reviewer, "config": config, "n": n,
                                 "scenario": scenario, "outcome": bool(RNG.random() < good) if flagged else "n/a", "new_valid_round2": int(RNG.poisson(0.3)) if flagged else 0, "language": t["language"]})
    buggy = [t for t in ts if t["kind"] == "buggy"][:12]
    for o in ("claude", "codex"):
        for cell in ("codex", "claude", "agy", "none"):
            p = {"codex": 0.85, "claude": 0.8, "agy": 0.7, "none": 0.6}[cell]
            for t in buggy:
                planted = [b for b in t["bugs"] if not b["pooled"]]
                fixed = [b["id"] for b in planted if RNG.random() < p]
                rows.append({"track": "C", "set": "final", "run_id": f"final/C/high/{o}-{cell}/{t['task']}/1", "task": t["task"], "repo": t["repo"], "kind": "buggy", "orchestrator": o, "cell": cell, "class": "ok",
                             "bugs": len(planted), "bugs_testable": len(planted), "bugs_fixed": fixed, "fixed_weight": sum(b["weight"] for b in planted if b["id"] in fixed),
                             "testable_weight": sum(b["weight"] for b in planted), "regression": bool(RNG.random() < (0.1 if cell != "none" else 0.2)), "visible_ok": True,
                             "review_rounds": 0 if cell == "none" else int(RNG.integers(1, 4)), "sessions": 0 if cell == "none" else 1, "reviewers_used": [] if cell == "none" else [cell],
                             "wall_s": float(round(900 * RNG.lognormal(0, 0.3), 1)), "language": t["language"]})
    out = Path(__file__).parent / "fixtures" / "scores.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    print(f"{len(rows)} rows -> {out}")


if __name__ == "__main__":
    main()
