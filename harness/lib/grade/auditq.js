// The audit queue (F12): Claude Code checks every tie, uncertain or inconsistent panel verdict and
// judge failure, every pooled-bug candidate, and a seeded 20% sample stratified by reviewer. An
// audit verdict needs evidence — a reproduction command and its result, or a written argument
// citing code — and overrides the panel.

import fs from "node:fs";
import path from "node:path";
import { gradingDir, scratchDir } from "../paths.js";
import { SEVERITIES } from "../task.js";
import { materialize } from "../workspace.js";
import { toolchainEnv } from "../cache.js";
import { withLockSync } from "../store.js";
import { keyFraction } from "../normalize.js";
import { SEED, readJson, writeJson, loadFindings, loadEntryTask, findingsFile, sigsByKey, staleSig } from "./collect.js";
import { panelFile } from "./judge.js";

/** Share of findings sampled for audit, per reviewer. */
export const SAMPLE_RATE = 0.2;

export const queueFile = set => path.join(gradingDir(set), "audit", "queue.json");
export const recordFile = (set, id) => path.join(gradingDir(set), "audit", "records", `${id}.json`);
export const poolFile = set => path.join(gradingDir(set), "pool.json");

export function readQueue(set) {
  return readJson(queueFile(set), { items: [] });
}

export function readPool(set) {
  return readJson(poolFile(set), { bugs: [] });
}

function nextId(items, prefix = "A") {
  return `${prefix}${items.reduce((m, i) => Math.max(m, Number(i.id.slice(1)) || 0), 0) + 1}`;
}

/** Reasons the panel gives for an audit; they lapse when a later panel settles the finding. */
export const PANEL_REASONS = ["tie", "uncertain", "inconsistent", "judge_failure"];

/**
 * Add items to the queue under its lock. Each new item is { kind, task, keys, reasons, ...extra };
 * a single-finding item merges into an open or done item of the same kind and key (its reasons are
 * added), and reopens a withdrawn one. Returns the queue.
 */
export function enqueue(set, newItems) {
  return withLockSync(`audit-${set}`, () => {
    const q = readQueue(set);
    for (const it of newItems) {
      const same = it.keys.length === 1 && q.items.find(x => x.kind === it.kind && x.keys.length === 1 && x.keys[0] === it.keys[0] && (x.target ?? null) === (it.target ?? null));
      if (same) {
        if (same.status === "withdrawn") { same.status = "open"; same.reasons = []; }
        same.reasons = [...new Set([...same.reasons, ...it.reasons])];
        continue;
      }
      q.items.push({ id: nextId(q.items), status: "open", created_at: new Date().toISOString(), ...it });
    }
    writeJson(queueFile(set), q);
    return q;
  });
}

/**
 * Bring the queue up to date with panel.json: every finding the panel could not settle (not those
 * not judged yet), and the seeded sample (per reviewer, the SAMPLE_RATE share of its findings with
 * the lowest key hashes). An open item's panel reason that the current panel no longer gives is
 * dropped; an open item left without reasons is withdrawn.
 */
export function syncAuditQueue(set) {
  refreshStaleGrading(set);
  const panel = readJson(panelFile(set), {});
  const { tasks, mapping } = loadFindings(set);
  withLockSync(`audit-${set}`, () => {
    const q = readQueue(set);
    let changed = false;
    for (const it of q.items.filter(x => x.status === "open" && x.kind === "finding")) {
      const now = panel[it.task]?.[it.keys[0]]?.audit ?? null;
      const reasons = it.reasons.filter(r => !PANEL_REASONS.includes(r) || r === now);
      if (reasons.length === it.reasons.length) continue;
      it.reasons = reasons;
      if (!reasons.length) it.status = "withdrawn";
      changed = true;
    }
    if (changed) writeJson(queueFile(set), q);
  });
  const items = [];
  for (const [taskId, byKey] of Object.entries(panel)) {
    for (const [key, v] of Object.entries(byKey)) if (PANEL_REASONS.includes(v.audit)) items.push({ kind: "finding", task: taskId, keys: [key], reasons: [v.audit] });
  }
  const byReviewer = {};
  for (const [taskId, entry] of Object.entries(tasks)) {
    for (const f of entry.findings) (byReviewer[mapping[f.key]?.reviewer ?? "?"] ??= []).push({ taskId, key: f.key });
  }
  for (const list of Object.values(byReviewer)) {
    const k = Math.ceil(list.length * SAMPLE_RATE);
    const picked = [...list].sort((a, b) => keyFraction(`${SEED}:audit`, a.key) - keyFraction(`${SEED}:audit`, b.key)).slice(0, k);
    for (const p of picked) items.push({ kind: "finding", task: p.taskId, keys: [p.key], reasons: ["sample"] });
  }
  return enqueue(set, items);
}

/**
 * Redo the grading of findings whose content changed since it was graded (a requeued or restored
 * attempt keeps its keys): a finding or pool_match item whose record graded the old content is open
 * again, its record kept beside as `<id>.stale-<ms>.json`; a pooled bug keeps its audit (the auditor
 * checked the code) but the changed findings of its group lose its credit, and it is re-checked again,
 * as is a pooled bug with a re-check of old content; the pool item drops those keys, so their new content
 * is pooled again. Records and re-checks stored before signatures
 * were are taken as current. Resolves { reopened: [item ids], recheck: [pooled bug ids] }.
 */
export function refreshStaleGrading(set) {
  const out = { reopened: [], recheck: [] };
  if (!fs.existsSync(findingsFile(set))) return out;
  const sigs = sigsByKey(loadFindings(set).tasks);
  withLockSync(`audit-${set}`, () => {
    const q = readQueue(set);
    const pool = readPool(set);
    let queueChanged = false, poolChanged = false;
    const recheckAgain = id => {
      const b = pool.bugs.find(x => x.id === id);
      if (b?.rechecked) { b.rechecked = false; poolChanged = true; }
      if (b && !out.recheck.includes(id)) out.recheck.push(id);
    };
    for (const it of q.items.filter(i => i.status === "done")) {
      const file = recordFile(set, it.id);
      const r = readJson(file);
      const stale = (r?.keys ?? []).filter(k => staleSig(r.sigs?.[k], sigs.get(k)));
      if (it.kind === "pool" && r) {
        if (stale.length) {
          r.keys = r.keys.filter(k => !stale.includes(k));
          r.stale_keys = [...(r.stale_keys ?? []), ...stale];
          writeJson(file, r);
        }
        // the item and the pooled bug lose them too, so their new content is a pool candidate again;
        // keys the record already dropped are dropped here as well, which finishes an interrupted pass
        const gone = new Set(r.stale_keys ?? []);
        if (it.keys.some(k => gone.has(k))) {
          it.stale_keys = [...new Set([...(it.stale_keys ?? []), ...it.keys.filter(k => gone.has(k))])];
          it.keys = it.keys.filter(k => !gone.has(k));
          queueChanged = true;
        }
        const b = pool.bugs.find(x => x.id === r.pooled);
        if (b?.keys.some(k => gone.has(k))) { b.keys = b.keys.filter(k => !gone.has(k)); poolChanged = true; recheckAgain(b.id); }
        continue;
      }
      // a done item whose record was set aside by an interrupted pass is open again too
      const setAside = !r && fs.existsSync(path.dirname(file)) && fs.readdirSync(path.dirname(file)).some(f => f.startsWith(`${it.id}.stale-`));
      if (!stale.length && !setAside) continue;
      if (r) fs.renameSync(file, path.join(path.dirname(file), `${it.id}.stale-${Date.now()}.json`));
      it.status = "open";
      queueChanged = true;
      out.reopened.push(it.id);
    }
    // recheck.json (verdicts.js recheckFile; read here by path, as verdicts.js imports this module)
    const recheck = readJson(path.join(gradingDir(set), "recheck.json"), {});
    for (const [id, byKey] of Object.entries(recheck)) if (Object.entries(byKey).some(([k, v]) => staleSig(v?.sig, sigs.get(k)))) recheckAgain(id);
    if (queueChanged) writeJson(queueFile(set), q);
    if (poolChanged) writeJson(poolFile(set), pool);
  });
  return out;
}

/** Counts of the queue: open and done, by kind and reason. */
export function queueStatus(set) {
  const q = readQueue(set);
  const live = q.items.filter(it => it.status !== "withdrawn");
  const out = { set, items: live.length, open: 0, done: 0, by_reason: {} };
  for (const it of live) {
    out[it.status === "done" ? "done" : "open"]++;
    for (const r of it.reasons) {
      out.by_reason[r] ??= { open: 0, done: 0 };
      out.by_reason[r][it.status === "done" ? "done" : "open"]++;
    }
  }
  return out;
}

/** A materialized workspace of the task for the auditor (base + PR, dependencies installed), reused. */
export async function auditWorkspace(set, task) {
  const dir = path.join(scratchDir(), "audit", set, task.id);
  const ws = path.join(dir, task.repo);
  if (!fs.existsSync(path.join(ws, ".git"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await materialize(task, dir, { env: toolchainEnv() });
  }
  return ws;
}

/** The first open item as the auditor sees it (itemPacket), or null when none is open. */
export async function nextItem(set, opts = {}) {
  const it = readQueue(set).items.find(x => x.status === "open");
  return it ? itemPacket(set, it, opts) : null;
}

/** An item by id as the auditor sees it, so several auditors can take different items. */
export async function showItem(set, id, opts = {}) {
  const it = readQueue(set).items.find(x => x.id === id);
  if (!it) throw new Error(`no audit item ${id} in set ${set}`);
  return itemPacket(set, it, opts);
}

/**
 * An item as the auditor sees it: the anonymized findings, the task and its answer key, the
 * workspace path, and how to record a verdict. Never the panel's votes or the reviewer.
 */
async function itemPacket(set, it, { corpus, workspace = true } = {}) {
  const { tasks } = loadFindings(set);
  const entry = tasks[it.task];
  const task = loadEntryTask(entry, corpus);
  const pooled = readPool(set).bugs.filter(p => p.task === it.task);
  const findings = entry.findings.filter(f => it.keys.includes(f.key)).map(({ key, locations, state, ...f }) => ({
    ...f, state_patches: (state ?? []).map(p => path.join(task.dir, p)),
  }));
  return {
    item: it.id, kind: it.kind, reasons: it.reasons, target: it.target ?? null, proposal: it.proposal ?? null,
    task: {
      id: task.id, repo: task.repo, kind: task.kind, title: task.title, description: task.description, dir: task.dir,
      bugs: (task.bugs ?? []).map(({ id, file, lines, severity, summary, trigger, testable, hidden_test_cmd }) => ({ id, file, lines, severity, summary, trigger, testable, hidden_test_cmd })),
      decoys: (task.decoys ?? []).map(({ id, file, lines, looks_like, why_correct }) => ({ id, file, lines, looks_like, why_correct })),
      pooled: pooled.map(({ id, file, lines, severity, summary }) => ({ id, file, lines, severity, summary })),
    },
    workspace: workspace ? await auditWorkspace(set, task) : null,
    findings,
    record: it.kind === "pool"
      ? `crb audit-queue record ${it.id} --set ${set} --verdict real|not_real (--repro-cmd "<cmd>" --result pass|fail | --evidence <file>) [--file F --lines A-B --severity S --summary "..."]`
      : it.kind === "pool_match"
        ? `crb audit-queue record ${it.id} --set ${set} --verdict real|not_real --match ${it.target}|none --evidence <file>`
        : `crb audit-queue record ${it.id} --set ${set} --verdict real|not_real [--match B1,D1,P1] (--repro-cmd "<cmd>" --result pass|fail | --evidence <file>)`,
  };
}

const RESULTS = ["pass", "fail", "n/a"];

/**
 * Record a verdict for an open item. opts: { verdict, match: [ids], evidence: file, reproCmd,
 * result, file, lines: [a, b], severity, summary }. A pool item judged real becomes pooled bug
 * P<k> in pool.json. Returns the record.
 */
export function recordVerdict(set, id, opts, { corpus } = {}) {
  return withLockSync(`audit-${set}`, () => {
    const q = readQueue(set);
    const it = q.items.find(x => x.id === id);
    if (!it) throw new Error(`no audit item ${id} in set ${set}`);
    if (it.status === "done") throw new Error(`audit item ${id} is already recorded`);
    if (!["real", "not_real"].includes(opts.verdict)) throw new Error("--verdict must be real or not_real");
    if (!opts.reproCmd && !opts.evidence) throw new Error("an audit verdict needs evidence: --repro-cmd with --result, or --evidence <file> with a written argument citing code (F12)");
    if (opts.reproCmd && !RESULTS.includes(opts.result)) throw new Error(`--result must be one of ${RESULTS.join(", ")} with --repro-cmd`);
    const evidenceText = opts.evidence ? fs.readFileSync(opts.evidence, "utf8") : null;
    if (opts.evidence && !evidenceText.trim()) throw new Error(`--evidence ${opts.evidence} is empty`);

    const { tasks } = loadFindings(set);
    const task = loadEntryTask(tasks[it.task], corpus);
    const sigs = sigsByKey(tasks);
    const pool = readPool(set);
    const known = new Set([...(task.bugs ?? []), ...(task.decoys ?? []), ...pool.bugs.filter(p => p.task === it.task)].map(t => t.id));
    const match = (opts.match ?? []).filter(m => m && m !== "none");
    for (const m of match) if (!known.has(m)) throw new Error(`--match ${m} is not a bug, decoy or pooled bug of ${it.task}`);
    if (it.kind === "pool_match" && match.some(m => m !== it.target)) throw new Error(`--match must be ${it.target} or none for this item`);
    const decoyIds = new Set((task.decoys ?? []).map(d => d.id));
    const defects = match.filter(m => !decoyIds.has(m));
    if (opts.verdict === "not_real" && defects.length) throw new Error(`--verdict not_real contradicts --match ${defects.join(",")}: a finding that describes a defect is real`);

    const record = {
      item: it.id, kind: it.kind, task: it.task, keys: it.keys, target: it.target ?? null, reasons: it.reasons, verdict: opts.verdict, match,
      repro_cmd: opts.reproCmd ?? null, result: opts.reproCmd ? opts.result : null, evidence: evidenceText,
      // the content the auditor saw: a replaced attempt under the same keys is audited again
      sigs: Object.fromEntries(it.keys.map(k => [k, sigs.get(k) ?? null])),
      recorded_at: new Date().toISOString(),
    };
    // a candidate that is really a planted or pooled bug the panel missed matches it: no new pooled bug
    if (it.kind === "pool" && opts.verdict === "real" && !defects.length) {
      const p = { ...it.proposal, ...(opts.file ? { file: opts.file } : {}), ...(opts.lines ? { lines: opts.lines } : {}), ...(opts.severity ? { severity: opts.severity } : {}), ...(opts.summary ? { summary: opts.summary } : {}) };
      if (!p.file || !Array.isArray(p.lines) || p.lines.length !== 2 || !(p.lines[0] >= 1 && p.lines[0] <= p.lines[1])) throw new Error("a pooled bug needs --file and --lines A-B");
      if (!SEVERITIES.includes(p.severity)) throw new Error(`--severity must be one of ${SEVERITIES.join(", ")}`);
      if (!String(p.summary ?? "").trim()) throw new Error("a pooled bug needs --summary");
      const pid = `P${pool.bugs.reduce((m, b) => Math.max(m, Number(b.id.slice(1)) || 0), 0) + 1}`;
      pool.bugs.push({ id: pid, task: it.task, file: p.file, lines: p.lines, severity: p.severity, summary: p.summary.trim(), item: it.id, keys: it.keys, rechecked: false, created_at: record.recorded_at });
      writeJson(poolFile(set), pool);
      record.pooled = pid;
    }
    writeJson(recordFile(set, it.id), record);
    it.status = "done";
    // the pool audit has looked at these findings: it settles their open sample items too
    if (it.kind === "pool") {
      for (const x of q.items.filter(x => x.status === "open" && x.kind === "finding" && x.reasons.every(r => r === "sample") && it.keys.includes(x.keys[0]))) {
        writeJson(recordFile(set, x.id), { ...record, item: x.id, kind: "finding", keys: x.keys, sigs: Object.fromEntries(x.keys.map(k => [k, record.sigs[k] ?? null])), reasons: x.reasons, match: record.pooled ? [record.pooled] : record.match, via: it.id, pooled: undefined });
        x.status = "done";
      }
    }
    writeJson(queueFile(set), q);
    return record;
  });
}

/** Every recorded verdict of the set. */
export function readRecords(set) {
  return readQueue(set).items.filter(i => i.status === "done").map(i => readJson(recordFile(set, i.id))).filter(Boolean);
}

/** Cohen's kappa of paired labels [[a, b], …]; null without pairs, 1 when both raters always agree on one label. */
export function cohenKappa(pairs) {
  const n = pairs.length;
  if (!n) return null;
  const labels = [...new Set(pairs.flat())];
  const po = pairs.filter(([a, b]) => a === b).length / n;
  const pe = labels.reduce((s, l) => s + (pairs.filter(([a]) => a === l).length / n) * (pairs.filter(([, b]) => b === l).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}
