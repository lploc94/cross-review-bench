# Cross-Review Bench — Methodology

This is the pre-registration of Cross-Review Bench. It is frozen at bench tag `prereg-v1`, together with corpus tag `corpus-v1`, before any final run. The analysis follows this text. Any later change to the corpus, the prompts, the harness's scoring or the analysis is listed in the report under "Deviations from pre-registration", with its reason.

## Question and contestants

Which AI code reviewer finds the defects in a pull request best, when driven through the `cross-review` tool (pinned release `v10.5.1`, commit `2dd22c9c388aadb98cc8a192ab2bc748e882a0dc`)? There are three contestants, each a reviewer CLI with one model:

| Reviewer | CLI | Model | Config `high` | Config `max` |
|---|---|---|---|---|
| `codex` | OpenAI Codex CLI | `gpt-6-astra` | effort `high` | effort `max` |
| `claude` | Claude Code | `claude-opus-5-5` | effort `high` | effort `max` |
| `agy` | Google Antigravity CLI | `gemini-4-argon` | effort `high` | — (its highest level is `high`; the report shows its `high` row next to the other `max` rows) |

A **system** is one reviewer at one config, so there are five systems. The primary comparison is the three systems at config `high`.

## Corpus

**Synthetic corpus** (repository `cross-review-bench-corpus`, tag `corpus-v1`). It holds 9 production-grade repositories, written for the benchmark:
- TypeScript: `ledger-ts`, `uploads-ts`, `sync-ts`;
- Python: `authz-py`, `etl-py`;
- Go: `jobqueue-go`, `gateway-go`;
- Java: `booking-java`, `workflow-java`.

Each repository has 16 tasks, so there are 144 in all. A task is the repository at its clean main branch plus one pull request, applied as uncommitted changes, with the pull request's title and description. Each repository's tasks are:
- 11 **buggy** tasks carrying 16 planted bugs: 7 tasks with one bug, 3 with two, 1 with three;
- 3 **clean** tasks;
- 2 **decoy** tasks. A decoy holds code that looks wrong but is correct.

Every planted bug has:
- a location (file and lines);
- a category, severity and difficulty;
- a summary and a trigger;
- a hidden test, which fails on the pull request for the bug's own reason and passes after the bug's correct fix, unless a written justification says why no test can show the bug;
- the correct fix;
- a plausible wrong fix, which is partial and leaves the hidden test failing;
- a plausible false rebuttal, which can be refuted from a named file of the repository.

A decoy has a hidden test that passes on the pull request, and a valid rebuttal that the repository proves. Clean tasks have hidden tests that pass.

Difficulty levels:
- L1: the defect is visible within the diff hunk;
- L2: it needs another file of the repository;
- L3: it needs an invariant or runtime behaviour, such as concurrency, transactions or caching;
- L4: it needs running code or domain knowledge, such as money rounding, time zones or Unicode.

Severity weights are critical 4, high 3, medium 2 and low 1. Every required category has at least 8 bugs across the corpus. The categories are logic, boundary, error-handling, concurrency, resource-leak, data-integrity, security, performance, spec-deviation (the pull request does not do what its description says) and api-contract.

The per-repository targets are difficulty L1 3 / L2 5 / L3 5 / L4 3 and severity critical 2 / high 6 / medium 6 / low 2. Rubric fields follow the evidence, not the targets. When an audit proved a field wrong, the field was corrected even where that broke a repository's target, and no other bug was re-rated to compensate. At `corpus-v1` three repositories deviate (limitation 10): `gateway-go` (difficulty 3/4/6/3, severity 3/5/7/1), `booking-java` (difficulty 4/6/4/2, severity 3/6/4/3) and `workflow-java` (difficulty 4/4/7/1, severity on target). Pull requests never change dependencies, and their text contains no hint words.

**Oracles.** `crb validate` proves every task by execution:
- V1: the base's visible tests pass.
- V2: the pull request applies, and its visible tests, typecheck and lint pass.
- V3 and V4: each hidden test fails on the pull request and passes with its fix, and all fixes together keep everything green.
- V5: each wrong fix leaves its hidden tests failing.
- V6: clean and decoy hidden tests pass.
- V7: each bug lies in lines the pull request adds or changes.
- V8: no hint words.
- V9: the schema is valid.

`crb repo-check` proves each base repository is production-grade (size, layers, migrations, configuration, structured logging, typed errors, README, no bench words) and that its tests, typecheck and lint pass; `crb validate --repo <repo> --stats` reports its rubric distributions. Both run offline, after one online dependency fill (`crb cache warm`), against a local Postgres 17 and Redis 7.

**Authoring and audit.** Claude Code wrote the corpus. Each task was audited by a model that did not write it, and a task's planted bugs, decoys and clean code were checked by real execution. Most authoring and audits ran on Claude Opus 5.5. Part of the work ran on Claude Haiku 5.5, because a subagent default was found late:
- authoring of `gateway-go`;
- the base builds of `booking-java` and `workflow-java`;
- several audits and one fix pass.

Every part that Haiku 5.5 wrote or last audited was audited again by Opus 5.5 before `corpus-v1`. The audits looked for unplanted real defects as well. Clean and decoy tasks contain none at `corpus-v1`. An unplanted defect found in a buggy task was left in place for pooling (see Grading).

**Split.** `crb split` splits each repository 8 public and 8 private (`splits.json`, seed `20261017`):
- each task kind is split in half, in the order of SHA-256 of `seed:task id`;
- an odd kind's extra task goes to the side that keeps the repository at 8 and 8, chosen by the same seeded order;
- every real bug is public.

The release bundle carries the public tasks with their answer keys. Private tasks stay unpublished, so the benchmark can be re-run on them later without their answers having been seen. Results are computed over all tasks.

## Runs

**Environment.** Every run gets a fresh, clean profile: a new `HOME` that holds only each CLI's login material. That means a copy of the Codex `auth.json`, the account fields of Claude Code's `.claude.json` (connectors and synced skills switched off), Antigravity's login files, and a link to the macOS Keychain. The profile holds no user skills, MCP servers, plugins, global instructions or memory.

Reviewers run vanilla: only their CLI's built-in tools, web search included. The one exception is Claude Code's `ReportFindings` tool, which cross-review leaves out from release 10.5.1 on. That tool hands findings to the host application, so in `claude -p` neither the findings nor the verdict reach the event log the runner reads. In calibration, 12 of 168 Claude Code reviews used it, and 8 of them ended without a verdict. Every release from 10.5.1 runs Claude Code this way for every user, so the contest measures the product as shipped (see Calibration). If Codex refreshes its token inside a copy, the refreshed `auth.json` is written back to the user's profile, after a backup. The harness never logs in and never changes any other part of the user's profile.

The workspace is a fresh copy of the repository with the pull request applied, under an opaque directory name `/tmp/crw/<8 hex>/` that gives no hint of the task or reviewer. Each run gets its own Postgres database and Redis logical database, plus the shared dependency caches and JDK 21, so the reviewer can run the project's tests. Answer material never enters a workspace or a prompt: hidden tests, fixes, wrong fixes, rebuttals and `task.json`.

**Review entry.** Each run calls the pinned runner exactly as the `review-impl` skill does:

```
review-runner.js begin --skill review-impl --mode working-tree --reviewer R --model M --effort E --timeout 7200
```

The input is `USER_REQUEST` (the pull request's title and description) and `OUTPUT_FORMAT` (the pinned skill's output format). Then `wait` runs until the round ends. The reviewer runs in cross-review's full-access mode and may run tests, builds and network commands. The prompt forbids it to change files. Findings are the round's parsed ISSUE blocks.

**Sets and repetitions.** The set `final` runs:
- Track A at configs `high` (codex, claude, agy) and `max` (codex, claude);
- on all 144 synthetic tasks and all 24 real bugs;
- N = 3 runs each, so 168 × 5 × 3 = 2,520 runs.

Track B rides on the config-`high` runs of synthetic buggy and decoy tasks (see Track B). Track C runs 320 loops (see Track C).

A run's id is `final/<track>/<config>/<reviewer>/<task>/<n>`. A batch can be re-launched safely: finished runs are skipped. The sets `smoke`, `pilot` and `calibration` have archives of their own and never enter the results.

**Concurrency and limits** (measured in the pilot, `pilot/PILOT.md`):
- **Concurrency:** codex 3, claude 3 and agy 2 runs at a time, the same for every task. Queue order cannot change a run's own wall time.
- **Round deadline:** 7,200 s. The pilot's largest p99 was 770 s, with both rounds included.
- **Stall:** a reviewer with no output for about 3 minutes is stalled.
- **Usage limits:** a usage limit pauses only that reviewer's queue, for 30 minutes, doubling up to 4 hours.
- **Disk:** a batch does not start with less than 20 GB of free disk.

**Failures.**
- **Infra failures** are retried, up to 3 times per run, and never scored. They are: a missing CLI; a runner error before the reviewer started; auth; a usage limit; the network; a reviewer process that died.
- **Reviewer failures** are scored as a run with no findings:
  - a round that hit its deadline or stalled, after one retry;
  - a round that completed without a verdict.

  Their counts are reported per reviewer.
- A run that still has an infra failure after its retries is re-launched until none is left.

**Leakage audit.** After every run the harness reads the reviewer's event log, every tool input and every command, and flags any access outside the run:
- the user's real home (apart from read-only toolchain folders);
- other runs' directories;
- the Keychain;
- other `/Users` or `/Volumes` paths;
- for real bugs, the upstream repository named in any tool input, web searches included.

A flagged run is discarded (archived apart) and run again. A run flagged twice is recorded as **contaminated** and left out of every score. Flagged and contaminated counts are reported per reviewer.

**Recorded per run:** the pinned runner, the corpus commit, each CLI's `--version`, the model and effort, the wall time, the failure class, the verdict and the session. A CLI version that changes during a batch is reported.

## Grading

Every finding is graded the same way, whoever reported it, and the graders never learn who that was.

**Findings.** A finding is one ISSUE block of a run that completed with a verdict: round 1 of every scored Track A run, plus the round-2 findings of Track B runs whose second round completed. Each is reduced to its category, severity, location, title, problem, evidence and suggested fix. Locations become workspace-relative `file:lines` (Markdown and `file://` links included); the run's workspace path, issue numbers and the verdict are removed. Within a task the findings of the whole set are shuffled with seed `20261017` and named `F1`, `F2`, …; which run, reviewer, config, round and scenario each came from is kept apart, in a mapping that only scoring and the audit sample read.

**The panel.** For each task, each judge gets one call: the task's workspace (base plus pull request, read-only), the title and description, the answer key — the planted bugs with their location, severity, summary and trigger, the decoys with why they are correct, and any confirmed pooled bugs — and every finding of the set for that task. A round-2 finding is shown with the state it was raised against: the patch the harness applied after round 1, or the unchanged code after a rebuttal. For each finding the judge answers which answer-key items it describes (`matches`) and whether it is a real defect caused or relied on by the pull request (`real`, `not_real` or `uncertain`), as one JSON object checked against a schema; an answer that fails the check is asked again, up to three calls, and then counts as no answer. The judges run like reviewers: a clean profile, the pinned cross-review's read-only mode, and a call that reads outside its workspace is discarded and asked again.

In the pilot and final sets the panel is the three contestants at `high`. A finding's validity is the majority of the judges that answered; so is each match. A tie, a majority for `uncertain`, a `not_real` majority that still matches a bug, or fewer than two answers once every judge has been asked sends the finding to the audit; a later panel that settles it withdraws the item. A finding that matches a decoy is not real, whatever the votes said. A finding is real when it describes a defect in the code of its state that the pull request introduces or that the changed code relies on — one a competent maintainer would fix before merging; a defect in a test or document the pull request adds counts, a finding that only says tests are missing does not (it is judged on the code defect it names, if any). Judges and the auditor apply the same rule. Smoke and calibration sets use `claude-sonnet-5-5` alone.

**Pooling.** A finding the panel calls real that matches no answer-key item may be a defect nobody planted. Such findings of a task are grouped by a helper (`claude-sonnet-5-5`) into candidate defects, each with a location, severity and summary, and every candidate goes to the audit. A confirmed candidate becomes a pooled bug `P1`, `P2`, … of that task with the same standing as a planted bug: its weight joins the task's pool for every reviewer, and every other finding of the task in its file (or naming no file) goes back to the panel with that pooled bug as the only answer-key item, so each reviewer that found it is credited. A pooled bug is found by the findings of its own group and by those the re-check matches by majority; a split re-check goes to the audit.

**The audit.** Claude Code audits every finding the panel could not settle, every pooled candidate, every split re-check, and a seeded sample of 20% of each reviewer's findings. The auditor sees the anonymized finding, the task with its answer key and a workspace with dependencies installed — never the panel's votes or the reviewer — and records a verdict with evidence: a command that reproduces the defect and its result, or, for a defect no test can show, a written argument that cites the code. The audit verdict replaces the panel's, including the panel's re-checks against pooled bugs. Agreement between the audit and the panel, and between the audit and each judge, is reported as Cohen's kappa, overall and per reviewer. The final set is scored only when grading is finished: every finding judged, every confirmed pooled bug re-checked, every pool candidate audited, and no audit item open.

**Scores per run** (round 1 only): the weight of the distinct pool bugs its findings match (a bug reported twice counts once), the pool's weight, the number of findings, of valid findings and of findings that match a pool bug, how many of those name the bug's file within ±3 lines of its lines, the verdict, and the bugs found. On clean and decoy tasks a run is a false alarm when its verdict is REVISE and at least one of its findings is not real. No ratio is stored per run; the aggregate metrics are computed over tasks.

**Track B outcomes** use the graded round-2 findings and the predicates below. New valid findings in round 2 are those judged real that match no bug a round-1 finding already matched and lie more than 5 lines from every round-1 finding's location. A run whose second round did not complete is scored as not meeting its predicate.

## Metrics

The unit of analysis is the task. For a run r of task t, after grading and using round 1 only:
- `tp_r` is the summed weight of the distinct pool bugs its findings match;
- `v_r` is its number of valid findings;
- `f_r` is its number of findings.

The pool of task t is its planted bugs plus its confirmed pooled bugs. `w_t` is the sum of their weights; it is 0 for a clean or decoy task unless a pooled bug was confirmed there. For each system, `tp_t`, `v_t` and `f_t` are means over the task's N runs. No ratio is taken per run.

- **wRecall** (severity-weighted recall) = Σ_t tp_t / Σ_t w_t, over the tasks with w_t > 0.
- **Precision** = Σ_t v_t / Σ_t f_t, over all tasks. It is 1 for a system with no findings, and that case is reported.
- **F1** = 2·P·R / (P + R), and 0 when P + R = 0. **F1 at config `high` on the synthetic corpus is the primary metric.**
- **False-alarm rate**: the share of clean and decoy runs whose verdict is REVISE and that have at least one finding judged not real. A finding that matches a confirmed pooled bug is real.
- **Location accuracy**: the share of matched findings that name the matched bug's file within ±3 lines of its lines.
- **pass^3 / pass@3**: the share of pool bugs found in all 3 runs, and in at least 1 of the 3.
- **Breakdowns**: wRecall by difficulty, category, severity and language. Pooled bugs carry no difficulty or category and appear as `pooled`.
- **Unplanted defects**: per system, the pooled bugs found.
- **Cost proxies**: median wall time per run, and median output tokens of round 1 as each CLI reports them in its event log, reasoning included: Claude Code's `result` usage, Codex's `turn.completed` usage, and the last usage of each Antigravity step. A run whose log has no usage report is left out of the median and never counted as zero. The CLIs count tokens with their own tokenizers, so the token figure compares a system's runs with each other, not one vendor's tokens with another's.

## Statistics

All of the statistics below are computed by the `analysis/` package at the tag, with seed `20261017`.

- **Confidence intervals.** 95% bootstrap intervals over tasks, stratified by repository, with 10,000 resamples. They are given for F1, wRecall and precision, per system.
- **Pairwise tests** at config `high`, for each of the 3 pairs and each of F1, wRecall and precision:
  - the test is a within-task permutation test that swaps the two systems' whole task vectors (tp_t, v_t, f_t), with 10,000 permutations;
  - p-values are Holm-adjusted over the 3 pairs, per metric;
  - **a reviewer wins only when the Holm-adjusted p of F1 is below 0.05.** Otherwise the report says they tie;
  - wRecall and precision tests are secondary.
- **Bradley–Terry strengths** come from per-task pairwise wins on F1_t, over the tasks with w_t > 0. The per-task values are:
  - r_t = tp_t / w_t;
  - p_t = v_t / f_t, or 1 when f_t = 0;
  - F1_t from r_t and p_t;
  - a tie counts as half a win for each side.

  The strengths are fitted with the MM algorithm and get bootstrap intervals.
- **Minimum detectable effect.** From the pilot's variance, the difference in F1 that this design detects with 80% power at Holm-adjusted α is about 0.06–0.07 at 144 tasks (`pilot/PILOT.md`). The report gives the MDE for each pair from the final data.
- **Robustness:**
  - rankings by F1 with one repository left out, and with one judge left out (each finding re-resolved without that judge's votes);
  - Kendall's τ between each system's F1 on the synthetic corpus and on the real bugs.
- **Track B** rates get Wilson 95% intervals. **Track C** fixed rates get bootstrap intervals over loops, regression rates get Wilson intervals, and each reviewer cell's paired difference from `none` gets a bootstrap interval over the shared tasks.
- A task that some system has no scored run on is dropped from every synthetic statistic, and the count is reported. This can happen, for example, when all its runs are contaminated.

## Track B: the second round

Track B measures how a reviewer handles the orchestrator's answer to its findings. It adds no extra first rounds: it rides on the Track A runs of config `high` (Codex `gpt-6-astra`, Claude Code `claude-opus-5-5`, Antigravity `gemini-4-argon`, all at effort `high`). Config `max`, clean tasks and real bugs get no second round.

Round 1 ends as in Track A. Its output (the parsed review, the session, the workspace diff) is archived as `round1/` before anything in the workspace changes, and Track A scores read only `round1/`.

**Overlap.** A round-1 issue overlaps a planted bug or decoy when its location names the same file (whole path segments, so `pager.js` matches `src/pager.js` and an absolute path inside the workspace matches its relative form) and a line range within ±5 lines of the bug's or decoy's lines. A location without line numbers overlaps nothing. The rule is mechanical and the same for every reviewer.

**Scenarios.** The run index n of a task picks the scenario:

| Scenario | Tasks | Run | The harness, playing the orchestrator |
|---|---|---|---|
| B1 correct fix | buggy | n = 1 | applies the correct fix of every bug some issue overlaps; lists each overlapping issue as fixed, at the lines of the fix |
| B2 wrong fix | buggy | n = 2 | the same with each bug's plausible wrong fix |
| B3 false rebuttal | buggy | n = 3 | disputes every issue overlapping the first flagged bug (by bug id) with a plausible but false argument; fixes nothing |
| B4 valid rebuttal | decoy | every n | disputes every issue overlapping the first flagged decoy with the argument for why the code is right; fixes nothing |

A run whose round 1 has no issue overlapping a bug (B1–B3) or a decoy (B4) has no second round and is `n/a`, so a reviewer that missed the bug is never credited in Track B. Round 1 must also have completed with a verdict.

**The reply.** The second round uses cross-review's own `reply` verb and its review-impl round-2 template, resuming the reviewer's thread. Its input holds `FIXED_ITEMS` (`ISSUE-N: <title> — fixed in <file>:<lines>`, or `No issues fixed this round`), `DISPUTED_ITEMS` (`ISSUE-N: <title> — <argument>`, or `None`), `SESSION_CONTEXT` (`Other issues from round 1 are not addressed in this round.` when some round-1 issue is left unanswered, else cross-review's default) and the same output format as round 1. Which bugs were fixed or disputed is recorded in the run record, never in the prompt. Patches are applied to the run's workspace only, after `round1/` is written.

**Outcomes**, judged on the open round-2 findings matched to the answer key:
- B1 resolution recognised: no open round-2 finding matches a fixed bug.
- B2 wrong fix caught: at least one open round-2 finding matches a wrongly fixed bug, or a defect the wrong fix introduces.
- B3 held position: an open round-2 finding still matches the disputed bug.
- B4 conceded: no open round-2 finding matches the disputed decoy.

Rates are reported per reviewer with Wilson 95% intervals, with the count of new valid findings in round 2.

**Failures.** A second round that could not answer — an infrastructure fault, the 7,200 s deadline, a stall — retries the whole run under the Track A rules (infra faults up to three times, a deadline or stall once). Round 1 is then drawn again; the retry is decided by round 2's fault, never by round 1's content. A second round that completes without a verdict is recorded as a reviewer failure (`reviewer_malformed`) and, like a second round that did not complete, scored as not meeting its scenario's predicate.

## Track C: the whole loop

Track C measures whether review helps an agent fix a pull request. It runs on 40 buggy tasks whose bugs all have hidden tests (`trackc/tasks.txt`, from `crb trackc-tasks`, seed `20261017`). The repositories take turns in the seeded order, so their counts differ by at most one. Within a repository, the tasks take turns by the difficulty of their hardest bug. Every task runs once in each orchestrator × cell, which makes 320 loops. An orchestrator — Claude Code (`claude-opus-5-5`, effort `high`) or Codex (`gpt-6-astra`, effort `high`) — gets a buggy task's workspace and is told to fix it, in one of four cells:

| Cell | The orchestrator is told to |
|---|---|
| codex, claude, agy | run the review-impl skill on the uncommitted change and follow it to the end — fix valid issues, rebut invalid ones — with that reviewer at its Track A `high` settings |
| none | review the change itself and fix every defect it finds |

Each loop runs in its own clean profile, like a Track A run, with the pinned cross-review release installed into it — the tool under test, the one difference from Track A's vanilla reviewers. The cell's reviewer is set in the profile's cross-review settings file; the `none` cell has none. The orchestrator is started by the harness with its full-access mode and the prompt on standard input; it never runs as if inside a reviewer, so its own reviews are allowed to start. Prompts: Claude Code is asked for `/review-impl`, Codex for `$review-impl`; neither may ask the user anything or commit.

**After the loop** (on exit or at the 10,800 s deadline), the harness tests the workspace the orchestrator left:
1. the visible tests, before any hidden test file exists in the workspace — a failure is a regression;
2. for each testable bug, its hidden tests alone, copied in for that check and removed after — a pass means the bug is fixed.

Recorded per loop: bugs fixed, visible tests passing, review sessions and rounds, the reviewers actually used, and wall time. The orchestrator's event log and every review session are audited for access outside the run as in Track A.

**Failures.** A loop is infra — retried, never scored — when the orchestrator cannot run (missing CLI, usage limit, auth, network, a failed turn) or when a reviewer it used hit one of those faults (a review turn that failed or never started; a review that timed out or stalled is the reviewer's own time and stays scored). A loop that reaches its deadline is retried once and then scored on the state it left. When the orchestrator exits, the harness stops every review it left running, before the tests run.

**Analysis.** Bug-fixed rate and regression rate per orchestrator × cell with intervals, review rounds and wall time, and the paired difference between each reviewer cell and `none` on the same tasks.

## Real-bug control set

The planted corpus is written by Claude, so it may favour the reviewer that shares its habits. The real-bug set checks the main ranking on defects nobody planted: 24 bugs (at least 20; the report states the count) from public repositories in the corpus's four languages, each introduced by one pull request and fixed by a later one, **both merged on or after 2026-07-01** — after every contestant's training cutoff (`gpt-6-astra` 2026-04-30, `claude-opus-5-5` June 2026, `gemini-4-argon` March 2026), so no contestant can have seen the fix.

**Mining** (`crb realbugs mine`) searches GitHub for merged pull requests since the cutoff, per language, with "fix" in the title or a bug label, and keeps those that pass every rule: not a bot or dependency update, a repository with at least 1,000 stars (100 in stage 3), a permissive licence (MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense), not archived, and a change to both a source file and a test file of the language (vendored, generated and declaration files do not count as source).

Mining runs in stages. The first searches all of GitHub; most of what it returns sits in small repositories, so when a language cannot reach six bugs from it, a second stage (`--by-repo`) lists the language's repositories that pass the repository rules and searches each one's pull requests. Stage 2 still found too few: in its first 66 TypeScript candidates, 6 passed the blame rule (most introducing pull requests predate the cutoff) and packaging rejected all 22 stage-1 candidates that had passed it (mostly feature changes under a "fix" title, fixes of code the introducing pull request did not write, or dependencies too large to keep). A third stage therefore lists up to 500 repositories per language with at least 100 stars instead of 1,000 — stars are a proxy for a maintained project, not a rule of the control set — and judges each repository's pull requests in the seeded order, stopping once two pass (`--per-repo 2`), which keeps the same candidates the selection step would and skips most file-list calls. Stage 2 ran for TypeScript only; for Python, Go and Java it was stopped before its result was written, because stage 3 covers the same repositories. For Java, stage 3 still found too few. Its repository list was then widened to 1,000 repositories, and candidates already seen were skipped.

**Selection.** The passing candidates of a stage are examined in a fixed order — per language, by SHA-256 of a published seed and the pull request's name (`crb realbugs order`), at most two per repository — and each is accepted or rejected with a reason in `realbugs/SELECTION.md` until six per language are accepted; a later stage is examined only after the earlier one is used up, in its own seeded order, skipping candidates already seen. Only fixes merged into the repository's default branch count. Before it is examined, a candidate must pass a sweep. Its fix must change at most 4 source files and 80 source lines; a larger change is a bundle of features rather than a targeted fix. Its repository must be under 300 MB. Blame must name an introducing pull request that owns at least half of the blamed lines. A candidate is accepted when:
1. `crb realbugs intro` blames the lines the fix removes or inserts at, in the fix's parent; the merged pull request owning most of those lines is the introducing one, and it was merged on or after 2026-07-01 (a recent fix of an old defect is rejected);
2. the fix's regression test fails after the introducing pull request and passes after the fix;
3. the repository builds and tests offline after one online dependency install, within the corpus's caches, without services beyond Postgres and Redis, and its snapshot stays small enough to keep in the corpus.

**Task.** The workspace is the repository just before the introducing pull request (its merge's first parent), with no history; the pull request is the introducing one as merged, with its title and description kept verbatim (no hint-word check). B1 is the defect in the lines the introducing pull request added (else a written justification); its fix is the fixing pull request's source change ported to that state, and its hidden test is the fixing pull request's regression test. Severity, difficulty and category follow the corpus rubric, assigned when the task is built. `source.json` records the upstream, both pull requests with their merge dates, and the licence; `crb validate --realbugs` runs the same oracles as for planted bugs, except the wrong fix (none exists) and the hint words.

**Result.** 24 bugs were accepted, 6 per language. In all, 47,051 mined pull requests were judged and 4,861 passed the mining rules. Of those, 1,998 entered the seeded order and 1,065 were swept. 116 passed the blame rule, 101 were examined and 24 were accepted. Each accepted task passed `crb validate --realbugs` and builds from empty caches. One Go candidate was accepted after Go already had six; it is listed but not used. `realbugs/SELECTION.md` lists every swept candidate with its verdict and reason.

**Use.** Real bugs run in Track A only (both configs, N = 3), never in Track B or C, and are scored and reported separately from the planted corpus: the question is whether the reviewers' order on real bugs agrees with their order on planted ones.

## Calibration

Before the freeze, `claude-sonnet-5-5` reviewed every synthetic task and every real bug once (set `calibration`, Track A, config `high`). A single `claude-sonnet-5-5` judge graded those runs. The results do two jobs:
- they check that detection does not rise from L1 to L4;
- they surface tasks whose bugs the calibration judge found ambiguous. Those tasks are fixed and validated again, or dropped, and each case is recorded in `calibration/CALIBRATION.md`.

A bug is never dropped for being hard or easy. Calibration shares a vendor with a contestant, so it never decides which bug stays. Its data is excluded from the results.

Results (details in `calibration/CALIBRATION.md`):
- **Detection.** It was flat near the ceiling: 138 of the 144 planted bugs were found, 93–98% at each level, so detection did not fall from L1 to L4 (limitation 12). On the real bugs it was 10 of 24.
- **Unsettled findings.** The audit settled all 16 findings the judge left unsettled.
- **One answer key fixed.** In one private task, the fix of one bug now follows the contract the pull request itself states.
- **Clean and decoy tasks.** The judge called 9 findings on clean and decoy tasks real. All 9 were real defects that the pull requests introduced; they were removed from 7 tasks, which were then re-validated.
- **No task was dropped.**

Calibration also found a fault in the tool under test. In 12 of its 168 reviews, Claude Code's built-in `ReportFindings` tool took the review out of the event log the runner reads. The fix shipped as cross-review 10.5.1, which the contest pins. The 12 affected calibration runs were run again on 10.5.1 and are reported separately in `calibration/CALIBRATION.md`.

## Excluded data

The smoke, pilot and calibration sets never enter the results. Per-reviewer pilot results were shown during development only under blinded labels X, Y and Z, so they could not steer corpus authoring. The map from label to reviewer is opened after the final scores exist.

## Deviations

After `prereg-v1`, nothing is changed without being listed in the report as a deviation, with its reason and its effect: the corpus, the prompts, the harness's run or scoring rules, and this analysis. A harness bug fixed during the final runs gets a regression test and a deviation entry. Runs it affected are re-run.

## Limitations

The report states these limitations:
1. **Claude wrote the corpus.** Claude Code wrote the synthetic corpus, so its bugs may suit the reviewer that shares Claude's habits. The real-bug set checks the ranking on defects nobody planted.
2. **Authoring and audit models.** Claude Opus 5.5 wrote and audited most of the corpus. Claude Haiku 5.5 wrote or audited part of it, and every such part was audited again by Opus 5.5.
3. **Judges are the contestants.** The judges run blind and decide by majority. Each judge's influence is shown by the leave-one-judge-out rankings and by Cohen's kappa against the audit.
4. **The audit is Claude Code.** It requires executable evidence or a written argument citing code. It shares a vendor with a contestant.
5. **Calibration** uses `claude-sonnet-5-5`, which shares a vendor with a contestant (see Calibration).
6. **Track C has cross-review installed.** Track C reviewers and orchestrators run with cross-review installed, the tool under test. Track A and B reviewers are vanilla.
7. **agy has no `max`.** Antigravity's highest level for `gemini-4-argon` is `high`, so it has no `max` system.
8. **Subscription CLIs.** The contestants run through subscription CLIs, not fixed APIs. The model served behind a name can change on the server side, so the report gives the run dates and each run's CLI version.
9. **Real bugs.** The real-bug set is small: 24 bugs, 6 per language. It comes from repositories with at least 100 stars in its third stage. Each task scores one bug, even where the upstream fix also repaired something else.
10. **Rubric targets missed after audits.** Three repositories miss the per-repository rubric targets (L1/L2/L3/L4 3/5/5/3; critical/high/medium/low 2/6/6/2) because audit corrections came from evidence and no other bug was relabelled to compensate: `gateway-go` difficulty 3/4/6/3 and severity 3/5/7/1; `booking-java` difficulty 4/6/4/2 and severity 3/6/4/3; `workflow-java` difficulty 4/4/7/1 (severity on target).
11. **A project the host's Maven cannot build as is.** `rb-java-ozone-10988` loads the Develocity Maven extension 2.5.0, which fails under the host's Maven 3.10.0 before any build step. The project's tests run only with a bypass (`MAVEN_BASEDIR=…`), so a reviewer that does not find the bypass reviews that task by reading. Every reviewer gets the same environment.
12. **Synthetic detection near the ceiling.** In calibration, `claude-sonnet-5-5` found 138 of the 144 planted bugs (93–98% at every difficulty level) and 10 of the 24 real bugs. The difficulty labels therefore do not separate what a strong reviewer finds, and recall on the synthetic corpus may not separate the contestants; their differences will show mostly in precision, clean and decoy behaviour, location, Track B and Track C, and in the real-bug set. Results by difficulty are descriptive (`calibration/CALIBRATION.md`).
