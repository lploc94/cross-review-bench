# crb_analysis

Computes the pre-registered statistics, tables and figures (METHODOLOGY.md, Metrics and Statistics) from the scores `crb score` writes. No network; every random draw comes from the seed.

## Commands

```bash
uv run --project analysis pytest -q                                   # tests (about 5 s)
uv run --project analysis python -m crb_analysis.report \
  --scores results/scores.jsonl --out report/                         # the report
uv run --project analysis python analysis/tests/make_fixture.py       # regenerate the invented fixture
```

Options: `--n-boot` (default 10,000) and `--n-perm` (default 10,000); `--results <dir>` also writes `leaderboard.json` and `.csv` there. Without `--results`, the scores file's directory gets them when it is named `results`, so the command above updates `results/leaderboard.*`; a scores file anywhere else (the fixture) writes only to `--out`.

## Input

`scores.jsonl` of the `final` set, one row per run:

- Track A: `task`, `repo`, `language`, `kind` (`buggy`, `clean`, `decoy`, `realbug`), `reviewer`, `config`, `n`, `class`, `tp_weight`, `pool_weight`, `findings`, `valid`, `matched`, `matched_locations_ok`, `false_alarm`, `bugs_found`, `bugs` (`id`, `weight`, `severity`, `difficulty`, `category`, `pooled`), `wall_s`, `loo_judge` (per left-out judge: `tp_weight`, `valid`, `matched`).
- Track B: `scenario` (`B1`–`B4`), `outcome` (`true`, `false`, `n/a`), `new_valid_round2`.
- Track C: `orchestrator`, `cell` (a reviewer or `none`), `bugs_testable`, `bugs_fixed`, `fixed_weight`, `testable_weight`, `regression`, `review_rounds`, `wall_s`.

A system is `<reviewer>-<config>`. Synthetic tasks are every kind but `realbug`.

## Statistics

- Metrics from per-task means over the k runs: wRecall = Σ tp_t / Σ w_t, precision = Σ v_t / Σ f_t (1 with no findings), F1. Only tasks every compared system ran count; the rest are listed as `tasks_dropped`.
- 95% CIs: percentile bootstrap over tasks stratified by repo, seed 20261017.
- Pairwise tests on config `high`: permutation that swaps the two systems' labels within each task; Holm over the three pairs, per metric (F1, wRecall, precision). MDE = (z₁₋α/(2·pairs) + z₀.₈) × bootstrap SE of the paired difference.
- Bradley–Terry (MM) on per-task F1 wins over tasks with w_t > 0, ties half a win, bootstrap CI.
- pass^k / pass@k: share of bugs found in all / any of the k runs.
- Track B: rate per scenario with Wilson CIs (`n/a` runs excluded). Track C: fixed rate per cell with a bootstrap CI over loops, regressions with Wilson CIs, and each review cell's fixed rate minus `none`'s over the tasks both ran, with a bootstrap CI that resamples those tasks in pairs.
- Secondary: real defects outside the answer key (pooled bugs) per system — how many, how many found in at least one run, and the weighted recall over them.
- Robustness: Kendall τ between synthetic and real-bug F1; rankings with one repo left out, and with one judge left out (the two remaining judges decide, on the panel and on the pooled-bug re-checks, whose per-judge votes `recheck.json` keeps; when they disagree the finding is not valid and matches nothing unless an audit settled it).

## Output

- `<out>/leaderboard.json` and `.csv` (and in the results directory, see above): ranked systems with F1, wRecall, precision and their CIs, false-alarm rate, location accuracy, pass^k/pass@k, median wall time, Bradley–Terry strength, real-bug F1; plus pairwise tests, Kendall τ and the leave-one-out rankings.
- `<out>/tables/*.md`: leaderboard, pairwise, by_language, recall_by_{difficulty,category,severity}, track_b, track_c, track_c_vs_none, robustness, unplanted.
- `<out>/figures/*.png` and `.svg`: leaderboard, precision_recall, recall_by_difficulty, category_heatmap, track_b, track_c, time_per_run. Static, light background; reviewers keep one colour each and the config is the marker shape (circle `high`, diamond `max`) and line style; values are labelled and every figure has a table.

`tests/fixtures/scores.jsonl` is invented data (repos alpha-ts, beta-py, gamma-go, delta-java), not results.
