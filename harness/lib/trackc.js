// Track C (F11): an orchestrator (Claude Code or Codex) fixes a buggy PR end to end, with the
// pinned cross-review installed in its clean profile and one reviewer cell (codex, claude, agy) or
// none; the hidden tests then say which bugs it fixed (F20) and the visible tests whether it broke
// anything.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { run, sh, tail, cleanEnv, interrupted } from "./exec.js";
import { BENCH_ROOT, pinnedRoot, runRoot, realHome, PINNED_TAG, PINNED_SHA } from "./paths.js";
import { CONFIGS, RETRY } from "./config.js";
import { runId, archive, runPath, flaggedPath } from "./store.js";
import { buildProfile, codexWriteBack } from "./profile.js";
import { materialize, corpusCommit } from "./workspace.js";
import { infraReason } from "./failures.js";
import { auditRun, auditLogs } from "./audit.js";
import { stop, cliVersion } from "./review.js";
import { needsServices, provisionRun, releaseRun } from "./services.js";
import { toolchainEnv } from "./cache.js";
import { copyHidden, removeHidden } from "./validate.js";
import { decide, safeRemove } from "./scheduler.js";

/** F11: the orchestrators at `high`; the reviewer cells use their F5 `high` settings. */
export const ORCHESTRATORS = {
  claude: { model: "claude-opus-5-5", effort: "high" },
  codex: { model: "gpt-6-astra", effort: "high" },
};
export const CELLS = ["codex", "claude", "agy", "none"];
/** Capacity: one loop's deadline. */
export const LOOP_TIMEOUT_S = 10_800;
const TEST_TIMEOUT_MS = 1_800_000;

/** Every task × orchestrator × cell, N = 1. Run ids put `<orchestrator>-<cell>` in the reviewer slot. */
export function planLoops({ set, tasks, orchestrators, cells }) {
  for (const o of orchestrators) if (!ORCHESTRATORS[o]) throw new Error(`orchestrator must be one of ${Object.keys(ORCHESTRATORS).join(", ")} (got ${o})`);
  for (const c of cells) if (!CELLS.includes(c)) throw new Error(`cell must be one of ${CELLS.join(", ")} (got ${c})`);
  for (const t of tasks) if (t.kind !== "buggy") throw new Error(`Track C runs buggy tasks only (${t.id} is ${t.kind})`);
  const loops = [];
  for (const task of tasks) {
    for (const orchestrator of orchestrators) {
      for (const cell of cells) {
        const reviewer = `${orchestrator}-${cell}`;
        loops.push({
          id: runId({ set, track: "C", config: "high", reviewer, task: task.id, n: 1 }),
          set, track: "C", config: "high", reviewer, orchestrator, cell, queue: orchestrator,
          ...ORCHESTRATORS[orchestrator], task, n: 1,
        });
      }
    }
  }
  return loops;
}

/** The run home's ~/.cross-review/config.json for a cell; none for `none`. */
export function cellConfig(cell) {
  if (cell === "none") return null;
  return { reviewer: cell, reviewers: { [cell]: { model: CONFIGS.high[cell].model, effort: "high" } } };
}

/** The loop's prompt: run review-impl (`/review-impl` in Claude Code, `$review-impl` in Codex), or review alone. */
export function loopPrompt(task, orchestrator, cell) {
  const file = path.join(BENCH_ROOT, "harness", "prompts", cell === "none" ? "trackc-none.md" : "trackc-review.md");
  const skill = orchestrator === "codex" ? "$review-impl" : "/review-impl";
  return fs.readFileSync(file, "utf8").replaceAll("{DESCRIPTION}", task.description.trim()).replaceAll("{SKILL}", skill);
}

/** Install the pinned cross-review into the run home (spike S6). Resolves what got installed. */
export async function installPinned(home, env) {
  const r = await run(process.execPath, [path.join(pinnedRoot(), "bin", "cross-review.js")], {
    env: { ...env, HOME: home, CODEX_HOME: path.join(home, ".codex") }, timeoutMs: 600_000,
  });
  const has = p => fs.existsSync(path.join(home, p));
  const skills = has(".claude/skills/review-impl/SKILL.md") && has(".agents/skills/review-impl/SKILL.md") && has(".claude/skills/cross-review/node_modules");
  if (r.code !== 0 || !skills) throw new Error(`cross-review install into the run home failed (exit ${r.code}): ${tail(r, 8)}`);
  let claudeMcp = false;
  try { claudeMcp = Boolean(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).mcpServers?.["cross-review"]); } catch {}
  let codexMcp = false;
  try { codexMcp = /\[mcp_servers\.(?:"cross-review"|cross-review)\]/.test(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")); } catch {}
  return { skills, claude_mcp: claudeMcp, codex_mcp: codexMcp };
}

async function adapter(name) {
  return import(pathToFileURL(path.join(pinnedRoot(), "skill-packs", "cross-review", "scripts", "lib", "reviewers", `${name}.js`)).href);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const groupAlive = pgid => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

/** End a process group: SIGTERM, then SIGKILL after `graceMs`; resolves once no member is left. */
async function endGroup(pgid, graceMs) {
  if (!groupAlive(pgid)) return;
  try { process.kill(-pgid, "SIGTERM"); } catch {}
  for (const end = Date.now() + graceMs; groupAlive(pgid) && Date.now() < end;) await sleep(50);
  try { process.kill(-pgid, "SIGKILL"); } catch {}
  for (const end = Date.now() + 5000; groupAlive(pgid) && Date.now() < end;) await sleep(50);
}

/**
 * Spawn the orchestrator with the pinned adapter's command line (full access), the prompt on stdin
 * and its event log streamed to logFile. Resolves { code, signal, timedOut } once the orchestrator
 * and every process it left in its group are gone (on a timeout and after a normal exit alike), so
 * nothing it started runs while the workspace is tested.
 */
export async function spawnOrchestrator(orchestrator, ws, prompt, { env, timeoutMs, logFile, errFile, killGraceMs = 10_000 }) {
  const a = await adapter(orchestrator);
  const { model, effort } = ORCHESTRATORS[orchestrator];
  const { cmd, args, cwd } = a.buildCommand({ threadId: null, workingDir: ws, model, effort, sandbox: a.fullAccessSandbox });
  // F19: the orchestrator's own review_begin must not look like a nested review
  const { CROSS_REVIEW_REVIEWER, NODE_TEST_CONTEXT, ...childEnv } = env;
  const out = fs.openSync(logFile, "w");
  const err = fs.openSync(errFile, "w");
  let pgid = null;
  let ending = null;
  try {
    const res = await new Promise(resolve => {
      const child = spawn(cmd, args, { cwd: cwd ?? ws, env: childEnv, detached: true, stdio: ["pipe", out, err] });
      pgid = child.pid ?? null;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ending = endGroup(child.pid, killGraceMs);
      }, timeoutMs);
      child.on("error", e => { clearTimeout(timer); resolve({ code: 127, signal: null, timedOut, error: e.message }); });
      child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut }); });
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    });
    await ending;
    if (pgid) await endGroup(pgid, killGraceMs);
    return res;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}

/** The orchestrator's turn from its event log, through the pinned adapter's parser. */
export async function parseOrchestratorLog(orchestrator, logFile) {
  const a = await adapter(orchestrator);
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(l => l.trim()) : [];
  const { turnCompleted, turnFailed, failMessage, threadId, reviewText } = a.parseEvents(lines, [], 0);
  return { turnCompleted, turnFailed, failMessage: failMessage ?? null, threadId: threadId ?? null, finalText: reviewText ?? null, lines: lines.length };
}

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

function sessionErrors(sd) {
  const files = ["error.log", "final.txt"];
  try { files.push(...fs.readdirSync(path.join(sd, "outputs")).filter(f => /^final-round-\d+\.json$/.test(f)).sort().map(f => path.join("outputs", f))); } catch {}
  return files.map(f => { try { return fs.readFileSync(path.join(sd, f), "utf8").slice(-20_000); } catch { return ""; } }).join("\n");
}

/** The review sessions the loop ran (`<ws>/.cross-review/sessions/*`): reviewer, rounds, and infra faults in them. */
export function readSessions(ws) {
  const dir = path.join(ws, ".cross-review", "sessions");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const sd = path.join(dir, name);
    const state = readJson(path.join(sd, "state.json"));
    if (!state) continue;
    const rounds = readJson(path.join(sd, "rounds.json")) ?? [];
    // a turn that failed or never started is the reviewer CLI's fault (as in Track A); a timeout or a
    // stall is the reviewer's own time and stays scored. The error text is in error.log and final.txt
    // (outputs/final-round-NNN.json once a later round archived it), never in rounds.json.
    const failed = rounds.filter(r => r.status === "failed" || r.status === "start_failed");
    const fault = failed.length || !rounds.length ? infraReason(sessionErrors(sd)) ?? "reviewer_failed" : null;
    out.push({ dir: sd, name, skill: state.skill_name, reviewer: state.reviewer ?? "codex", model: state.model ?? null, effort: state.effort ?? null, rounds: rounds.length, statuses: rounds.map(r => r.status), infra: fault });
  }
  return out;
}

/** Stop every review session in ws (`stop` is safe on a finished one: it kills nothing that is not the session's). */
async function stopSessions(ws, env) {
  const dir = path.join(ws, ".cross-review", "sessions");
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch { return; }
  for (const name of names) await stop(path.join(dir, name), { env });
}

/**
 * The loop's class (I10, Capacity): infra when the orchestrator or a reviewer it used could not
 * work (missing CLI, usage limit, auth, network, a failed turn), reviewer_timeout at the loop
 * deadline, else ok.
 */
export function classifyLoop({ spawnRes, events, sessions, stderr = "" }) {
  if (spawnRes.code === 127 && !events.lines) return { class: "infra", reason: "orchestrator_not_found" };
  const fault = sessions.find(s => s.infra);
  if (fault) return { class: "infra", reason: fault.infra, source: `${fault.reviewer} review` };
  if (spawnRes.timedOut) return { class: "reviewer_timeout", reason: "loop_deadline" };
  if (events.turnCompleted && !events.turnFailed && spawnRes.code === 0) return { class: "ok", reason: "completed" };
  const why = infraReason([events.failMessage, stderr].filter(Boolean).join("\n"));
  return { class: "infra", reason: why ?? "orchestrator_failed" };
}

/**
 * Test the workspace the loop left (F20): the visible tests first, with no hidden file present;
 * then each testable bug's hidden tests alone, copied in for their own check and removed after (a
 * file the orchestrator left at that path is put back).
 */
export async function testWorkspace(task, ws, env, { timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const testEnv = cleanEnv(env);
  const visibleCmd = task.visible_test_cmd ?? task.repoConfig.test_cmd;
  const v = await sh(visibleCmd, { cwd: ws, env: testEnv, timeoutMs });
  const visible = { cmd: visibleCmd, code: v.code, interrupted: interrupted(v), tail: tail(v, 20) };
  const bugs = [];
  for (const bug of [...task.bugs].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))) {
    if (!bug.testable) { bugs.push({ id: bug.id, testable: false, fixed: null }); continue; }
    const saved = new Map();
    for (const rel of bug.hidden_tests) {
      const p = path.join(ws, rel);
      if (fs.lstatSync(p, { throwIfNoEntry: false })?.isFile()) saved.set(p, fs.readFileSync(p));
    }
    let entry;
    try {
      copyHidden(task, ws, bug.hidden_tests);
      const r = await sh(bug.hidden_test_cmd, { cwd: ws, env: testEnv, timeoutMs });
      entry = { id: bug.id, testable: true, fixed: r.code === 0 && !interrupted(r), code: r.code, interrupted: interrupted(r), tail: tail(r, 20) };
    } catch (e) {
      entry = { id: bug.id, testable: true, fixed: false, error: e.message };
    } finally {
      try { removeHidden(ws, bug.hidden_tests); } catch {}
      for (const [p, data] of saved) fs.writeFileSync(p, data);
    }
    bugs.push(entry);
  }
  return {
    visible_ok: v.code === 0 && !interrupted(v), visible, bugs,
    bugs_fixed: bugs.filter(b => b.fixed).map(b => b.id), bugs_testable: bugs.filter(b => b.testable).length,
  };
}

/**
 * Audit a loop: the orchestrator's own log in its format, and every review session it ran in that
 * session's reviewer's. Works on a live run and on an archive (`orchestrator.jsonl`, `sessions/`).
 */
export function auditLoop({ orchestrator, logFile, sessionsDir, ctx }) {
  const sessions = sessionsDir && fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).sort().map(n => path.join(sessionsDir, n)).filter(d => fs.existsSync(path.join(d, "state.json"))) : [];
  const parts = [
    auditLogs(logFile && fs.existsSync(logFile) ? [logFile] : [], orchestrator, ctx),
    ...sessions.map(d => auditRun(d, readJson(path.join(d, "state.json"))?.reviewer ?? "codex", ctx)),
  ];
  return { flagged: parts.some(p => p.flagged), hits: parts.flatMap(p => p.hits), checked: parts.reduce((n, p) => n + p.checked, 0), unparsed: parts.reduce((n, p) => n + p.unparsed, 0) };
}

async function gitText(args, cwd) {
  const r = await run("git", args, { cwd, env: cleanEnv() });
  return r.code === 0 ? r.stdout : "";
}

/** Everything the loop changed against the imported base, committed or not, new files included. */
async function loopDiff(ws) {
  const root = (await gitText(["rev-list", "--max-parents=0", "HEAD"], ws)).trim().split("\n")[0];
  await run("git", ["add", "-A"], { cwd: ws, env: cleanEnv() });
  return { diff: root ? await gitText(["diff", "--cached", root], ws) : "", log: await gitText(["log", "--oneline"], ws) };
}

const hex8 = () => crypto.randomBytes(4).toString("hex");

/**
 * One attempt of one Track C loop: services, clean profile with the pinned cross-review installed and
 * the cell's config, workspace, the orchestrator, tests, audit, classify, archive, Codex write-back,
 * cleanup. Resolves { result, decision, hex, record } like executeRun.
 */
export async function runTrackC(spec, counters, { decisionFor = r => decide(r, counters, RETRY), timeoutS = LOOP_TIMEOUT_S, extraEnv = {} } = {}) {
  const hex = hex8();
  const runDir = path.join(runRoot(), hex);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const started = Date.now();
  const cellCfg = cellConfig(spec.cell);
  const record = {
    id: spec.id, set: spec.set, track: "C", config: spec.config, reviewer: spec.reviewer, orchestrator: spec.orchestrator, cell: spec.cell,
    model: spec.model, effort: spec.effort, cell_config: cellCfg,
    task: spec.task.id, repo: spec.task.repo, kind: spec.task.kind, n: spec.n, hex, attempt: counters.flags + counters.infra + counters.reviewer + counters.usage + 1,
    pinned: { tag: PINNED_TAG, sha: PINNED_SHA }, run_dir: runDir, run_root: runRoot(), real_home: realHome(),
    started_at: new Date(started).toISOString(),
  };
  const logFile = path.join(runDir, "orchestrator.jsonl");
  const errFile = path.join(runDir, "orchestrator.stderr");
  let profile = null;
  let ws = null;
  let leased = false;
  let prompt = "";
  let tests = null;
  let sessions = [];
  let result = null;
  let errorLog = "";
  try {
    let svcEnv = {};
    if (needsServices(spec.task.repoConfig)) { svcEnv = await provisionRun(hex); leased = true; }
    // F19: nothing of the loop — installer, orchestrator, tests — runs as if inside a reviewer
    const { CROSS_REVIEW_REVIEWER, ...env } = { ...toolchainEnv(), ...svcEnv, ...extraEnv };
    profile = buildProfile(runDir, { env });
    record.tmpdir = profile.tmp;
    record.cli_version = { [spec.orchestrator]: await cliVersion(spec.orchestrator, { env: profile.env }) };
    if (spec.cell !== "none" && spec.cell !== spec.orchestrator) record.cli_version[spec.cell] = await cliVersion(spec.cell, { env: profile.env });
    record.install = await installPinned(profile.home, profile.env);
    if (cellCfg) {
      fs.mkdirSync(path.join(profile.home, ".cross-review"), { recursive: true });
      fs.writeFileSync(path.join(profile.home, ".cross-review", "config.json"), JSON.stringify(cellCfg, null, 2) + "\n");
    }
    ws = await materialize(spec.task, runDir, { env });
    record.workspace = ws;
    record.corpus_sha = await corpusCommit(spec.task.repoDir).catch(() => null);
    prompt = loopPrompt(spec.task, spec.orchestrator, spec.cell);
    const loopStarted = Date.now();
    const spawnRes = await spawnOrchestrator(spec.orchestrator, ws, prompt, { env: profile.env, timeoutMs: timeoutS * 1000, logFile, errFile });
    record.loop_s = Math.round((Date.now() - loopStarted) / 1000);
    const events = await parseOrchestratorLog(spec.orchestrator, logFile);
    sessions = readSessions(ws);
    // the reviewers run detached: a review the orchestrator left running must not outlive the loop or touch the tests
    await stopSessions(ws, profile.env);
    let stderr = "";
    try { stderr = fs.readFileSync(errFile, "utf8").slice(-20_000); } catch {}
    result = classifyLoop({ spawnRes, events, sessions, stderr });
    Object.assign(record, { exit_code: spawnRes.code, signal: spawnRes.signal ?? null, timed_out: spawnRes.timedOut, turn_completed: events.turnCompleted, fail_message: events.failMessage });
    if (spawnRes.error) errorLog += `\nspawn: ${spawnRes.error}`;
    // the loop's outcome is scored for a completed loop and for one the deadline ended
    if (result.class === "ok" || result.class === "reviewer_timeout") tests = await testWorkspace(spec.task, ws, env);
  } catch (e) {
    errorLog += `\nharness: ${e.message}`;
    result = { class: "infra", reason: "harness_error" };
  }

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

  let decision;
  try {
    const ctx = { runDir, workspace: ws ?? runDir, realHome: realHome(), runRoot: runRoot(), tmpdir: profile?.tmp, upstream: [] };
    const audit = auditLoop({ orchestrator: spec.orchestrator, logFile, sessionsDir: ws ? path.join(ws, ".cross-review", "sessions") : null, ctx });
    result.flagged = audit.flagged;
    decision = decisionFor(result);
    const ended = Date.now();
    Object.assign(record, {
      ended_at: new Date(ended).toISOString(), started_ms: started, ended_ms: ended, wall_s: Math.round((ended - started) / 1000),
      class: decision === "contaminated" ? "contaminated" : result.class, reason: result.reason, decision,
      final: decision === "final" || decision === "contaminated",
      bugs_fixed: tests?.bugs_fixed ?? [], bugs_testable: tests?.bugs_testable ?? null, visible_ok: tests?.visible_ok ?? null,
      review_rounds: sessions.reduce((n, s) => n + s.rounds, 0), sessions: sessions.length,
      reviewers_used: [...new Set(sessions.map(s => s.reviewer))],
      flagged: audit.flagged,
    });
    writeBack();

    if (decision === "final" || decision === "requeue_flagged" || decision === "contaminated" || decision === "infra_exhausted") {
      const files = {
        "run.json": JSON.stringify(record, null, 2) + "\n",
        "audit.json": JSON.stringify(audit, null, 2) + "\n",
        "tests.json": JSON.stringify(tests, null, 2) + "\n",
        "sessions.json": JSON.stringify(sessions.map(({ dir, ...s }) => s), null, 2) + "\n",
        "prompt.md": prompt,
        "errors.log": errorLog,
      };
      for (const [name, f] of [["orchestrator.jsonl", logFile], ["orchestrator.stderr", errFile]]) {
        try { files[name] = fs.readFileSync(f, "utf8"); } catch {}
      }
      if (ws) {
        const { diff, log } = await loopDiff(ws);
        files["workspace.diff"] = diff;
        files["workspace.log"] = log;
      }
      const dirs = { sessions: ws ? path.join(ws, ".cross-review", "sessions") : null };
      if (decision === "requeue_flagged" || decision === "contaminated") archive(flaggedPath(spec.id, hex), { files, dirs });
      if (decision !== "requeue_flagged") archive(runPath(spec.id), { files, dirs });
    }
  } finally {
    if (ws && profile) await stopSessions(ws, profile.env).catch(() => {});
    writeBack();
    if (leased) await releaseRun(hex).catch(() => {});
    safeRemove(runDir);
  }
  return { result, decision, hex, record };
}
