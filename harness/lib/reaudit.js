// Re-audit a set's archives with the current audit rules (crb audit --all). With `requeue`, a run the
// rules now flag is handled as if its attempt had been flagged when it ran: its first flag archives it
// as a flagged attempt (the next batch runs it again), its second makes it contaminated (METHODOLOGY).
// `restoreUnflagged` is the other direction, after a rule was narrowed: flags it drops are undone.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { corpusRoot, realHome, runRoot, runsDir } from "./paths.js";
import { listRuns, flaggedPath, flaggedAttempts, runPath, supersededPath, withLockSync, writeAtomic } from "./store.js";
import { auditRun } from "./audit.js";
import { auditLoop } from "./trackc.js";
import { classify } from "./failures.js";
import { upstreamFragments } from "./scheduler.js";

const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));

/**
 * Resolves { set, flagged, contaminated, runs: [{id, class, hits}], requeued: [id], newly_contaminated: [id] }.
 * `hostTmp`: TMPDIR of runs made before per-run temp dirs (their run.json has no `tmpdir`).
 */
export function reauditSet(set, { requeue = false, corpus = corpusRoot(), hostTmp = os.tmpdir() } = {}) {
  const runs = [];
  const requeued = [];
  const newlyContaminated = [];
  for (const r of listRuns(set)) {
    const taskDir = r.kind === "realbug" ? path.join(corpus, "realbugs", r.task) : path.join(corpus, "tasks", r.repo, r.task);
    const ctx = {
      runDir: r.run_dir, workspace: r.workspace, realHome: r.real_home ?? realHome(), runRoot: r.run_root ?? runRoot(),
      tmpdir: r.tmpdir ?? hostTmp, upstream: upstreamFragments({ dir: taskDir }),
    };
    let audit;
    if (r.track === "C") {
      audit = auditLoop({ orchestrator: r.orchestrator, logFile: path.join(r.archive, "orchestrator.jsonl"), sessionsDir: path.join(r.archive, "sessions"), ctx });
    } else {
      const session = path.join(r.archive, "session");
      if (!fs.existsSync(session)) continue;
      audit = auditRun(session, r.reviewer, ctx);
    }
    const auditFile = path.join(r.archive, "audit.json");
    if (!fs.existsSync(auditFile)) continue;
    const now = new Date().toISOString();
    const before = readJson(auditFile);
    if (audit.flagged !== before.flagged || audit.hits.length !== before.hits.length) {
      writeAtomic(auditFile, JSON.stringify({ ...audit, reaudited_at: now }, null, 2) + "\n");
    }
    if (!audit.flagged) continue;
    runs.push({ id: r.id, class: r.class, hits: audit.hits });
    if (!requeue || r.class === "contaminated") continue;

    const runFile = path.join(r.archive, "run.json");
    const record = readJson(runFile);
    const dest = flaggedPath(r.id, r.hex);
    // the archive moves (or is copied) first, so an interruption never leaves a run open to a rerun
    // without its flag counted; a re-audit finishes what an interrupted one started
    // earlier flags: flagged attempts other than this one's slot (an interrupted marking may have filled it)
    if (flaggedAttempts(r.id) - (fs.existsSync(dest) ? 1 : 0) >= 1) {
      const contaminated = JSON.stringify({ ...record, class: "contaminated", decision: "contaminated", final: true, flagged: true, reaudited_at: now }, null, 2) + "\n";
      fs.cpSync(r.archive, dest, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      writeAtomic(path.join(dest, "run.json"), contaminated);
      writeAtomic(runFile, contaminated);
      newlyContaminated.push(r.id);
    } else {
      withLockSync("archive", () => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(r.archive, dest);
      });
      writeAtomic(path.join(dest, "run.json"), JSON.stringify({ ...record, decision: "requeue_flagged", final: false, flagged: true, reaudited_at: now }, null, 2) + "\n");
      requeued.push(r.id);
    }
  }
  const contaminated = listRuns(set).filter(r => r.class === "contaminated").length;
  return { set, flagged: runs.length, contaminated, runs, requeued, newly_contaminated: newlyContaminated };
}

/**
 * Track A, after an audit rule was narrowed (it only ever drops flags): replay each flagged run's
 * attempts in order under the current rules, as the scheduler would have decided them. The first
 * clean attempt is the run's result; two flags make it contaminated. Attempts after the result would
 * never have run and move to runs/superseded/. An attempt whose clean result the scheduler would have
 * retried rather than kept (a reviewer or infra failure) is only reported (`needs_rerun`).
 * Run it with no batch running. Resolves { set, restored: [{id, from, to}], needs_rerun: [id] };
 * with `apply` false nothing moves.
 */
export function restoreUnflagged(set, { apply = false, corpus = corpusRoot(), hostTmp = os.tmpdir() } = {}) {
  const restored = [];
  const needsRerun = [];
  for (const r of trackARuns(set)) {
    const slots = path.join(runsDir(), "flagged", r.id);
    if (!fs.existsSync(slots)) continue;
    // every attempt once: the flagged slots and the archive (a contaminated archive also has a copy in its slot)
    const byHex = new Map();
    for (const hex of fs.readdirSync(slots)) byHex.set(hex, path.join(slots, hex));
    if (r.hex) byHex.set(r.hex, r.archive);
    const ordered = [...byHex].map(([hex, dir]) => ({ hex, dir, rec: readJson(path.join(dir, "run.json")) }))
      .sort((a, b) => String(a.rec.started_at).localeCompare(String(b.rec.started_at)));
    const taskDir = r.kind === "realbug" ? path.join(corpus, "realbugs", r.task) : path.join(corpus, "tasks", r.repo, r.task);
    const upstream = upstreamFragments({ dir: taskDir });
    let pick = null;
    let flags = 0;
    for (const a of ordered) {
      const ctx = { runDir: a.rec.run_dir, workspace: a.rec.workspace, realHome: a.rec.real_home ?? realHome(), runRoot: a.rec.run_root ?? runRoot(), tmpdir: a.rec.tmpdir ?? hostTmp, upstream };
      const session = path.join(a.dir, "session");
      a.audit = fs.existsSync(session) ? auditRun(session, r.reviewer, ctx) : { flagged: true, hits: [] };
      if (a.audit.flagged) {
        if (++flags === 2) break;
        continue;
      }
      pick = a;
      break;
    }
    // still contaminated, or the archive is already the first clean attempt
    if (!pick || (pick.hex === r.hex && r.class !== "contaminated")) continue;
    // the attempt's own result, as the scheduler computes it
    const errors = (() => { try { return fs.readFileSync(path.join(pick.dir, "errors.log"), "utf8"); } catch { return ""; } })();
    const waitJson = (() => { try { return readJson(path.join(pick.dir, "wait.json")); } catch { return null; } })();
    const round1 = classify({ waitJson, errorLog: errors });
    const tb = pick.rec.track_b;
    const result = round1.class === "ok" && tb?.class && !["ok", "reviewer_malformed"].includes(tb.class) ? { class: tb.class } : round1;
    if (!["ok", "reviewer_malformed"].includes(result.class)) { needsRerun.push(r.id); continue; }
    restored.push({ id: r.id, from: r.hex, to: pick.hex });
    if (!apply) continue;

    const now = new Date().toISOString();
    const later = ordered.slice(ordered.indexOf(pick) + 1);
    withLockSync("archive", () => {
      // the result's records first, so the rename into the archive is the commit point: an interruption
      // leaves either the old archive or a run with no archive whose attempts a rerun replays again
      writeAtomic(path.join(pick.dir, "audit.json"), JSON.stringify({ ...pick.audit, reaudited_at: now }, null, 2) + "\n");
      writeAtomic(path.join(pick.dir, "run.json"), JSON.stringify({ ...pick.rec, class: round1.class, reason: round1.reason, decision: "final", final: true, flagged: false, reaudited_at: now }, null, 2) + "\n");
      // later attempts leave (the archive among them), then the result takes the archive's place
      for (const a of later) {
        const dest = supersededPath(r.id, a.hex);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(a.dir, dest);
        if (a.dir === r.archive) fs.rmSync(path.join(slots, a.hex), { recursive: true, force: true });
      }
      if (pick.dir !== r.archive) {
        fs.mkdirSync(path.dirname(r.archive), { recursive: true });
        fs.renameSync(pick.dir, r.archive);
      }
      // the contaminated archive itself is the result: its copy among the flagged attempts goes
      else fs.rmSync(path.join(slots, pick.hex), { recursive: true, force: true });
      if (fs.existsSync(slots) && !fs.readdirSync(slots).length) fs.rmdirSync(slots);
    });
  }
  return { set, restored, needs_rerun: needsRerun };
}

/**
 * Track A runs of a set: the archived ones, and those requeued after a flag but not yet rerun (their
 * attempts are all under runs/flagged/<id>/; the latest one stands for the run, `hex` null).
 */
function trackARuns(set) {
  const runs = new Map(listRuns(set).filter(r => r.track === "A").map(r => [r.id, r]));
  const root = path.join(runsDir(), "flagged");
  const walk = (rel, depth) => {
    // a run id has 6 segments: <set>/<track>/<config>/<reviewer>/<task>/<n>
    if (depth === 6) {
      const id = rel.split(path.sep).join("/");
      if (runs.has(id)) return;
      const latest = fs.readdirSync(path.join(root, rel))
        .map(hex => { try { return readJson(path.join(root, rel, hex, "run.json")); } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
      if (latest) runs.set(id, { ...latest, id, archive: runPath(id), hex: null });
      return;
    }
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) walk(path.join(rel, e.name), depth + 1);
  };
  walk(path.join(set, "A"), 2);
  return [...runs.values()].sort((a, b) => a.id.localeCompare(b.id));
}
