# Calibration

Set `calibration`, run 2026-10-20: every synthetic task (144) and every real bug (24) reviewed once by `claude-sonnet-5-5` through Claude Code (Track A, config `high`, N = 1, Track B second rounds included), graded by a single `claude-sonnet-5-5` judge (F17). Calibration shares a vendor with a contestant, so it is a sanity check of the corpus only: it never decides which bug stays, and its data is excluded from the results (I8).

Reproduce: `crb run --set calibration --track A --config high --reviewers claude --model claude=claude-sonnet-5-5 --n 1`, `crb judge --set calibration`, `crb score --set calibration`. Archives are in `~/.crbench/runs/calibration/`, grading in `~/.crbench/grading/calibration/`.

## Runs

- 168 runs archived on cross-review 10.5.1, all `ok`.
  - Failures: 0 infra, 0 reviewer, 0 flagged, 0 contaminated, 0 usage-limit pauses.
  - Wall time per run (both rounds): median 85 s, p95 201 s, max 898 s.
- Verdicts: 127 REVISE, 41 APPROVE.
- Judging: 133 judge calls (the 35 runs without findings need none), 0 failed.

### The `ReportFindings` fault (cross-review 10.5.0)

The batch first ran on the pinned cross-review 10.5.0. In 12 of its 168 reviews, Claude Code called its built-in `ReportFindings` tool:
- That tool hands findings to the host application, so in `claude -p` neither the findings nor the verdict reached the event log the runner reads.
- 8 of the 12 runs ended without a verdict (`reviewer_malformed`): ledger-ts-T05, sync-ts-T13, workflow-java-T16 and 5 private tasks (one each in etl-py, jobqueue-go and uploads-ts, two in workflow-java).
- The other 4 (rb-go-ragflow-21119, rb-py-browser-harness-757 and 2 private gateway-go tasks) still wrote a verdict after the tool call.

cross-review 10.5.1 runs Claude Code with `--disallowedTools ReportFindings` for every user. The bench now pins it (F6, METHODOLOGY "Runs").
- The 12 runs were archived again on 10.5.1: 12 `ok` with a verdict, 0 `ReportFindings` calls.
- The first archives are kept apart in `~/.crbench/runs-calibration-v10.5.0/` and enter no number below.
- The other 156 calibration runs made no `ReportFindings` call. Their command line differs from 10.5.1 only by that flag, so they were not run again.

## Detection

A bug counts as found when a finding the panel (or the audit) calls real matches it. Rates are found / bugs.

Synthetic corpus, by difficulty:

| Difficulty | Found | Bugs | Rate |
|---|---|---|---|
| L1 | 27 | 29 | 93% |
| L2 | 43 | 44 | 98% |
| L3 | 45 | 47 | 96% |
| L4 | 23 | 24 | 96% |
| All | 138 | 144 | 96% |

Real bugs, by difficulty: L1 1/4, L2 6/11, L3 3/5, L4 0/4, all 10/24 (42%). By language: Go 1/6, Java 4/6, Python 3/6, TypeScript 2/6.

**Detection does not fall from L1 to L4 on the synthetic corpus**, against the expectation in METHODOLOGY. It is flat near the ceiling. The calibration reviewer found 138 of 144 planted bugs, so the difficulty labels do not separate what it finds. Only the real bugs show a fall, and their L4 cell has 4 bugs.

Following the pre-registered rule, no bug is dropped or relabelled for being easy. Consequences, disclosed in METHODOLOGY (Limitations):
- On the synthetic corpus, recall is likely to sit near the ceiling for the contestants too. The difference between them will then come mostly from precision (false findings), clean and decoy behaviour, location accuracy, Track B and Track C.
- Breakdowns by difficulty are reported, but with this calibration result they are descriptive, not a validated difficulty scale.
- The real-bug set, where detection is 42%, carries the question of whether the order holds on harder, unplanted defects.

By severity, all 168 bugs: critical 20/20, high 58/64, medium 55/62, low 15/22.

By category, synthetic buggy tasks:

| Category | Found / bugs |
|---|---|
| api-contract | 11/11 |
| boundary | 13/15 |
| concurrency | 13/14 |
| data-integrity | 19/19 |
| error-handling | 13/13 |
| logic | 14/15 |
| performance | 11/13 |
| resource-leak | 8/8 |
| security | 24/24 |
| spec-deviation | 12/12 |

The 6 synthetic bugs missed:

| Bug | Difficulty | Severity | Category |
|---|---|---|---|
| sync-ts-T08 B2 | L2 | low | performance |
| private task | L3 | medium | concurrency |
| private task | L3 | low | performance |
| private task (same task as the row above) | L1 | low | boundary |
| private task | L4 | high | logic |
| private task | L1 | low | boundary |

Bugs of private tasks are not named, so their answers stay unpublished (METHODOLOGY "Split"). Missing a bug is not a sign of ambiguity, and none of the 6 drew an unsettled verdict.

Location: of the 154 matched findings, 134 (87%) point within the matched bug's lines.

## Clean and decoy tasks

- A false alarm is a REVISE verdict with at least one finding that is not real. There were 4 on the 27 clean tasks and 3 on the 18 decoy tasks.
- On the clean and decoy tasks, the judge called 9 round-1 findings real. On a clean task that means the task may not be clean.
- Each of the 9 was verified against the code and handled as a corpus defect (see Corpus changes).

## Ambiguity audit

The calibration judge left 16 findings unsettled: 14 `inconsistent` (`not_real` while naming a bug) and 2 `uncertain`. The audit (Claude Code, F12) recorded a verdict with a written argument citing code for each.

| Item | Task | Finding | Audit |
|---|---|---|---|
| A8, A18 | etl-py-T07 | test gap only (round 2 and round 1) | not real |
| A40 | booking-java-T10 | test gap only | not real |
| A43 | jobqueue-go-T10 | test gap only | not real |
| A47 | uploads-ts-T11 | test gap only | not real |
| A46, A49 | 2 private tasks | test gap only | not real |
| A37, A41, A45 | 3 private tasks | round-2 status line, claim false in S1 | not real |
| A39 | private task (the A38 task) | round-2 status line pointing at A38 | not real |
| A15 | private task | a failure the reviewer predicted in round 2 | not real (no trigger in the application) |
| A42 | jobqueue-go-T09 | one aggregate per scrape remains (round 2) | not real (S1 meets the key; caching is optional in it) |
| A44 | rb-py-agents-7783 | expressive mode gated on the inference gateway | not real (gate is deliberate and documented in the PR) |
| A48 | workflow-java-T01 | `/tasks/decided` lists a delegate's decisions under the delegator | real, low, unplanted |
| A38 | private task | a bug's fix in the answer key contradicts the PR's own contract | real: a defect of the answer key, fixed (below) |

Notes:
- 7 of the 14 `inconsistent` items are findings that only say tests are missing. The judge linked each to the bug the test would catch while calling it not real. The rubric (METHODOLOGY "Grading") already says such a finding is judged on the code defect it names, if any.
- 4 are round-2 status lines with no body. The reviewer repeated a closed issue's title, and the claim is false in the fixed state.
- Neither pattern points to an ambiguous bug.
- The 20% audit sample (97 items) is not audited for calibration. It exists to measure the judges' agreement in the final set. Calibration scores with those items open are marked provisional, and the numbers above take the panel's verdict for those findings.
- A48 stays in the corpus as an unplanted defect. Pooling credits it in the final set if contestants report it.

## Corpus changes

Every change below went through the corpus fix workflow:
1. An Opus pass verified the claim with a probe, then fixed it.
2. A separate Opus re-audit checked the fix with real execution.
3. `crb validate --repo` passed for the repository.

No bug was dropped, and no rubric field changed except where noted.

**Answer key of a private task (A38).** The fix of one bug contradicted the contract the PR itself states.
- The fix now follows that contract; its hidden test asserts the contract's behaviour, fails on the PR and passes with the fix.
- The bug's summary and lines were updated to match.
- The wrong fix, the false rebuttal and the rubric fields are unchanged.
- The task is private, so its details stay unpublished.

**Clean and decoy tasks: all 9 real findings were real defects introduced by the PR, and each was removed from `pr.patch`.** The decoys stay as planted. Defects in private tasks are given by category and severity only.

| Task | Kind | Defect | Change |
|---|---|---|---|
| sync-ts-T14 | clean | a connection reset during the first export page crashed the process (error listener attached late) | listener attached right after checkout; visible test with a TCP proxy reset |
| sync-ts-T14 | clean | the `timeoutMs` option doc was wrong for exports | doc corrected |
| gateway-go-T12 | clean | the README `tls` text omitted the https-only rule and broke a paragraph | README corrected |
| gateway-go-T12 | clean | `min_version` `""` and `"1.2"` gave different transport keys | key hashes the resolved version; test added |
| gateway-go-T16 | decoy | `passive_health.ejection` capped at 10 min, contrary to the README | cap removed (positive only) |
| private task | clean | data-integrity, medium | removed from the PR; visible test added |
| private task | clean | logic (ordering), low | removed from the PR; visible test added |
| private task | decoy | a code comment made wrong by the PR, low | comment corrected; the decoy's lines unchanged |
| private task | decoy | concurrency, medium | removed from the PR; tests added |

The earlier audits of these 45 quiet tasks had missed these 9 defects in 7 tasks. Most are low severity, but three are medium (sync-ts-T14 and two private tasks). This is the main corpus result of calibration.
- The final set's pooling (F12) remains the safeguard for any defect still left.
- A real, unmatched finding on a clean or decoy task that the pool audit confirms becomes a pooled bug of that task, so a reviewer that reports it is credited instead of counted as a false alarm.

The re-audit of the gateway-go fixes and of one private task's fix found 5 more minor issues, and a second pass fixed all of them. A further re-audit then found nothing new. The 5 issues:
- the TLS transport key did not frame each file;
- `check-routes` did not read the TLS files;
- the T16 decoy's hidden test claimed more than it checked;
- two in the private task's fix: a visible test could hang, and an error status differed from the API's own.

Commits: corpus `88f4cbccc` (the answer key, sync-ts, uploads-ts, ledger-ts) and `b9b7bfaa8` (gateway-go, authz-py).

## Other observations

- **`rb-java-ozone-10988`** loads the Develocity Maven extension 2.5.0, which fails under the host's Maven 3.10.0 before any build step (Maven 3.9.11 fails too, resolving the extension). The project's tests run only with `MAVEN_BASEDIR` set. The calibration reviewer reviewed it by reading and approved; its bug was missed. Disclosed as limitation 11, not changed: every reviewer gets the same environment.
- **`reviewer_malformed`**: on 10.5.1, none. All 8 on 10.5.0 came from `ReportFindings` (above).
