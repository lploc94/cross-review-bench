# Final run log

Counts only; the run archives stay in `~/.crbench/runs/final/`. Per-reviewer results are not shown here
before grading (I8).

## Track A (config `high`) with Track B

Config `max` was dropped for this release (user decision, 2026-10-24, quota); its partial runs were moved
out of the set and its ids out of `plan.json`.

| | Codex `gpt-6-astra` | Claude Code `claude-opus-5-5` | agy `gemini-4-argon` |
|---|---|---|---|
| Runs archived | 504 / 504 | 504 / 504 | 504 / 504 |
| Final class `ok` | 486 | 476 | 490 |
| `reviewer_malformed` | 0 | 0 | 1 |
| `contaminated` (two flagged attempts) | 18 | 28 | 13 |
| `infra_exhausted` | 0 | 0 | 0 |
| Runs dated | 2026-10-20 – 2026-10-25 | 2026-10-20 – 2026-10-21 | 2026-10-20 – 2026-10-24 |
| CLI | codex-cli 0.163.0 | Claude Code 2.1.301 | agy 1.4.3 (148), 1.4.4 (145), 1.4.6 (15), 1.4.7 (196) |

- `crb status --set final --complete --track A`: exit 0, 1512 planned, 1512 archived, 0 missing, 0 infra_exhausted.
- `crb audit --all --set final` (2026-10-25, whole set): exit 0, 65 runs contaminated (59 Track A, 6 Track C at the
  time), none open, none left to restore.
- Track B (round 2 on synthetic buggy and decoy tasks) rides on these runs: 1053 runs carry a Track B
  record, 851 ran round 2 and 202 had no round-1 issue overlapping a bug or decoy, so the scenario had no
  round 2.
- Upstream audit rule narrowed on 2026-10-25 (harness commit 7bcf4b5): 8 runs got their first clean attempt
  back as their result; contaminated went from 70 to 65.

## Track C (config `high`)

40 tasks × 2 orchestrators × 4 cells (reviewer `codex`, `claude`, `agy`, or `none`) = 320 loops, one each.

| Orchestrator → cell | Loops | `ok` | `contaminated` | Dated |
|---|---|---|---|---|
| Claude Code → codex | 40 | 39 | 1 | 2026-10-25 |
| Claude Code → claude | 40 | 34 | 6 | 2026-10-22 – 2026-10-24 |
| Claude Code → agy | 40 | 40 | 0 | 2026-10-22 – 2026-10-24 |
| Claude Code → none | 40 | 40 | 0 | 2026-10-22 – 2026-10-24 |
| Codex → codex | 40 | 39 | 1 | 2026-10-25 – 2026-10-26 |
| Codex → claude | 40 | 36 | 4 | 2026-10-25 – 2026-10-26 |
| Codex → agy | 40 | 40 | 0 | 2026-10-25 – 2026-10-26 |
| Codex → none | 40 | 40 | 0 | 2026-10-25 – 2026-10-26 |

- CLI: codex-cli 0.163.0, Claude Code 2.1.301, agy 1.4.4 (7 loops), 1.4.6 (8), 1.4.7 (65).
- `crb status --set final --complete --track C`: exit 0, 320 planned, 320 archived, 0 missing.
- `crb audit --all --set final` (2026-10-26, whole set): exit 0, 71 runs contaminated (59 Track A, 12 Track C),
  none open, none left to restore, none to rerun.
- Codex hit its usage limit several times (2026-10-25/26); the scheduler paused Codex and retried, and the
  user moved Codex to another Pro account on 2026-10-26 (same CLI, model and effort).
