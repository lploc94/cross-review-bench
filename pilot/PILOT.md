# Pilot

Set `pilot`, run 2026-10-18: repos `ledger-ts` and `jobqueue-go` (32 tasks), Track A config `high`, N = 3, Track B second rounds included — 288 runs. Pilot data is excluded from the published results (I8). Reviewers appear as **X, Y and Z**; the labels were drawn at random by `pilot/blind.mjs`, and the map is kept in `~/.crbench/pilot-map.json`, unopened until Phase 22, so per-reviewer pilot results cannot steer the rest of the corpus.

Reproduce the numbers: `node pilot/blind.mjs --log ~/.crbench/logs/pilot-run.log` (measurements; also writes the blinded `~/.crbench/pilot-blind/scores.jsonl`) and `uv run --project analysis python pilot/variance.py ~/.crbench/pilot-blind/scores.jsonl` (variance and MDE).

## Runs

`crb run --set pilot --track A --config high --reviewers codex,claude,agy --tasks 'ledger-ts/*,jobqueue-go/*' --n 3`, concurrency codex 3, claude 3, agy 2: 288 planned, 288 archived, 5 h 24 min wall clock for the batch.

Wall time per run (both rounds), seconds:

| Label | Runs | Median | p95 | p99 | Max |
|---|---|---|---|---|---|
| X | 96 | 351 | 652 | 770 | 786 |
| Y | 96 | 205 | 375 | 530 | 772 |
| Z | 96 | 171 | 296 | 360 | 372 |

Every failure class, per label (archived runs):

| Label | ok | reviewer_timeout | reviewer_stall | reviewer_malformed | infra_exhausted | contaminated | Flagged attempts | Usage-limit pauses |
|---|---|---|---|---|---|---|---|---|
| X | 96 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Y | 96 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Z | 96 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Attempts: 296 for 288 runs. The 8 extra are `infra/turn_failed` on label X, each retried once and then `ok`; no other infra class occurred (0 `usage_limit`, 0 auth, 0 network). Infra-exhausted: 0 of 288 (AC-1 limit 2%).

Track B second rounds played (round 1 flagged the chosen bug or decoy): X 58, Y 66, Z 67 of 96.

Archives: 157 MB for the set; per run median 0.35 / 0.56 / 0.51 MB (X / Y / Z), max 0.87 MB. The final set (about 2,200 runs) needs about 1.2 GB.

## Grading

- Panel (`crb judge --set pilot`, the three contestants at `high`): 96 judge calls, 0 failed, 0 usage-limit pauses, 66 min.
- Audit queue: 4 inconsistent findings and the 20% sample (163 items; one item had both reasons) → 166 finding items, then 36 pool candidates grouped from 96 real unmatched findings → 202 items, all recorded by Claude Code auditors working on disjoint tasks (`crb audit-queue show <item>`, added for this).
- Finding audits: 148 real (88 matched a key item, 60 matched none), 18 not real.
- Pool audits: 30 confirmed pooled bugs (21 medium, 9 low), 2 candidates that were a planted bug the panel had not matched, 4 not real. The re-check of every other finding against the 30 pooled bugs credited 34 more findings, with no split.
- `crb score --set pilot`: 522 rows (288 Track A, 234 Track B), 0 provisional.

## Variance and minimum detectable effect

Primary metric F1 (config `high`, 32 tasks, 27 with a bug pool):

| Label | SD of F1_t across tasks | Run-to-run SD within a task | Share of the task-mean variance from the 3 runs |
|---|---|---|---|
| X | 0.370 | 0.112 | 3% |
| Y | 0.236 | 0.056 | 2% |
| Z | 0.191 | 0.136 | 17% |

Minimum detectable F1 difference (80% power, Holm-adjusted α over 3 pairs, bootstrap SE of the paired difference): 0.12–0.14 on the pilot's 32 tasks; scaled by √(32/144), **0.058–0.068 at 144 tasks** (X~Y 0.068, X~Z 0.067, Y~Z 0.058).

## Decisions

1. **Concurrency stays codex 3, claude 3, agy 2 (8 total).** No usage-limit pause and no infra fault attributable to load occurred in 5.4 hours; agy's quota is the smallest (user) and the pilot gives no reason to spend it faster.
2. **Round timeout stays 7,200 s (Track A/B).** The largest p99 is 770 s per run, both rounds included, well under half the limit (3,600 s).
3. **N = 3 suffices.** The runs contribute at most 17% of the variance of a task mean; going to N = 5 would shrink it by at most 7%, while more tasks shrink all of it. The detectable F1 difference at 144 tasks is about 0.06–0.07.

## What the audit showed about the corpus (for the final set)

These come from the audit, not from any reviewer's score, and are proposals for a user decision (see the Progress Log):

- **Clean and decoy tasks that are not clean.** Audits confirmed defects in 5 of the 10 tasks with no planted bug (3 clean and 2 decoy per repo) (jobqueue-go T12, T14, T16; ledger-ts T12, T13), mostly in code the PR adds (an unbounded readiness query, a schema that lets NUL through to Postgres, a test that hangs instead of failing, a README that contradicts the change). A finding that names one is real, so those tasks no longer measure false alarms as designed.
- **A defect in shared base code.** jobqueue-go's `decodeJSON` accepts a trailing `}` or `]`; it was pooled three times (T01, T08, T12) as one root cause.
- **Unplanted defects in buggy tasks.** 20 pooled bugs sit in buggy tasks next to the planted ones. Pooling credits them as designed, but each adds audit load and weight nobody chose.
- **Test-gap findings** split the auditors; the user ruled that a finding that only says tests are missing is not real unless it names a code defect (Decision 2026-10-18, now in `judge.md` and METHODOLOGY.md).
- **Round-2 claims that a correctly fixed bug persists** cannot be recorded as "not real, matches B<n>" (the tool refuses not_real with a bug match); auditors recorded them as not real with no match. Scores are unaffected: round-2 findings count only when valid.
