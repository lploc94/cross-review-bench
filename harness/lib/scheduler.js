// Track A batches: the run list, one run end to end, and the queue with per-reviewer concurrency,
// retries and backoff (I9, I10, Capacity).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { runRoot, runsDir, realHome, corpusRoot, crbHome, PINNED_TAG, PINNED_SHA } from "./paths.js";
import { spawnSync } from "node:child_process";
import { CONFIGS, DEFAULT_CONCURRENCY, RETRY, MIN_FREE_BYTES, ROUND_TIMEOUT_S } from "./config.js";
import { runId, isDone, archive, runPath, flaggedPath, flaggedAttempts, writeAtomic } from "./store.js";
import { buildProfile, codexWriteBack } from "./profile.js";
import { materialize, corpusCommit, applyTaskPatch } from "./workspace.js";
import { reviewInput, begin, waitDone, reply, end, cliVersion } from "./review.js";
import { classify, REVIEWER_FAILURES } from "./failures.js";
import { auditRun } from "./audit.js";
import { needsServices, provisionRun, releaseRun } from "./services.js";
import { toolchainEnv } from "./cache.js";
import { scenarioFor, buildReply } from "./scenarios.js";

/**
 * Track A run list: every task × reviewer × n. Config `max` has no agy row (F5: it reuses agy's
 * high runs). `models` overrides a reviewer's model (calibration), recorded in run.json.
 */
export function planRuns({ set, track = "A", config, reviewers, tasks, n, models = {} }) {
  const settings = CONFIGS[config];
  if (!settings) throw new Error(`config must be one of ${Object.keys(CONFIGS).join(", ")}`);
  const runs = [];
  for (const task of tasks) {
    for (const reviewer of reviewers) {
      if (!settings[reviewer]) continue;
      const { model, effort } = settings[reviewer];
      for (let i = 1; i <= n; i++) {
        runs.push({ id: runId({ set, track, config, reviewer, task: task.id, n: i }), set, track, config, reviewer, model: models[reviewer] ?? model, effort, task, n: i });
      }
    }
  }
  return runs;
}

/**
 * What to do after an attempt, from its result and the run's counters
 * { flags, infra, reviewer } (attempts already spent on each). Pure, so the rules are testable.
 *   final            archive as the run's result
 *   requeue_flagged  archive under flagged/, run again with a new hex
 *   contaminated     second flag: archive under flagged/ and record the run as contaminated (final)
 *   retry_reviewer   timeout or stall, first time
 *   retry_usage      usage limit: pause this reviewer's queue, never counted against the run
 *   retry_infra      other infra fault, up to RETRY.infraRetries
 *   infra_exhausted  infra retries used up (recorded, not final, re-launchable)
 */
export function decide(result, counters, retry = RETRY) {
  if (result.flagged) return counters.flags >= 1 ? "contaminated" : "requeue_flagged";
  if (result.class === "ok" || result.class === "reviewer_malformed") return "final";
  if (result.class === "reviewer_timeout" || result.class === "reviewer_stall") return counters.reviewer >= retry.reviewerRetries ? "final" : "retry_reviewer";
  if (result.reason === "usage_limit") return "retry_usage";
  return counters.infra >= retry.infraRetries ? "infra_exhausted" : "retry_infra";
}

const hex8 = () => crypto.randomBytes(4).toString("hex");

/** Real bugs: `<host>/<owner>/<repo>` of every repository URL in the task's source.json (audit flags them). */
export function upstreamFragments(task) {
  let text;
  try { text = fs.readFileSync(path.join(task.dir, "source.json"), "utf8"); } catch { return []; }
  const out = new Set();
  for (const m of text.matchAll(/https?:\/\/((?:github|gitlab)\.com)\/([^/\s"#?]+)\/([^/\s"#?]+)/gi)) {
    out.add(`${m[1]}/${m[2]}/${m[3].replace(/\.git$/, "")}`.toLowerCase());
  }
  return [...out];
}

export function safeRemove(dir) {
  const rel = path.relative(runRoot(), dir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to delete ${dir}: not inside ${runRoot()}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function gitText(args, cwd) {
  const r = await run("git", args, { cwd });
  return r.code === 0 ? r.stdout : "";
}

const fileSize = f => { try { return fs.statSync(f).size; } catch { return 0; } };

/** The last 20 kB of f after byte `from`. */
function readFrom(f, from = 0) {
  try { return fs.readFileSync(f).subarray(from).toString("utf8").slice(-20_000); } catch { return ""; }
}

/** Round 1's output as it stood before round 2 touched anything: wait result, workspace state, session. */
async function snapshotRound1(dir, { waitJson, ws, sessionDir }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "wait.json"), JSON.stringify(waitJson ?? null, null, 2) + "\n");
  if (ws) {
    fs.writeFileSync(path.join(dir, "workspace.diff"), await gitText(["diff"], ws));
    fs.writeFileSync(path.join(dir, "workspace.status"), await gitText(["status", "--porcelain"], ws));
  }
  if (sessionDir && fs.existsSync(sessionDir)) fs.cpSync(sessionDir, path.join(dir, "session"), { recursive: true, verbatimSymlinks: true });
}

/**
 * Track B round 2 (F10) on a run whose round 1 is already snapshotted: apply the scenario's answer
 * patches to the workspace, `reply`, wait. Returns the run.json `track_b` record and round2/ files.
 */
async function secondRound(spec, scenario, { round1, ws, sessionDir, runDir, env, record }) {
  const plan = buildReply(scenario, round1.review?.blocks ?? [], spec.task);
  const tb = { scenario, status: plan.status, reason: plan.reason ?? null, issues: plan.issues, fixed_bugs: plan.fixed_bugs, disputed: plan.disputed, patches: plan.patches };
  record.track_b = tb;
  if (plan.status !== "run") return { tb, files: {} };
  tb.patched_ms = Date.now();
  for (const p of plan.patches) await applyTaskPatch(spec.task, p, ws);
  const inputFile = path.join(runDir, "round2-input.md");
  fs.writeFileSync(inputFile, plan.input);
  // the reviewer's stderr for round 2 only: what error.log gains from here on
  const logFile = path.join(sessionDir, "error.log");
  const from = fileSize(logFile);
  const rep = await reply(sessionDir, { inputFile, env });
  const wait = rep.code === 0 && rep.json?.status !== "error" ? await waitDone(sessionDir, { env }) : null;
  const r2 = classify({ beginCode: rep.code, beginJson: rep.json, waitJson: wait?.json ?? null, errorLog: [wait?.error, rep.stderr, readFrom(logFile, from)].filter(Boolean).join("\n") });
  Object.assign(tb, { class: r2.class, class_reason: r2.reason, verdict: wait?.json?.review?.verdict?.status ?? null, round2_issues: wait?.json?.review?.blocks?.length ?? 0 });
  const files = {
    "round2/input.md": plan.input,
    "round2/wait.json": JSON.stringify(wait?.json ?? null, null, 2) + "\n",
    "round2/workspace.diff": await gitText(["diff"], ws),
    "round2/workspace.status": await gitText(["status", "--porcelain"], ws),
  };
  return { tb, files, r2 };
}

/**
 * One attempt of one run, end to end: profile, workspace, begin/wait (round 1, snapshotted as
 * round1/), Track B round 2 when config `high` gives the task a scenario, end, audit, classify,
 * archive (as `decision(result)` says), Codex write-back, cleanup. Resolves { result, decision, hex }.
 */
export async function executeRun(spec, counters, { decisionFor = r => decide(r, counters), timeoutS = ROUND_TIMEOUT_S, extraEnv = {} } = {}) {
  const hex = hex8();
  const runDir = path.join(runRoot(), hex);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // outside the run dir, so round 2's reviewer never sees it
  const round1Dir = path.join(runsDir(), ".staging", `round1-${hex}`);
  const started = Date.now();
  const record = {
    id: spec.id, set: spec.set, track: spec.track, config: spec.config, reviewer: spec.reviewer, model: spec.model, effort: spec.effort,
    task: spec.task.id, repo: spec.task.repo, kind: spec.task.kind, n: spec.n, hex, attempt: counters.flags + counters.infra + counters.reviewer + counters.usage + 1,
    pinned: { tag: PINNED_TAG, sha: PINNED_SHA }, run_dir: runDir, run_root: runRoot(), real_home: realHome(),
    started_at: new Date(started).toISOString(),
  };
  let profile = null;
  let ws = null;
  let sessionDir = null;
  let beginRes = null;
  let waitRes = null;
  let round2 = null;
  let errorLog = "";
  let leased = false;
  try {
    // F14: the run's own database and Redis db, caches and JDK 21, for deps and for the reviewer's tests
    let svcEnv = {};
    if (needsServices(spec.task.repoConfig)) { svcEnv = await provisionRun(hex); leased = true; }
    const env = { ...toolchainEnv(), ...svcEnv, ...extraEnv };
    profile = buildProfile(runDir, { env });
    record.tmpdir = profile.tmp;
    // a CLI update mid-batch shows here (Phase 19 logs it)
    record.cli_version = await cliVersion(spec.reviewer, { env: profile.env });
    ws = await materialize(spec.task, runDir, { env });
    record.workspace = ws;
    record.corpus_sha = await corpusCommit(spec.task.repoDir).catch(() => null);
    const inputFile = path.join(runDir, "input.md");
    fs.writeFileSync(inputFile, reviewInput(spec.task));
    beginRes = await begin(ws, { reviewer: spec.reviewer, model: spec.model, effort: spec.effort, inputFile, env: profile.env, timeoutS });
    sessionDir = beginRes.json?.session_dir ?? null;
    if (sessionDir) {
      waitRes = await waitDone(sessionDir, { env: profile.env });
      await snapshotRound1(round1Dir, { waitJson: waitRes.json, ws, sessionDir });
      record.round1_archived_ms = Date.now();
      // F10: Track B rides on config high, after a completed round 1 with a verdict
      const r1 = classify({ beginCode: beginRes.code, beginJson: beginRes.json, waitJson: waitRes.json });
      const scenario = spec.config === "high" && r1.class === "ok" ? scenarioFor(spec.task, spec.n) : null;
      if (scenario) round2 = await secondRound(spec, scenario, { round1: waitRes.json, ws, sessionDir, runDir, env: profile.env, record });
      await end(sessionDir, { env: profile.env });
      try { errorLog = fs.readFileSync(path.join(sessionDir, "error.log"), "utf8").slice(-20_000); } catch {}
    } else {
      errorLog = `${beginRes.stdout ?? ""}\n${beginRes.stderr ?? ""}`.slice(-20_000);
    }
  } catch (e) {
    errorLog += `\nharness: ${e.message}`;
    beginRes ??= { code: 1, json: { status: "error", code: "HARNESS_ERROR", error: e.message } };
    // a harness fault during round 2 (a patch that does not apply) is infra, not a review result
    if (record.track_b?.status === "run" && !record.track_b.class) Object.assign(record.track_b, { class: "infra", class_reason: "harness_error" });
    if (sessionDir) await end(sessionDir, { env: profile.env }).catch(() => {});
  }

  // F4 before the archive, so run.json and errors.log carry its outcome; again in finally if anything threw
  let wroteBack = false;
  const writeBack = () => {
    if (!profile || wroteBack) return;
    wroteBack = true;
    try {
      record.codex_write_back = codexWriteBack(profile.home).written;
    } catch (e) {
      record.codex_write_back = false;
      errorLog += `\nwrite-back: ${e.message}`;
    }
  };

  let result;
  let decision;
  try {
    const round1 = classify({ beginCode: beginRes?.code ?? 1, beginJson: beginRes?.json, waitJson: waitRes?.json ?? null, errorLog: [waitRes?.error, errorLog].filter(Boolean).join("\n") });
    result = round1;
    // a round 2 that did not get to answer (infra, deadline, stall) retries the whole run under the
    // same rules; round 1 is redrawn, which its own result never decided
    const tb = record.track_b;
    if (round1.class === "ok" && tb?.class && !["ok", "reviewer_malformed"].includes(tb.class)) result = { class: tb.class, reason: tb.class_reason, round: 2 };
    const audit = sessionDir
      ? auditRun(sessionDir, spec.reviewer, { runDir, workspace: ws, realHome: realHome(), runRoot: runRoot(), tmpdir: profile?.tmp, upstream: upstreamFragments(spec.task) })
      : { flagged: false, hits: [], checked: 0, unparsed: 0 };
    result.flagged = audit.flagged;
    decision = decisionFor(result);
    const ended = Date.now();
    const final = decision === "final" || decision === "contaminated";
    Object.assign(record, {
      ended_at: new Date(ended).toISOString(), started_ms: started, ended_ms: ended, wall_s: Math.round((ended - started) / 1000),
      // `class` is round 1's (Track A); a final round 2 failure stays in track_b.class
      class: decision === "contaminated" ? "contaminated" : final ? round1.class : result.class, reason: final ? round1.reason : result.reason, decision,
      final,
      verdict: waitRes?.json?.review?.verdict?.status ?? null,
      issues: waitRes?.json?.review?.blocks?.length ?? 0,
      flagged: audit.flagged,
    });
    // a final run is round 1's result, as run.json records it; the batch summary counts that
    if (final) result = { ...round1, flagged: audit.flagged };
    writeBack();

    if (decision === "final" || decision === "requeue_flagged" || decision === "contaminated" || decision === "infra_exhausted") {
      const files = {
        "run.json": JSON.stringify(record, null, 2) + "\n",
        "audit.json": JSON.stringify(audit, null, 2) + "\n",
        "wait.json": JSON.stringify(waitRes?.json ?? null, null, 2) + "\n",
        "errors.log": errorLog,
        ...(round2?.files ?? {}),
      };
      // the workspace as the run left it (after round 2's patches); round1/ holds it as round 1 saw it
      if (ws) {
        files["workspace.diff"] = await gitText(["diff"], ws);
        files["workspace.status"] = await gitText(["status", "--porcelain"], ws);
      }
      const dirs = { session: sessionDir, round1: fs.existsSync(round1Dir) ? round1Dir : null };
      if (decision === "requeue_flagged" || decision === "contaminated") archive(flaggedPath(spec.id, hex), { files, dirs });
      if (decision !== "requeue_flagged") archive(runPath(spec.id), { files, dirs });
    }
  } finally {
    writeBack();
    if (leased) await releaseRun(hex).catch(() => {});
    safeRemove(runDir);
    fs.rmSync(round1Dir, { recursive: true, force: true });
  }
  return { result, decision, hex, record };
}

const realSleep = ms => new Promise(r => setTimeout(r, ms));

/** Capacity: refuse a batch when the archive's disk has less than minFree bytes free. */
export function checkFreeDisk(minFree = MIN_FREE_BYTES) {
  if (!(minFree > 0)) return;
  fs.mkdirSync(runsDir(), { recursive: true });
  const s = fs.statfsSync(runsDir());
  const free = s.bavail * s.bsize;
  if (free < minFree) throw new Error(`only ${(free / 1e9).toFixed(1)} GB free under ${runsDir()}; a batch needs ${(minFree / 1e9).toFixed(0)} GB (Capacity). Nothing was started.`);
}

/**
 * Run a batch. Each reviewer (or `spec.queue`: a Track C loop queues by its orchestrator) has its own
 * queue served by `concurrency[queue]` workers. Finished runs of the set are skipped. opts:
 * { concurrency, execute(spec, counters), retry, sleep, now, minFreeBytes, onEvent(e) }. Resolves the summary.
 */
/**
 * Why a batch should start no new run now, or null: a `pause` file in the bench home, or a running
 * process whose command line matches CRB_YIELD_TO (pgrep -f), such as another project's performance
 * run on the same machine. Runs already started finish; their timing is not disturbed by stopping them.
 */
export function defaultHold() {
  const file = path.join(crbHome(), "pause");
  if (fs.existsSync(file)) return `pause file ${file}`;
  const pattern = process.env.CRB_YIELD_TO;
  if (pattern) {
    const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    const pids = (r.stdout ?? "").split("\n").filter(p => p && Number(p) !== process.pid);
    if (pids.length) return `${pattern} is running (pid ${pids.join(", ")})`;
  }
  return null;
}

export async function runBatch(runs, opts = {}) {
  const concurrency = { ...DEFAULT_CONCURRENCY, ...(opts.concurrency ?? {}) };
  const retry = { ...RETRY, ...(opts.retry ?? {}) };
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const execute = opts.execute ?? ((spec, counters) => executeRun(spec, counters, { decisionFor: r => decide(r, counters, retry) }));
  const emit = opts.onEvent ?? (() => {});
  const hold = opts.hold ?? defaultHold;
  const holdPollMs = opts.holdPollMs ?? 60_000;
  let holding = null; // the reason of the hold in force, emitted once per hold

  checkFreeDisk(opts.minFreeBytes);

  const summary = { planned: runs.length, skipped: 0, done: 0, reviewer_failures: 0, infra_failures: 0, flagged: 0, contaminated: 0, infra_exhausted: 0 };
  const queues = {};
  for (const spec of runs) {
    if (isDone(spec.id)) { summary.skipped++; continue; }
    // flags survive the batch: a run flagged by an earlier batch or a re-audit is contaminated at its next flag
    (queues[spec.queue ?? spec.reviewer] ??= []).push({ spec, counters: { flags: flaggedAttempts(spec.id), infra: 0, reviewer: 0, usage: 0 }, notBefore: 0 });
  }
  const pause = {};      // reviewer -> pausedUntil (ms)
  const usageStreak = {}; // reviewer -> consecutive usage limits

  async function worker(reviewer) {
    const q = queues[reviewer];
    for (;;) {
      if (!q.length) return;
      const t = now();
      const wait = Math.max(pause[reviewer] ?? 0, Math.min(...q.map(j => j.notBefore))) - t;
      if (wait > 0) { await sleep(wait); continue; }
      const reason = hold();
      if (reason) {
        if (!holding) emit({ type: "hold", reason });
        holding = reason;
        await sleep(holdPollMs);
        continue;
      }
      if (holding) {
        holding = null;
        emit({ type: "resume" });
      }
      const idx = q.findIndex(j => j.notBefore <= t);
      const job = q.splice(idx, 1)[0];
      emit({ type: "start", id: job.spec.id, attempt: job.counters });
      let out;
      try {
        out = await execute(job.spec, { ...job.counters });
      } catch (e) {
        out = { result: { class: "infra", reason: "harness_error", flagged: false, error: e.message }, decision: decide({ class: "infra", reason: "harness_error" }, job.counters, retry) };
      }
      const { result, decision } = out;
      emit({ type: "end", id: job.spec.id, result, decision });
      if (result.flagged) summary.flagged++;
      if (result.class === "infra") summary.infra_failures++;
      if (result.reason !== "usage_limit") usageStreak[reviewer] = 0;
      switch (decision) {
        case "final":
          summary.done++;
          if (REVIEWER_FAILURES.includes(result.class)) summary.reviewer_failures++;
          break;
        case "contaminated":
          summary.done++;
          summary.contaminated++;
          break;
        case "infra_exhausted":
          summary.infra_exhausted++;
          break;
        case "requeue_flagged":
          job.counters.flags++;
          q.push(job);
          break;
        case "retry_reviewer":
          job.counters.reviewer++;
          q.push(job);
          break;
        case "retry_usage": {
          job.counters.usage++;
          usageStreak[reviewer] = (usageStreak[reviewer] ?? 0) + 1;
          const delay = Math.min(retry.usageBaseMs * 2 ** (usageStreak[reviewer] - 1), retry.usageMaxMs);
          pause[reviewer] = Math.max(pause[reviewer] ?? 0, now() + delay);
          emit({ type: "pause", reviewer, until: pause[reviewer] });
          q.unshift(job);
          break;
        }
        case "retry_infra":
          job.counters.infra++;
          job.notBefore = now() + retry.infraDelayMs;
          q.push(job);
          break;
        default:
          throw new Error(`unknown decision ${decision}`);
      }
    }
  }

  await Promise.all(Object.keys(queues).flatMap(r => Array.from({ length: Math.max(1, concurrency[r] ?? 1) }, () => worker(r))));
  return summary;
}

/** Task selection for `--tasks`: comma-separated globs over `<repo>/<task-id>` (and `realbugs/<id>`), or a file of such lines. */
export function selectTaskDirs(spec, corpus = corpusRoot()) {
  const all = [];
  const tasksDir = path.join(corpus, "tasks");
  if (fs.existsSync(tasksDir)) {
    for (const repo of fs.readdirSync(tasksDir).sort()) {
      const rd = path.join(tasksDir, repo);
      if (!fs.statSync(rd).isDirectory()) continue;
      for (const t of fs.readdirSync(rd).sort()) if (fs.existsSync(path.join(rd, t, "task.json"))) all.push({ key: `${repo}/${t}`, dir: path.join(rd, t) });
    }
  }
  const rb = path.join(corpus, "realbugs");
  if (fs.existsSync(rb)) for (const t of fs.readdirSync(rb).sort()) if (fs.existsSync(path.join(rb, t, "task.json"))) all.push({ key: `realbugs/${t}`, dir: path.join(rb, t) });

  let lines = [spec];
  if (fs.existsSync(spec) && fs.statSync(spec).isFile()) lines = fs.readFileSync(spec, "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  // several globs may share a line, comma-separated
  const patterns = lines.flatMap(l => l.split(",")).map(p => p.trim()).filter(Boolean);
  const toRe = g => new RegExp(`^${g.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
  const res = patterns.map(toRe);
  return all.filter(t => res.some(r => r.test(t.key))).map(t => t.dir);
}
