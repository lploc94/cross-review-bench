# Cross-Review Bench

A controlled benchmark of AI code reviewers driven through [cross-review](https://www.npmjs.com/package/@tlelabs/cross-review): Codex (`gpt-6-astra`), Claude Code (`claude-opus-5-5`) and Antigravity (`gemini-4-argon`) review the same pull requests, and their findings are graded against planted bugs whose hidden tests prove them.

This repository holds the harness (`harness/`), the analysis (`analysis/`), the method (`METHODOLOGY.md`) and the report (`report/`). The corpus — production-grade repositories, pull requests with planted bugs, and their answer keys — lives in a separate private repository so that no diff of this one ever carries answers.

## Layout

```text
harness/bin/crb.js     CLI
harness/lib/           task schema, validator, run harness (Tracks A–C), grading
harness/prompts/       Track C orchestrator prompts
harness/test/          node:test suites and a toy fixture corpus (pager-js)
METHODOLOGY.md         the method (draft until frozen)
```

The corpus is found through `CRB_CORPUS` (default `../cross-review-bench-corpus`). Bench state lives in `~/.crbench/` (`CRB_HOME`): the pinned cross-review checkout `cross-review-v10.5.1/`, caches, run archives and scratch space.

## Requirements

- Node.js >= 22
- The pinned cross-review release: `git -C <cross-review repo> worktree add --detach ~/.crbench/cross-review-v10.5.1 v10.5.1` and `npm ci --prefix ~/.crbench/cross-review-v10.5.1/skill-packs/cross-review`

## Tasks

A task is a corpus repository at its clean state plus one pull request (`pr.patch`) applied as uncommitted changes. Its `task.json` (`crb-task/v1`) says whether the PR is `buggy` (1–3 planted bugs), `clean`, a `decoy` (code that looks wrong but is right) or a `realbug` (a real open-source bug). Each planted bug has a hidden test that fails on the PR and passes after its fix, a fix, a plausible wrong fix, and a false rebuttal used in the second review round.

Hidden tests are listed by their path inside the workspace (for example `src/test/java/.../HoldRaceTest.java`) and stored under `<task>/hidden/<that path>`.

## Validating tasks

```bash
CRB_CORPUS=harness/test/fixtures/corpus node harness/bin/crb.js validate harness/test/fixtures/corpus/tasks/pager-js/pager-js-T01
node harness/bin/crb.js validate --repo ledger-ts
node harness/bin/crb.js validate --all
```

`crb validate` exits 0 when every oracle passes, 1 when one fails and 2 on a schema or usage error. The oracles:

| Oracle | Checks |
|---|---|
| V1 | the base passes its visible tests |
| V2 | the PR applies; visible tests, typecheck and lint (`crb-repo.json`) still pass |
| V3 | each bug's hidden tests fail on the PR |
| V4 | each fix makes its hidden tests pass; all fixes together keep visible and hidden tests green |
| V5 | each wrong fix differs from the fix, touches the bug's area and leaves its hidden tests failing — alone and with all wrong fixes applied together |
| V6 | clean and decoy hidden tests pass on the PR |
| V7 | each bug lies in lines the PR adds or changes |
| V8 | no hint words in the description or the PR's added lines |
| V9 | `task.json` follows the schema |

`crb validate --repo <repo> --stats` (or `--all --stats`) checks a repo's tasks against the per-repo quotas (F8: 11 buggy / 3 clean / 2 decoy tasks; 16 bugs as 7×1, 3×2, 1×3; difficulty L1–L4 3/5/5/3; severity 2/6/6/2; at least 6 categories; at most 3 bugs without hidden tests). It reads `task.json` only, prints the counts and each quota's result as JSON, and exits 0 when every quota is met, 1 otherwise.

Every test-running check works on a fresh copy of the base (under `~/.crbench/tmp/`), so a bug's hidden tests and their build output are present only during its own check; combined checks (all fixes, all wrong fixes) use one copy per bug. Commands get a clean environment (`PATH`, `HOME`, user and locale variables, no user git configuration) plus the service variables. A command that times out or is killed never counts as a failing test. Hidden test paths may not leave the workspace, and a symlink in a corpus repo, or one a patch adds, must point inside the workspace.

## Services, toolchains and repo-check

```bash
node harness/bin/crb.js services up        # colima (6 CPU, 12 GB) + crb-postgres (postgres:17, :55432) + crb-redis (redis:7, :56379)
node harness/bin/crb.js services status    # JSON; exit 0 when both are healthy
node harness/bin/crb.js services down      # stops the two containers; their volumes stay
node harness/bin/crb.js cache warm ledger-ts   # or --all
node harness/bin/crb.js repo-check ledger-ts   # or --all [--json]
```

`up` is idempotent and only ever touches containers named `crb-*`; docker talks to colima's own socket (`~/.colima/default/docker.sock`), whatever the current docker context is. Every command that runs corpus tests — each validation stage, `repo-check`, each review run — gets its own database `crw_<hex>` and a Redis logical db leased from 1–15 (`FLUSHDB` on lease and on release; a lease whose process died is reclaimed; when all 15 are held the next one waits), as `DATABASE_URL` and `REDIS_URL`. Repos whose `crb-repo.json` lists no `services` need neither.

Corpus commands also get the toolchain environment: caches under `~/.crbench/cache/` (`npm_config_cache`, `UV_CACHE_DIR`, `GOMODCACHE`, Maven `-Dmaven.repo.local`), `UV_PYTHON_INSTALL_DIR=~/.local/share/uv/python`, `GOFLAGS=-mod=vendor`, `MAVEN_ARGS=… -o`, a `GOCACHE` inside the scratch directory of each validation, repo-check and warm (removed with it; review runs keep Go's cache in their own HOME), and JDK 21 (`brew install openjdk@21 maven`; `JAVA_HOME` set by the harness, `CRB_JAVA_HOME` overrides). `crb cache warm` fills the caches online once (deps and `warm_cmd`, Maven and Go online) and keeps a TypeScript repo's `node_modules`, keyed by its lock file, for APFS clones into later workspaces; validation and runs then work offline. A Python `.venv` is never cloned (a virtualenv names the directory it was built in): each validation stage rebuilds it from the uv cache.

`crb repo-check` decides whether a corpus repo is production-grade: ≥ 4,000 code lines outside tests, generated and vendored code (comments, blank lines and docstrings do not count), ≥ 20 source files across API, domain and persistence layers, migrations when it uses Postgres, a config module that validates the environment, structured logging, ≥ 2 typed errors, ≥ 60 visible tests, passing `test_cmd`, `typecheck_cmd` and `lint_cmd`, a README with run and test sections, no `TODO`/`FIXME`/`XXX`, and no bench-revealing words. The corpus's `CORPUS-GUIDE.md` explains each rule to authors.

## Running

Prerequisites: the pinned cross-review release (above); `codex`, `claude` and `agy` on `PATH`, each logged in on this machine. A run never logs in: it copies the login material into a fresh profile.

```bash
CRB_CORPUS=harness/test/fixtures/corpus node harness/bin/crb.js run --set smoke --track A --config high --tasks 'pager-js/*' --n 1
node harness/bin/crb.js run --set final --track A --config high --tasks 'ledger-ts/*' --n 3 --dry-run
node harness/bin/crb.js status --set final --complete
node harness/bin/crb.js audit --set final --all [--requeue] [--restore]
```

`--set` (`smoke`, `pilot`, `calibration`, `final`) is required and namespaces the archives. `--tasks` is a glob over `<repo>/<task-id>` (or `realbugs/<id>`), several comma-separated (`'ledger-ts/*,jobqueue-go/*'`), or a file of such lines. `--reviewers` defaults to all three, `--n` to 3, `--concurrency` to `codex=3,claude=3,agy=2`; `--model <reviewer>=<model>` overrides a reviewer's model and is recorded. Config `high` runs `gpt-6-astra`, `claude-opus-5-5` and `gemini-4-argon` at effort `high`; `max` runs Codex and Claude Code at `max` (agy has no higher level; its `high` runs stand in). `crb run` prints `{set, planned, skipped, done, reviewer_failures, infra_failures, flagged, contaminated, infra_exhausted}` and logs each attempt on stderr.

Each run:
1. builds `/tmp/crw/<8-hex>/home`, a fresh `HOME` holding only the CLIs' login material (`.codex/auth.json`, a minimal `.claude.json`, the Gemini/agy credential files, a link to the Keychain), with `CODEX_HOME` inside it, its own `TMPDIR` `/tmp/crw/<8-hex>/tmp` (the machine's is shared by every run; macOS `mktemp -d` without a template still uses the user's temp dir, with a random name) and `DISABLE_AUTOUPDATER=1`: no skills, MCP servers, plugins, instructions or memory. The login would bring the account's claude.ai connectors and skills into Claude Code, so the profile also sets `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `.claude/settings.json` `{"syncClaudeAiSkills": false}`; what each CLI ships with stays;
2. materializes `/tmp/crw/<8-hex>/<repo>`: the corpus repo at corpus `HEAD` as a one-commit repo (`Dev <dev@example.com>`, 2026-01-01), dependencies installed, the PR applied uncommitted;
3. runs `review-runner.js begin --skill review-impl --mode working-tree` with the PR description, then `wait` until the round ends, and writes round 1's result, workspace diff and session to the archive's `round1/`;
4. on config `high`, plays a scripted second round (Track B, below), then `end`;
5. audits the reviewer's event log for access outside the run, classifies the attempt, archives it, writes a refreshed Codex token back to `~/.codex/auth.json` (after a backup in `~/.crbench/auth-backups/`), and deletes `/tmp/crw/<8-hex>`.

Failure classes:

| Class | Meaning | Handling |
|---|---|---|
| `ok` | the round completed with a verdict | final |
| `infra` | missing CLI, runner error before the reviewer started, auth, usage limit, network, a reviewer process that died | retried, never scored: a usage limit pauses that reviewer's queue 30 min, doubling to 4 h; other faults retry 3 times, then `infra_exhausted` (re-launchable) |
| `reviewer_timeout`, `reviewer_stall` | the 7200 s round deadline, or no output for ~3 minutes | retried once, then scored as a failure (zero findings) |
| `reviewer_malformed` | the round completed without a verdict | scored as a failure |

The audit flags the real home outside its toolchain folders (`~/.local/bin`, `~/.local/share/uv/python`, `~/.local/share/claude`, `~/.crbench/cache`, the pinned cross-review), other `/Users` or `/Volumes` paths, other runs' `<8-hex>` dirs under `/tmp/crw` (or a glob over them; the root's own entries and files beside the run dirs, such as the `AGENTS.md` Codex looks for above the workspace, hold nothing of another run), a recursive listing or content search of `/tmp/crw` or of a folder above it (`rg secret /`, `find /tmp/crw -type f`, `ls -R`; a search by name only, such as `find / -name pytest` or `rg --files -g <glob>`, prints paths and is allowed), a listing of a shared temp root (`/tmp`, `/var/folders` down to a user's `T` dir: `ls`, `find`, `rg` and the like given the root or run there without a path, or a tool given it), a glob among its entries, or a search of it by any name but an instruction file, the Keychain, the `security` and `hdiutil` commands, and for real bugs the upstream repository where a tool reaches it: a web search or fetch naming it, a URL to it in any input, or a fetch command (`curl`, `wget`, `gh`, `git clone`/`fetch`, `go get`, …) naming it in the same simple command. Code that only names it, such as a Go import path in a test the reviewer writes, is not flagged. A flagged attempt is archived under `~/.crbench/runs/flagged/` and run again once; flagged twice (counting earlier batches), the run is recorded as `contaminated` and excluded. `crb audit --set S --all` re-audits a set's archives with the current rules and exits 1 while a flagged run is neither contaminated nor sent back; `--requeue` handles each newly flagged run the same way: its archive becomes a flagged attempt and the next batch runs it again, or it becomes contaminated at its second flag. After a rule is narrowed, `--restore` replays each flagged run's attempts under the current rules: the first clean attempt becomes the run's result, and attempts after it move to `~/.crbench/runs/superseded/` (never a result, never a flag); the exit is 1 while a run is restorable but not restored, or its clean attempt would have been retried (`needs_rerun`).

Archives live in `~/.crbench/runs/<set>/<track>/<config>/<reviewer>/<task>/<n>/` (`run.json`, `wait.json` and `round1/` for round 1, `round2/` for a Track B round, `audit.json`, `session/` with every round, `workspace.diff` and `workspace.status` as the run left the workspace, `errors.log`). To resume, run the same command again: finished runs of the set are skipped, and only missing or `infra_exhausted` runs start. A batch refuses to start with less than 20 GB free. To share the machine with another heavy job, a batch (`run` or `trackc`) starts no new run while `~/.crbench/pause` exists or a process whose command line matches `CRB_YIELD_TO` (`pgrep -f`) is running; runs already started finish, so no run is timed under the other job's load from its start, and the log shows `hold:` and `hold ended`. Measured in the pilot (`pilot/PILOT.md`): a run takes 3–6 minutes at the median (p99 under 13 minutes, both rounds), 288 runs took 5.4 hours at the default concurrency, an archive is about 0.5 MB, and judging 32 tasks with the three-judge panel took about an hour.

## Tracks

**Track A** is the first round above: detection, scored from `round1/` only.

**Track B** rides on Track A config `high` (F10). After round 1 is archived, the run's index picks a scenario: on a buggy task n=1 applies the correct fix of each bug a round-1 issue overlaps (B1), n=2 its wrong fix (B2), n=3 disputes the issue with a false rebuttal (B3); on a decoy task every run disputes the decoy's issue with the valid rebuttal (B4). An issue overlaps a bug or decoy when its location names the same file and a line within ±5 of its lines; with no overlapping issue the scenario is `n/a` and there is no round 2. The harness then sends `reply` with `FIXED_ITEMS`, `DISPUTED_ITEMS`, `SESSION_CONTEXT` and the output format, waits, and archives `round2/` (`input.md`, `wait.json`, `workspace.diff`, `workspace.status`); `run.json` `track_b` records the scenario, the issues answered, the bugs fixed or the bug/decoy disputed, the patches, and round 2's class and verdict. A round 2 that could not answer (infra, deadline, stall) retries the whole run under the same rules. Clean tasks, real bugs and config `max` have no round 2.

**Track C** runs the whole loop (F11): an orchestrator fixes a buggy task with review-impl and a reviewer cell, or alone.

```bash
CRB_CORPUS=harness/test/fixtures/corpus node harness/bin/crb.js trackc --set smoke --tasks 'pager-js/pager-js-T01' --orchestrators claude,codex --cells codex,none
node harness/bin/crb.js trackc --set final --tasks trackc/tasks.json --dry-run
node harness/bin/crb.js status --set final --track C --complete
```

Orchestrators are Claude Code (`claude-opus-5-5`) and Codex (`gpt-6-astra`) at `high`; cells are `codex`, `claude`, `agy` (their Track A `high` settings) and `none`; tasks must be buggy. Each loop (`<set>/C/high/<orchestrator>-<cell>/<task>/1`, queued per orchestrator with `--concurrency claude=3,codex=3`):
1. builds the clean profile and services as a run does, installs the pinned cross-review into the profile (`HOME=<run home> node ~/.crbench/cross-review-v10.5.1/bin/cross-review.js`), and writes `~/.cross-review/config.json` `{reviewer: <cell>, reviewers: {<cell>: {model, effort: "high"}}}` there (none for `none`);
2. starts the orchestrator with the pinned adapter's command line in full-access mode, the prompt from `harness/prompts/trackc-review.md` (`/review-impl` for Claude Code, `$review-impl` for Codex) or `trackc-none.md` on stdin, and no `CROSS_REVIEW_REVIEWER`; deadline 10,800 s;
3. runs the visible tests before any hidden file exists, then each testable bug's hidden tests alone (copied in, run, removed);
4. audits the orchestrator's log and every review session it ran (`crb audit` re-reads them from the archive the same way), classifies the loop (infra when the orchestrator or a reviewer it used could not work; `reviewer_timeout` at the deadline, still tested), and archives `run.json` (`bugs_fixed`, `bugs_testable`, `visible_ok`, `review_rounds`, `sessions`, `reviewers_used`, `wall_s`, `install`), `tests.json`, `sessions.json`, `sessions/`, `prompt.md`, `orchestrator.jsonl`, `orchestrator.stderr`, `workspace.diff` (everything against the imported base, committed or not) and `workspace.log`.

`METHODOLOGY.md` describes Tracks B and C for the report.

## Grading

```bash
node harness/bin/crb.js judge --set final [--tasks <id,…>] [--concurrency codex=2,claude=2,agy=1]
node harness/bin/crb.js pool --set final
node harness/bin/crb.js audit-queue status --set final
node harness/bin/crb.js audit-queue next --set final
node harness/bin/crb.js audit-queue record A12 --set final --verdict real --match B1 --repro-cmd "<cmd>" --result fail
node harness/bin/crb.js score --set final
```

Grading data lives in `~/.crbench/grading/<set>/`: `findings.json` (anonymized findings per task, ids `F<k>` shuffled with seed `20261017`), `mapping.json` (finding key → run, reviewer, config, round, scenario; read by scoring and the audit sample, never shown to a judge or the auditor), `judgments/<task>/<judge>.json`, `panel.json`, `pool.json`, `recheck.json` (each re-check's decision and every judge's vote), `audit/queue.json`, `audit/records/<item>.json`, `scores.jsonl` and `agreement.json`. `score --set final` also writes `results/scores.jsonl` and `results/agreement.json` in this repository.

1. `judge` collects the findings of the set (round 1 of every scored Track A run, round 2 of completed Track B rounds), then asks each judge about each task whose findings changed or whose last judgment failed, in a clean profile through the pinned runner (`init --skill-name crb-judge`, `start --sandbox read-only`, `poll`) on a workspace of the task without dependencies. Judges: the three contestants at `high` for `pilot` and `final`, `claude-sonnet-5-5` for `smoke` and `calibration`. Prompt: `harness/prompts/judge.md`. Malformed or flagged answers are asked again (3 calls in all); infra faults retry through the scheduler. It then writes `panel.json` (findings of tasks some judge has not answered yet are `not_judged`, never queued) and adds unsettled findings and the 20% sample to the audit queue; an open item whose panel reason no longer holds is withdrawn.
2. `pool` re-checks findings against pooled bugs the audit confirmed since the last pass, then groups real findings that match nothing (`harness/prompts/dedupe.md`, `claude-sonnet-5-5`) and queues each group as a pooled-bug candidate. Run it after each audit pass until it queues nothing.
3. `audit-queue next` prints the first open item as JSON (`audit-queue show <item>` prints a given one, so several auditors can split the queue) (findings, task and answer key, a workspace with dependencies under `~/.crbench/tmp/audit/`, the record command); `record` needs `--repro-cmd` with `--result pass|fail|n/a`, or `--evidence <file>`, refuses `not_real` with a match to a bug or pooled bug, and for a pooled candidate judged real takes `--file`, `--lines A-B`, `--severity` and `--summary` to correct the helper's proposal (with `--match B<n>` instead, the candidate is that planted or pooled bug, and no new pooled bug is made).
4. `score` writes one row per run (`track: "A"`, `"B"` or `"C"`) by the rules in `METHODOLOGY.md`; rows with an open audit item or an unjudged finding are marked `provisional`, and the `final` set refuses to score while any row is provisional, a confirmed pooled bug is not re-checked, or a pool candidate is not queued.

A requeued or restored attempt keeps its run id, so its findings often keep their keys. Judgments, panel entries, audit records and re-checks therefore store the content they graded (a signature of the anonymized finding). A finding whose content changed is asked about again by `judge`. Its audit items open again in the next queue sync, with the old record kept as `<item>.stale-<ms>.json`. The pooled bugs it was credited with are re-checked by `pool`. Until then, nothing graded on the old content counts, and the finding is `provisional`.

## Reproducing the results

The results are in `report/REPORT.md` (the full report), `report/ARTICLE.md` (a summary) and `results/` (`scores.jsonl`, `agreement.json`, `pool.json`, `leaderboard.json`). From the score rows alone, without re-running anything:

```bash
uv run --project analysis python -m crb_analysis.report --scores results/scores.jsonl --out report/
node harness/bin/crb.js check-report
```

The report command rebuilds `report/leaderboard.*`, `report/tables/` and `report/figures/` and refreshes `results/leaderboard.*` with seed `20261017`, so the numbers come out the same; `check-report` checks every number in the marked tables of `REPORT.md` and `ARTICLE.md` against `results/leaderboard.json`. To run the whole bench again, follow `REPORT.md` "Reproducibility": the pinned versions, the corpus tag, and the commands from `crb run` to `crb score`.

`node harness/bin/crb.js export --out <new dir>` writes the release bundle: the public-split tasks with their answer keys, the real bugs, the final set's runs, score rows and pooled bugs of public tasks, the harness, the analysis and the report, with a SHA-256 manifest. Private tasks stay out, so they can test reviewers later without their answers having been published; the export fails, leaving nothing behind, when a file names a private task or quotes its answer key.

## Public release

The public repository [`lploc94/cross-review-bench`](https://github.com/lploc94/cross-review-bench) is built from `crb export`: this bench at its root and the corpus's public split in `corpus/` (96 tasks: 72 planted pull requests with their answer keys, the 24 real bugs, the nine base repositories and `splits.json`). Two parts are too large for git and are assets of its GitHub release, listed with their SHA-256 in `manifest.json`:

- `realbugs-repos.tar.zst`: each real bug's copy of its upstream repository, to extract into `corpus/realbugs/<id>/repo/`; each keeps its own license;
- `runs-final-public.tar.zst`: the final set's run archives of public tasks, to extract into `$CRB_HOME/runs/` (default `~/.crbench/runs/`).

```bash
zstd -dc realbugs-repos.tar.zst | tar -xf - -C corpus/realbugs
mkdir -p ~/.crbench/runs && zstd -dc runs-final-public.tar.zst | tar -xf - -C ~/.crbench/runs
export CRB_CORPUS="$PWD/corpus"
```

`results/` there holds the score rows of public tasks only, so the analysis rebuilt from them gives the public subset's numbers, not the report's; the 72 private tasks stay unpublished so that they can test reviewers later without their answers having been seen. Code (`harness/`, `analysis/`) is MIT-licensed; the tasks, results and write-ups are CC BY 4.0 (`LICENSE`).

## Tests

```bash
npm test
```

Run tests never read or write the real CLI profiles or run archives: they set `CRB_HOME`, `CRB_REAL_HOME`, `CRB_RUN_ROOT` and `CRB_CORPUS` to temporary directories and drive cross-review's fake `codex`, `claude` and `agy` from the pinned checkout (`CRB_TEST=1` forwards their `FAKE_*` variables into run profiles). Validation tests use `~/.crbench/tmp/` as scratch space and clean it up.

`harness/test/services.test.js` needs colima, Postgres and Redis and is skipped unless `CRB_LIVE=1` (`node harness/bin/crb.js services up` first): `CRB_LIVE=1 node --test harness/test/services.test.js`. Its leases live under a temporary `CRB_HOME`; the databases it creates are dropped.
