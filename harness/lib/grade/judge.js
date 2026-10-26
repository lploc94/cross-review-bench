// The blind judge panel (F12): per task, one call per judge with the workspace (base + PR), the
// answer key and every anonymized finding of the set; the judges never see reviewer names, configs
// or run numbers. Judges run in clean profiles through the pinned runner's low-level verbs
// `init --skill-name crb-judge` → `start --sandbox read-only` → `poll` (F19).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BENCH_ROOT, pinnedRunner, runRoot, realHome, gradingDir, corpusRoot } from "../paths.js";
import { run } from "../exec.js";
import { DEFAULT_CONCURRENCY, RETRY } from "../config.js";
import { buildProfile, codexWriteBack } from "../profile.js";
import { materialize } from "../workspace.js";
import { toolchainEnv } from "../cache.js";
import { infraReason } from "../failures.js";
import { auditRun } from "../audit.js";
import { runBatch, decide, safeRemove } from "../scheduler.js";
import { collectFindings, readJson, writeJson, keysHash, contentHash, findingSig, loadEntryTask } from "./collect.js";

/** Judges by set (F12, F17): the three contestants at `high`; smoke and calibration use Sonnet alone. */
const CONTESTANTS = [
  { name: "codex", reviewer: "codex", model: "gpt-6-astra", effort: "high" },
  { name: "claude", reviewer: "claude", model: "claude-opus-5-5", effort: "high" },
  { name: "agy", reviewer: "agy", model: "gemini-4-argon", effort: "high" },
];
const SONNET = { name: "claude", reviewer: "claude", model: "claude-sonnet-5-5", effort: "high" };
export const JUDGES_BY_SET = { pilot: CONTESTANTS, final: CONTESTANTS, smoke: [SONNET], calibration: [SONNET] };
/** The dedupe helper (F17). */
export const HELPER = SONNET;

/** Capacity: one judge call's deadline, and parse failures allowed per call (1 + 2 retries). */
export const JUDGE_TIMEOUT_S = 3600;
export const JUDGE_ATTEMPTS = 3;
/**
 * Silence a judge may keep before the runner calls it stalled: a judge writes its whole answer in
 * one final message, and for a task with 100+ findings that took over 3 min, the runner's default
 * (12 polls), so every attempt stalled (final set, 4 of 459 calls). The 1 h deadline still bounds a hung CLI.
 */
export const JUDGE_STALL_S = 1200;
const POLL_MS = 15_000;
export const VALID = ["real", "not_real", "uncertain"];

export function judgesFor(set) {
  const judges = JUDGES_BY_SET[set];
  if (!judges) throw new Error(`no judges for set ${set}`);
  return judges;
}

export const judgmentsDir = set => path.join(gradingDir(set), "judgments");
export const judgmentFile = (set, taskId, label) => path.join(judgmentsDir(set), taskId, `${label}.json`);
export const panelFile = set => path.join(gradingDir(set), "panel.json");

export function render(name, values) {
  const text = fs.readFileSync(path.join(BENCH_ROOT, "harness", "prompts", `${name}.md`), "utf8");
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in values ? values[k] : m));
}

const lines = l => (l[0] === l[1] ? `${l[0]}` : `${l[0]}-${l[1]}`);

/** The answer key as the judges read it: bugs (planted and pooled) and decoys. */
export function answerKeyText(task, pooled = [], { only = null } = {}) {
  const bugs = only ? [] : task.bugs ?? [];
  const decoys = only ? [] : task.decoys ?? [];
  const pool = only ?? pooled;
  const out = [];
  if (bugs.length || pool.length) {
    out.push("Known defects in this pull request (bugs):", "");
    for (const b of bugs) out.push(`- ${b.id} — \`${b.file}:${lines(b.lines)}\`, severity ${b.severity}: ${b.summary.trim()} Trigger: ${String(b.trigger ?? "").trim()}`);
    for (const p of pool) out.push(`- ${p.id} — \`${p.file}:${lines(p.lines)}\`, severity ${p.severity}: ${p.summary.trim()}`);
  } else {
    out.push("No known defects in this pull request (bugs): none listed. Judge each finding on the code alone.");
  }
  if (decoys.length) {
    out.push("", "Code that looks wrong but is correct (decoys):", "");
    for (const d of decoys) out.push(`- ${d.id} — \`${d.file}:${lines(d.lines)}\`: looks like ${d.looks_like.trim()}; correct because ${d.why_correct.trim()}`);
  }
  return out.join("\n");
}

/** Workspace states: S0 is the PR; each distinct set of round-2 patches is another state. */
export function statesFor(findings, task) {
  const ids = new Map([["", "S0"]]);
  const text = ["- S0: the pull request, exactly as in your working directory."];
  for (const f of findings) {
    const k = (f.state ?? []).join("\n");
    if (ids.has(k)) continue;
    const id = `S${ids.size}`;
    ids.set(k, id);
    const patches = f.state.map(p => fs.readFileSync(path.join(task.dir, p), "utf8").trimEnd());
    text.push(`- ${id}: S0 plus ${patches.length === 1 ? "this change" : "these changes"}, applied after a first review:`, ...patches.map(p => `\n\`\`\`diff\n${p}\n\`\`\``));
    if (!patches.length) text[text.length - 1] = `- ${id}: S0 unchanged, after a first review in which the author disputed some findings.`;
  }
  return { ids, text: text.join("\n") };
}

/** The judge prompt for findings of one task. `only` re-checks against these pooled bugs alone. */
export function judgePrompt(task, findings, { pooled = [], only = null } = {}) {
  const { ids, text } = statesFor(findings, task);
  const shown = findings.map(f => ({
    id: f.fid, state: ids.get((f.state ?? []).join("\n")), category: f.category, severity: f.severity, location: f.location,
    title: f.title, problem: f.problem, evidence: f.evidence, suggested_fix: f.suggested_fix,
  }));
  return render("judge", {
    TITLE: task.title.trim(), DESCRIPTION: task.description.trim(),
    ANSWER_KEY: answerKeyText(task, pooled, { only }),
    STATES: text,
    FINDINGS: JSON.stringify(shown, null, 2),
    MATCH_SCOPE: only ? "- This is a re-check against newly confirmed defects: only the ids listed in the answer key can be matched.\n" : "",
  });
}

/** The first JSON object in a model's final text: the whole text, a fenced block, or the outermost braces. */
export function extractJson(text) {
  const t = String(text ?? "").trim();
  const candidates = [t, ...[...t.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(m => m[1])];
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) candidates.push(t.slice(a, b + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {}
  }
  return null;
}

/** Schema check of a judge answer against the expected finding ids and answer-key ids. */
export function parseJudgments(text, fids, targetIds) {
  const obj = extractJson(text);
  if (!obj) return { ok: false, error: "no JSON object in the answer" };
  if (!Array.isArray(obj.judgments)) return { ok: false, error: "`judgments` is not an array" };
  const want = new Set(fids);
  const targets = new Set(targetIds);
  const out = {};
  const errors = [];
  for (const j of obj.judgments) {
    if (!j || typeof j !== "object") { errors.push("an entry is not an object"); continue; }
    if (!want.has(j.id)) { errors.push(`unknown finding id ${JSON.stringify(j.id)}`); continue; }
    if (out[j.id]) { errors.push(`${j.id} appears twice`); continue; }
    const matches = j.matches ?? [];
    if (!Array.isArray(matches) || matches.some(m => !targets.has(m))) { errors.push(`${j.id}: matches must be ids from the answer key (${[...targets].join(", ") || "none"})`); continue; }
    if (!VALID.includes(j.valid)) { errors.push(`${j.id}: valid must be one of ${VALID.join(", ")}`); continue; }
    out[j.id] = { matches: [...new Set(matches)].sort(), valid: j.valid, reason: String(j.reason ?? "").slice(0, 2000) };
  }
  for (const id of want) if (!out[id] && !errors.some(e => e.startsWith(`${id}:`))) errors.push(`${id} is missing`);
  return errors.length ? { ok: false, error: errors.slice(0, 10).join("; ") } : { ok: true, judgments: out };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runner(args, opts) {
  const r = await run(process.execPath, [pinnedRunner(), ...args], opts);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { ...r, json };
}

/**
 * One call through the pinned runner in ws: init, start (prompt on stdin, read-only sandbox), poll
 * until the turn ends. Resolves { status, text, error, sessionDir }.
 */
export async function invokeCli({ judge, ws, prompt, env, timeoutS = JUDGE_TIMEOUT_S, pollMs = POLL_MS }) {
  const init = await runner(["init", "--skill-name", "crb-judge", "--working-dir", ws, "--reviewer", judge.reviewer], { env, cwd: ws, timeoutMs: 120_000 });
  const sessionDir = init.stdout.match(/SESSION:(.+)/)?.[1]?.trim();
  if (!sessionDir) return { status: "init_failed", error: `${init.stdout}\n${init.stderr}`.trim() };
  const args = ["start", sessionDir, "--effort", judge.effort, "--sandbox", "read-only", "--timeout", String(timeoutS),
    "--stall-threshold", String(Math.max(12, Math.ceil(JUDGE_STALL_S * 1000 / pollMs)))];
  if (judge.model) args.push("--model", judge.model);
  let completed = false;
  try {
    const start = await runner(args, { env, cwd: ws, input: prompt, timeoutMs: 300_000 });
    if (start.code !== 0 || start.json?.status === "error") return { status: "start_failed", error: `${start.stdout}\n${start.stderr}`.trim(), sessionDir };
    for (;;) {
      const p = await runner(["poll", sessionDir, "--min-interval", "0"], { env, cwd: ws, timeoutMs: 300_000 });
      if (!p.json) return { status: "poll_failed", error: `${p.stdout}\n${p.stderr}`.trim(), sessionDir };
      if (p.json.status === "running") { await sleep(pollMs); continue; }
      let text = p.json.review?.raw_markdown ?? null;
      if (text == null) { try { text = fs.readFileSync(path.join(sessionDir, "review.md"), "utf8"); } catch {} }
      completed = p.json.status === "completed";
      return { status: p.json.status, text, error: p.json.error ?? null, sessionDir };
    }
  } finally {
    // whatever ended the call, the judge must not outlive its workspace
    if (!completed) await runner(["stop", sessionDir], { env, cwd: ws, timeoutMs: 120_000 }).catch(() => {});
  }
}

/**
 * The default way to ask a judge (or the dedupe helper): a fresh clean profile and a workspace of
 * the task (base + PR, no dependencies) under the run root, the call, a leakage audit of the
 * session, Codex's token write-back, cleanup. Resolves invokeCli's result plus { flagged, errorLog }.
 */
export async function cliInvoke(judge, { task, prompt, timeoutS, pollMs }) {
  const hex = crypto.randomBytes(4).toString("hex");
  const runDir = path.join(runRoot(), hex);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  let profile = null;
  try {
    const env = toolchainEnv();
    profile = buildProfile(runDir, { env });
    const ws = await materialize(task, runDir, { env, deps: false });
    const res = await invokeCli({ judge, ws, prompt, env: profile.env, timeoutS, pollMs });
    if (res.sessionDir) {
      try { res.errorLog = fs.readFileSync(path.join(res.sessionDir, "error.log"), "utf8").slice(-20_000); } catch {}
      const audit = auditRun(res.sessionDir, judge.reviewer, { runDir, workspace: ws, realHome: realHome(), runRoot: runRoot(), upstream: [] });
      res.flagged = audit.flagged;
      res.hits = audit.hits;
    }
    return res;
  } finally {
    if (profile) { try { codexWriteBack(profile.home); } catch {} }
    safeRemove(runDir);
  }
}

/**
 * Ask one judge about findings of a task; parse failures and flagged calls are retried up to
 * JUDGE_ATTEMPTS calls in all. Resolves
 *   { status: "ok", judgments: { fid: { matches, valid, reason } }, attempts }
 *   { status: "failed", attempts }            (a judge failure: its findings go to the audit queue)
 *   { status: "infra", reason, attempts }     (usage limit, auth, network: retried by the scheduler)
 */
export async function judgeTask(task, findings, judge, { invoke = cliInvoke, pooled = [], only = null, attempts = JUDGE_ATTEMPTS } = {}) {
  const prompt = judgePrompt(task, findings, { pooled, only });
  const targetIds = only ? only.map(p => p.id) : [...(task.bugs ?? []), ...(task.decoys ?? []), ...pooled].map(t => t.id);
  const fids = findings.map(f => f.fid);
  const log = [];
  for (let i = 0; i < attempts; i++) {
    const res = await invoke(judge, { task, prompt });
    const entry = { status: res.status, error: res.error ?? null, flagged: res.flagged ?? false, text: String(res.text ?? "").slice(0, 200_000) };
    log.push(entry);
    if (res.status !== "completed") {
      const why = infraReason([res.error, res.errorLog].filter(Boolean).join("\n"));
      if (why || ["init_failed", "start_failed", "poll_failed", "failed"].includes(res.status)) return { status: "infra", reason: why ?? res.status, attempts: log };
      continue; // a deadline or stall: another attempt
    }
    if (res.flagged) { entry.error = "flagged: read outside its workspace"; continue; }
    const parsed = parseJudgments(res.text, fids, targetIds);
    if (parsed.ok) return { status: "ok", judgments: parsed.judgments, attempts: log };
    entry.error = parsed.error;
  }
  return { status: "failed", attempts: log };
}

/**
 * Majority of the judges that answered, per finding: `valid` needs more than half of the votes
 * (a tie, or a majority for "uncertain", goes to audit), each match too (an even split goes to
 * audit). A match with a decoy makes the finding not real; "not real" with a bug match is
 * inconsistent and goes to audit. Fewer than a majority of the panel answering is a judge failure.
 * votes: [{ valid, matches }] of the judges that answered; panelSize: judges asked.
 */
export function panelVerdict(votes, { panelSize = votes.length, decoyIds = [] } = {}) {
  const n = votes.length;
  if (n < Math.floor(panelSize / 2) + 1) return { valid: null, matches: [], audit: "judge_failure", votes: n };
  const count = {};
  for (const v of votes) count[v.valid] = (count[v.valid] ?? 0) + 1;
  const top = Object.entries(count).find(([, c]) => c * 2 > n)?.[0] ?? null;
  let audit = top === null ? "tie" : top === "uncertain" ? "uncertain" : null;
  let valid = top === "real" || top === "not_real" ? top : null;
  const ids = [...new Set(votes.flatMap(v => v.matches))].sort();
  const matches = [];
  for (const id of ids) {
    const c = votes.filter(v => v.matches.includes(id)).length;
    if (c * 2 > n) matches.push(id);
    else if (c * 2 === n) audit ??= "tie";
  }
  if (matches.some(m => decoyIds.includes(m))) valid = "not_real";
  else if (valid === "not_real" && matches.length) audit ??= "inconsistent";
  return { valid, matches, audit, votes: n };
}

/** Whether a stored judgment is of these findings: their keys, and their content when it recorded it. */
const judgedThese = (s, hash, content) => s.keys_hash === hash && (s.content_hash === undefined || s.content_hash === content);

/** Judgments of a task by a judge label, keyed by finding key; null when missing. */
export function readJudgment(set, taskId, label) {
  return readJson(judgmentFile(set, taskId, label));
}

/**
 * The panel of one task: { key: panelVerdict } from the stored judgments of the set's judges for
 * the task's current findings. Short of a quorum, a finding is a judge failure only once every
 * judge has a judgment of those findings (answered or failed); until then it is `not_judged`.
 */
export function taskPanel(set, taskId, entry, task, judges = judgesFor(set)) {
  const decoyIds = (task.decoys ?? []).map(d => d.id);
  const hash = keysHash(entry.findings.map(f => f.key));
  const content = contentHash(entry.findings);
  const stored = judges.map(j => readJudgment(set, taskId, j.name)).filter(s => s && judgedThese(s, hash, content));
  const out = {};
  for (const f of entry.findings) {
    const votes = stored.filter(s => s.status === "ok" && s.judgments[f.key]).map(s => s.judgments[f.key]);
    const v = panelVerdict(votes, { panelSize: judges.length, decoyIds });
    if (v.audit === "judge_failure" && stored.length < judges.length) v.audit = "not_judged";
    out[f.key] = { ...v, judges: Object.fromEntries(stored.filter(s => s.judgments?.[f.key]).map(s => [s.judge, s.judgments[f.key].valid])), sig: findingSig(f) };
  }
  return out;
}

/**
 * `crb judge --set S`: collect the set's findings, ask every judge about every task whose findings
 * changed since its last judgment (or whose last judgment failed), then write panel.json.
 * opts: { invoke, concurrency, retry, tasks: [ids] (default all), onEvent }. Resolves a summary.
 */
export async function judgeSet(set, opts = {}) {
  const corpus = opts.corpus ?? corpusRoot();
  const judges = opts.judges ?? judgesFor(set);
  const { tasks } = collectFindings(set, { corpus });
  const pool = readJson(path.join(gradingDir(set), "pool.json"), { bugs: [] }).bugs;
  const specs = [];
  for (const [taskId, entry] of Object.entries(tasks)) {
    if (opts.tasks && !opts.tasks.includes(taskId)) continue;
    if (!entry.findings.length) continue;
    const hash = keysHash(entry.findings.map(f => f.key));
    const content = contentHash(entry.findings);
    for (const judge of judges) {
      const prev = readJudgment(set, taskId, judge.name);
      if (prev && judgedThese(prev, hash, content) && prev.model === judge.model && prev.status === "ok") continue;
      specs.push({ id: `judge/${set}/${taskId}/${judge.name}`, queue: judge.name, reviewer: judge.name, judge, taskId, entry, hash, content });
    }
  }
  const execute = async (spec, counters) => {
    const task = loadEntryTask(spec.entry, corpus);
    const pooled = pool.filter(p => p.task === spec.taskId);
    const invoke = opts.invoke ?? ((j, a) => cliInvoke(j, { ...a, pollMs: opts.pollMs }));
    const res = await judgeTask(task, spec.entry.findings, spec.judge, { invoke, pooled });
    if (res.status === "infra") {
      const result = { class: "infra", reason: res.reason, flagged: false };
      const decision = decide(result, counters, { ...RETRY, ...(opts.retry ?? {}) });
      if (decision === "infra_exhausted") writeJudgment(set, spec, res);
      return { result, decision };
    }
    writeJudgment(set, spec, res);
    return { result: { class: "ok", reason: res.status, flagged: false }, decision: "final" };
  };
  const summary = specs.length
    ? await runBatch(specs, { concurrency: { ...DEFAULT_CONCURRENCY, ...(opts.concurrency ?? {}) }, retry: opts.retry, minFreeBytes: 0, execute, onEvent: opts.onEvent, sleep: opts.sleep })
    : { planned: 0, done: 0, infra_exhausted: 0 };
  const panel = writePanel(set, tasks, corpus, judges);
  const failed = specs.filter(s => readJudgment(set, s.taskId, s.judge.name)?.status !== "ok").length;
  return { set, judges: judges.map(j => `${j.name}:${j.model}`), tasks: Object.keys(tasks).length, calls: specs.length, failed, ...summary, audit_needed: Object.values(panel).flatMap(Object.values).filter(v => v.audit).length };
}

function writeJudgment(set, spec, res) {
  const byKey = {};
  if (res.judgments) for (const f of spec.entry.findings) if (res.judgments[f.fid]) byKey[f.key] = res.judgments[f.fid];
  writeJson(judgmentFile(set, spec.taskId, spec.judge.name), {
    task: spec.taskId, judge: spec.judge.name, model: spec.judge.model, effort: spec.judge.effort, keys_hash: spec.hash, content_hash: spec.content,
    status: res.status === "ok" ? "ok" : "failed", reason: res.reason ?? null, judged_at: new Date().toISOString(),
    judgments: byKey, attempts: res.attempts,
  });
}

/** Recompute panel.json for every task of the set. */
export function writePanel(set, tasks, corpus = corpusRoot(), judges = judgesFor(set)) {
  const panel = {};
  for (const [taskId, entry] of Object.entries(tasks)) {
    if (!entry.findings.length) continue;
    panel[taskId] = taskPanel(set, taskId, entry, loadEntryTask(entry, corpus), judges);
  }
  writeJson(panelFile(set), panel);
  return panel;
}
