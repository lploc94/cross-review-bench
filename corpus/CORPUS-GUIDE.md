# Corpus authoring guide

How to write a corpus repository and its tasks so that the benchmark measures code review, not puzzle solving. Every rule here is checked by `crb repo-check`, `crb validate`, or the per-repo quota table; where a rule cannot be checked by a tool, this guide says so.

A **repository** is a small but real service (`repos/<repo>/`). A **task** is that repository at its clean state plus one pull request (`tasks/<repo>/<task-id>/pr.patch`) applied as uncommitted changes, with an answer key in `task.json` (`crb-task/v1`). Reviewers see only the repository and the PR, never the task directory.

## 1. Production checklist (`crb repo-check <repo>`)

A repository passes only when all of these hold:

| Rule | Requirement |
|---|---|
| `loc` | ≥ 4,000 code lines, not counting tests, generated files (a `Code generated`, `@generated` or `DO NOT EDIT` header), vendored or build directories (`vendor`, `third_party`, `node_modules`, `dist`, `build`, `target`, `gen`, `generated`, …), lock files, blank lines, comments and Python docstrings. Padding does not help. |
| `source_files` | ≥ 20 non-test source files (`.ts .tsx .js .mjs .cjs .py .go .java`). |
| `layers` | Source files in at least three layers, named by directory: API/handler (`api`, `handlers`, `routes`, `controllers`, `http`, `grpc`, `web`, …), domain/service (`domain`, `service(s)`, `core`, `model(s)`, `usecase(s)`, …) and persistence/integration (`persistence`, `repo(sitory)`, `store`, `storage`, `db`, `dao`, `integration(s)`, `infra`, `adapters`, `clients`, …). |
| `migrations` | A `migrations/` (or `migration/`, `migrate/`) folder with SQL or code migrations when `services` includes `postgres`. |
| `config_module` | A module named `config`, `settings`, `env` (or `*Config`, `*Settings`) that reads the environment and validates it (zod, pydantic settings, explicit checks that fail at startup, Bean Validation, …). |
| `structured_logging` | A structured logger: pino, winston, structlog, python-json-logger, `log/slog`, zap, zerolog, logstash encoder / JSON layout for Logback or Log4j2. |
| `typed_errors` | ≥ 2 error types of the project's own (`class NotFoundError extends Error`, `class ConflictError(DomainError)`, `type ValidationError struct`, `var ErrNotFound = errors.New(…)`, `class InsufficientFundsException extends RuntimeException`). |
| `visible_tests` | ≥ 60 test cases in the visible test suite (`it(`/`test(`, `def test_`, `func Test…`/`t.Run(`, `@Test`/`@ParameterizedTest`). |
| `test_cmd`, `typecheck_cmd`, `lint_cmd` | All three set in `crb-repo.json` and passing (`tsc --noEmit`, `mypy`/`pyright`, `go vet`, `mvn -o verify`'s compiler; eslint, ruff, staticcheck/golangci-lint, checkstyle/spotless, …). |
| `readme` | `README.md` with a run section (`## Running`, `## Usage`, `## Getting started`, …) and a test section (`## Tests`, `## Testing`). |
| `no_markers` | No `TODO`, `FIXME` or `XXX` anywhere. |
| `no_bench_words` | No `planted`, `bench`, `crb` or `decoy` (any case, whole words) in any file or file name, except words listed in `allow_words` when the domain genuinely needs them. `crb-repo.json` itself is not part of what reviewers see. |

`crb-repo.json` at the repository root:

```json
{
  "language": "ts | py | go | java",
  "test_cmd": "npx vitest run",
  "typecheck_cmd": "npx tsc --noEmit",
  "lint_cmd": "npx eslint .",
  "deps_cmd": "test -d node_modules || npm ci --offline",
  "warm_cmd": "npx vitest run",
  "services": ["postgres", "redis"],
  "allow_words": []
}
```

Dependencies and services:

- Commands get `DATABASE_URL` (a database of their own) and `REDIS_URL` (a Redis logical db of their own) when `services` lists them, plus cache variables: `npm_config_cache`, `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, `GOMODCACHE`, `GOFLAGS=-mod=vendor`, `MAVEN_ARGS="-Dmaven.repo.local=… -o"`, and `JAVA_HOME` (JDK 21) first on `PATH`. Tests read these variables; they never assume a port, a database name or a Redis db index.
- `crb cache warm <repo>` runs `deps_cmd` and `warm_cmd` once online, with `CRB_ONLINE=1` set, and keeps `node_modules` (keyed by `package-lock.json`) for APFS clones; everything after that runs offline. `deps_cmd` must work from empty caches under warm: fill them first when `CRB_ONLINE` is set (`[ -z "$CRB_ONLINE" ] || pnpm fetch …`, `[ -z "$CRB_ONLINE" ] || go mod download`), then install offline. So:
  - npm: `deps_cmd` must keep an existing `node_modules` (`test -d node_modules || npm ci $( [ -n "$CRB_ONLINE" ] || echo --offline )`).
  - Python: `uv sync --frozen`; Python 3.13 is uv-managed.
  - Go: commit `vendor/` or make `deps_cmd` produce it from the module cache (`go mod vendor`).
  - Maven: `warm_cmd` should exercise every plugin the tests need (`dependency:go-offline test-compile test`), since later runs are offline (`-o`).
- Tests that use Postgres create their schema by running the repository's own migrations.
- `deps_cmd` installs dependencies only: it gets the cache variables but no services (validation installs once and gives each test stage its own database).

## 2. Bugs

### Categories

Open set; across the corpus each of these needs ≥ 8 bugs: `logic`, `boundary` (off-by-one, empty/limit cases), `error-handling`, `concurrency`, `resource-leak`, `data-integrity`, `security`, `performance`, `spec-deviation` (the PR does not do what its description says), `api-contract`.

### Difficulty

| Level | What it takes to see the bug |
|---|---|
| L1 | Visible within the diff hunk. |
| L2 | Needs another file of the repository (a caller, a schema, a constant, a contract). |
| L3 | Needs an invariant or runtime behaviour: concurrency, transactions, isolation levels, caching, retries, ordering. |
| L4 | Needs running the code or domain knowledge: money rounding, currencies, time zones and DST, Unicode, floating point, protocol details. |

### Severity

Weights in scoring: critical 4, high 3, medium 2, low 1.

| Severity | Effect in production |
|---|---|
| critical | Money lost or created, data corrupted or leaked across tenants/users, authentication or authorization bypassed, the service down for all users. |
| high | A main path returns wrong results or loses writes for some inputs, a security weakness that needs a specific condition, unbounded growth that will take the service down. |
| medium | An edge case behaves wrongly, an error is swallowed or reported wrongly, a recoverable inconsistency, a noticeable slowdown on a common path. |
| low | Wrong but harmless details: misleading error text or status on a rare path, a small inefficiency on a cold path, a missing header that clients ignore. |

### Placement

- Every bug lies in lines the PR adds or changes (`V7`), and its `lines` range in `task.json` covers the faulty lines.
- The PR still passes the visible tests, typecheck and lint (`V2`): a reviewer cannot find the bug by running the existing checks, and the checks report no defect nobody chose.
- A bug must be a defect a careful senior reviewer would flag: not style, not a matter of taste, not "could be faster" without a concrete cost.

## 3. Pull requests

- Look like a real PR in that project: a feature, a refactor or a fix of realistic size (typically 60–400 changed lines), consistent with the code style, with tests for what it adds.
- The description (`description` in `task.json`, sent to the reviewer) reads like a real PR description: what changes and why, maybe how it was tested. It never hints at a defect, never says "carefully" or "tricky", and contains none of the hint words checked by `V8` (`bug`, `bugs`, `fixme`, `todo`, `xxx`, `hack`, `intentional`, `planted`, `bench`, `crb`, `decoy`, `hidden`).
- No comment or name in the PR reveals a defect or points at it.
- A PR never changes dependencies (manifests or lock files): the workspace is installed from the cache before the PR is applied.
- Clean PRs have the same size and quality as buggy ones; they are not trivial.

## 4. Answer key

### Hidden tests

- Each testable bug has hidden tests that fail on the PR and pass with its fix (`V3`, `V4`); all fixes together keep visible and hidden tests green.
- Deterministic (no sleeps racing real time, no random seeds, no wall-clock dates; concurrency tests force the interleaving), each check under 60 seconds, no network beyond the provided Postgres/Redis.
- Paths are workspace-relative and live where the toolchain finds them (`src/test/java/…`, the package's own directory for Go internal tests, `test/hidden/…` for TS/Python); the file is stored at `<task-dir>/hidden/<that path>` and copied in only for its own check.
- At most 3 bugs per repository without a hidden test (`testable: false` with a `justification`, for example a performance bug only measurable at scale).

### Fixes and wrong fixes

- `fix-Bk.patch`: the minimal correct fix on top of the PR.
- `wrongfix-Bk.patch`: plausible and partial — it fixes the symptom on one path or the most obvious input, touches the bug's area, differs from the fix, and leaves the hidden tests failing (`V5`). It is what a hurried developer would write after reading the review comment, not nonsense.

### False rebuttals

- One per bug (`false_rebuttal`): what an author would say to dismiss the finding — confident and specific, naming the file, function or invariant that supposedly makes the code safe — but refutable by reading a named file of the repository. Never a bare "this is fine" and never an argument that needs information outside the repository.

### Decoys and valid rebuttals

- A decoy is code in a PR that looks wrong but is correct (`looks_like`, `why_correct`): an apparent off-by-one that matches an exclusive bound defined elsewhere, a missing lock that a unique constraint makes unnecessary, a swallowed error that a caller handles.
- Its `valid_rebuttal` explains why it is correct in a way verifiable from the repository (a file, a constraint, a test). Its hidden tests pass on the PR (`V6`).

## 5. Quotas per repository (F8)

| Item | Count |
|---|---|
| Tasks | 16: 11 buggy, 3 clean, 2 decoy |
| Bugs in buggy tasks | 16: 7 tasks with 1 bug, 3 with 2, 1 with 3 |
| Difficulty | L1 3, L2 5, L3 5, L4 3 |
| Severity | critical 2, high 6, medium 6, low 2 |
| Categories | ≥ 6 different |
| Bugs without a hidden test | ≤ 3 |

## 6. Before committing

Re-read every clean and decoy PR, and every buggy PR apart from its planted bugs, hunting for defects you did not intend: input accepted that should be rejected, unbounded waits or queries, tests that can hang instead of failing, documentation that misstates the change, and base code the PR relies on that is itself wrong. A reviewer who finds one is right, so a clean task with such a defect no longer measures false alarms. Fix it in the PR, or in the base and then re-check every task of the repository.

```bash
node harness/bin/crb.js repo-check <repo>
node harness/bin/crb.js cache warm <repo>
node harness/bin/crb.js validate --repo <repo>
```

All three must pass. Never run a reviewer on corpus content outside the harness, never index this repository with code-search tools, and never write task details into any agent memory.
