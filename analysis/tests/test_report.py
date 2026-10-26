"""End to end: the report on the invented fixture writes the leaderboard, tables and figures."""

import json
import shutil
from pathlib import Path

import pytest

from crb_analysis import report

FIXTURE = Path(__file__).parent / "fixtures" / "scores.jsonl"
FIGURES = ["leaderboard", "precision_recall", "recall_by_difficulty", "category_heatmap", "track_b", "track_c", "time_per_run"]
TABLES = ["leaderboard", "pairwise", "by_language", "recall_by_difficulty", "recall_by_category", "recall_by_severity", "track_b", "track_c", "track_c_vs_none", "robustness", "unplanted", "realbugs"]


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("report")
    res = report.build(FIXTURE, out, n_boot=200, n_perm=200)
    return out, res


def test_writes_leaderboard_tables_and_figures(built):
    out, res = built
    for name in TABLES:
        assert (out / "tables" / f"{name}.md").stat().st_size > 0, name
    for name in FIGURES:
        for ext in ("png", "svg"):
            assert (out / "figures" / f"{name}.{ext}").stat().st_size > 0, f"{name}.{ext}"
    lb = json.loads((out / "leaderboard.json").read_text())
    assert lb["n_boot"] == 200 and lb["seed"] == 20261017
    systems = [r["system"] for r in lb["leaderboard"]]
    assert sorted(systems) == ["agy-high", "claude-high", "claude-max", "codex-high", "codex-max"]
    f1 = [r["f1"] for r in lb["leaderboard"]]
    assert f1 == sorted(f1, reverse=True) and [r["rank"] for r in lb["leaderboard"]] == [1, 2, 3, 4, 5]
    for r in lb["leaderboard"]:
        assert r["f1_lo"] <= r["f1"] <= r["f1_hi"]
        assert r["realbug_tasks"] == 3
        assert r["pass_k_bugs"] + r["pass_k_bugs_short"] > 0 and r["pass_k_bugs_short"] >= 0
        for k in ("f1", "wrecall", "precision"):
            assert r[f"realbug_{k}_lo"] - 1e-12 <= r[f"realbug_{k}"] <= r[f"realbug_{k}_hi"] + 1e-12, (r["system"], k)
    # three pairs of the primary config, per metric, Holm-adjusted p never below the raw p
    assert len(lb["pairwise"]) == 9
    assert all(p["p_holm"] >= p["p"] and p["a"].endswith("-high") for p in lb["pairwise"])
    assert {r["left_out"] for r in lb["loo_judge"]} == {"none", "judge:codex", "judge:claude", "judge:agy"}
    assert [r["system"] for r in lb["unplanted"]] == ["codex-high", "claude-high", "agy-high", "codex-max", "claude-max"] and all(r["pooled_bugs"] == 4 for r in lb["unplanted"])
    assert (out / "leaderboard.csv").read_text().splitlines()[0].startswith("rank,system,")
    assert len(res["written"]) == len(set(res["written"]))


def test_same_seed_same_numbers(built, tmp_path):
    out, _ = built
    report.build(FIXTURE, tmp_path, n_boot=200, n_perm=200)
    assert json.loads((tmp_path / "leaderboard.json").read_text())["leaderboard"] == json.loads((out / "leaderboard.json").read_text())["leaderboard"]


def test_results_default_is_the_scores_directory_named_results(tmp_path, capsys):
    results = tmp_path / "results"
    results.mkdir()
    shutil.copy(FIXTURE, results / "scores.jsonl")
    assert report.main(["--scores", str(results / "scores.jsonl"), "--out", str(tmp_path / "rep"), "--n-boot", "50", "--n-perm", "50"]) == 0
    assert json.loads(capsys.readouterr().out)["results"] == str(results.resolve())
    assert (results / "leaderboard.json").exists() and (tmp_path / "rep" / "leaderboard.json").exists()

    # any other directory: only --out, unless --results names one
    other = tmp_path / "elsewhere"
    other.mkdir()
    shutil.copy(FIXTURE, other / "scores.jsonl")
    assert report.main(["--scores", str(other / "scores.jsonl"), "--out", str(tmp_path / "rep2"), "--n-boot", "50", "--n-perm", "50"]) == 0
    assert json.loads(capsys.readouterr().out)["results"] is None
    assert not (other / "leaderboard.json").exists()
    assert report.main(["--scores", str(other / "scores.jsonl"), "--out", str(tmp_path / "rep3"), "--results", str(tmp_path / "pub"), "--n-boot", "50", "--n-perm", "50"]) == 0
    assert (tmp_path / "pub" / "leaderboard.csv").exists()


def test_a_task_some_system_lacks_is_left_out_of_every_synthetic_statistic(tmp_path):
    import pandas as pd

    rows = [json.loads(line) for line in FIXTURE.read_text().splitlines()]
    # codex-max did not run alpha-ts-T01: that task leaves the leaderboard, the pairwise tests and the breakdowns
    rows = [r for r in rows if not (r["track"] == "A" and r["task"] == "alpha-ts-T01" and r["reviewer"] == "codex" and r["config"] == "max")]
    # output tokens: every third Track A row has no usage report (null), which the median leaves out
    for i, r in enumerate(x for x in rows if x["track"] == "A"):
        r["output_tokens"] = None if i % 3 == 0 else 1000 + 37 * i
    scores = tmp_path / "scores.jsonl"
    scores.write_text("".join(json.dumps(r) + "\n" for r in rows))
    report.build(scores, tmp_path / "rep", n_boot=50, n_perm=50)
    lb = json.loads((tmp_path / "rep" / "leaderboard.json").read_text())
    assert lb["tasks_dropped"] == ["alpha-ts-T01"]
    f1 = {r["system"]: r["f1"] for r in lb["leaderboard"]}
    for p in lb["pairwise"]:
        if p["metric"] == "f1":
            assert abs(p["diff"] - (f1[p["a"]] - f1[p["b"]])) < 1e-9, p
    kept = [r for r in rows if r["track"] == "A" and r["task"] != "alpha-ts-T01" and not r["task"].startswith("real-")]
    for r in lb["leaderboard"]:
        mine = pd.DataFrame([x for x in kept if f"{x['reviewer']}-{x['config']}" == r["system"]])
        assert r["median_wall_s"] == float(mine["wall_s"].median()), r["system"]
        assert r["median_output_tokens"] == float(mine["output_tokens"].dropna().median()), r["system"]


def test_real_bug_intervals_resample_within_language_not_repo(tmp_path):
    # every real bug comes from its own repository, so a per-repo stratum holds one task and a bootstrap
    # within it would always draw the same task: a zero-width interval
    rows = [json.loads(line) for line in FIXTURE.read_text().splitlines()]
    for r in rows:
        if r.get("kind") == "realbug":
            r["language"] = "go"  # the fixture's real bugs, one per language, become one language with three
            r["repo"] = f"rb-go-{r['task']}"
    # one system has no scored run on one real bug: it leaves the real-bug statistics and is reported
    rows = [r for r in rows if not (r["track"] == "A" and r["task"] == "real-01" and r["reviewer"] == "agy")]
    scores = tmp_path / "scores.jsonl"
    scores.write_text("".join(json.dumps(r) + "\n" for r in rows))
    report.build(scores, tmp_path / "rep", n_boot=200, n_perm=50)
    lb = json.loads((tmp_path / "rep" / "leaderboard.json").read_text())
    assert lb["realbug_tasks_dropped"] == ["real-01"]
    for r in lb["leaderboard"]:
        assert r["realbug_f1_lo"] <= r["realbug_f1"] <= r["realbug_f1_hi"], r["system"]
    # codex's per-task results differ between the two kept real bugs, so its interval has width
    codex = next(r for r in lb["leaderboard"] if r["system"] == "codex-high")
    assert codex["realbug_f1_hi"] - codex["realbug_f1_lo"] > 0
