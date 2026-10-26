// The findings of a grading set: every ISSUE of round 1 of each scored Track A run, plus the open
// round-2 issues of Track B runs, anonymized and numbered F<k> per task in a seeded order. Who
// raised each finding is kept apart in mapping.json, which only scoring and audit sampling read.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gradingDir, corpusRoot } from "../paths.js";
import { listRuns, writeAtomic } from "../store.js";
import { loadTask } from "../task.js";
import { anonymize, seededShuffle } from "../normalize.js";

/** Seed of every seeded choice in grading (F13's seed). */
export const SEED = "20261017";

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

export const findingsFile = set => path.join(gradingDir(set), "findings.json");
export const mappingFile = set => path.join(gradingDir(set), "mapping.json");

/** The ISSUE blocks of a review, by issue number. */
export function issueBlocks(blocks) {
  return (blocks ?? []).filter(b => (b.prefix ?? "ISSUE") === "ISSUE" && Number.isFinite(Number(b.id))).sort((a, b) => Number(a.id) - Number(b.id));
}

/** The task directory a run record belongs to. */
export function taskDir(run, corpus = corpusRoot()) {
  return run.kind === "realbug" ? path.join(corpus, "realbugs", run.task) : path.join(corpus, "tasks", run.repo, run.task);
}

/** Scored Track A runs of a set: final, not contaminated. */
export function scoredRuns(set) {
  return listRuns(set).filter(r => r.track === "A" && r.final === true && r.class !== "contaminated");
}

/**
 * Collect the set's findings. A run whose round 1 is a reviewer failure contributes no finding
 * (I10: scored as zero findings); a Track B round 2 contributes its ISSUE blocks when it completed
 * with a verdict. Writes findings.json and mapping.json (unless `write` is false) and returns { tasks, mapping }.
 *   tasks[taskId] = { repo, kind, dir, findings: [{ fid, key, round, state, ...anonymized }] }
 *   mapping[key]  = { fid, task, run_id, reviewer, config, model, n, round, scenario, issue }
 */
export function collectFindings(set, { corpus = corpusRoot(), write = true } = {}) {
  const tasks = {};
  const mapping = {};
  const raw = {};
  for (const run of scoredRuns(set)) {
    const entry = (tasks[run.task] ??= { repo: run.repo, kind: run.kind, dir: taskDir(run, corpus), findings: [] });
    const rounds = [];
    if (run.class === "ok") {
      const w1 = readJson(path.join(run.archive, "round1", "wait.json")) ?? readJson(path.join(run.archive, "wait.json"));
      rounds.push({ round: 1, blocks: issueBlocks(w1?.review?.blocks), state: null });
    }
    const tb = run.track_b;
    if (run.class === "ok" && tb?.status === "run" && tb.class === "ok") {
      const w2 = readJson(path.join(run.archive, "round2", "wait.json"));
      rounds.push({ round: 2, blocks: issueBlocks(w2?.review?.blocks), state: tb.patches?.length ? tb.patches : [] });
    }
    for (const { round, blocks, state } of rounds) {
      for (const b of blocks) {
        const key = `${run.id}#r${round}#${b.id}`;
        raw[run.task] ??= [];
        raw[run.task].push({ key, round, state, ...anonymize(b, { workspaceRoot: run.workspace }) });
        mapping[key] = {
          task: run.task, run_id: run.id, reviewer: run.reviewer, config: run.config, model: run.model, n: run.n,
          round, scenario: round === 2 ? tb.scenario : null, issue: Number(b.id),
        };
      }
    }
  }
  for (const [taskId, list] of Object.entries(raw)) {
    const order = seededShuffle([...list].sort((a, b) => (a.key < b.key ? -1 : 1)), `${SEED}:${set}:${taskId}`);
    order.forEach((f, i) => { f.fid = `F${i + 1}`; mapping[f.key].fid = f.fid; });
    tasks[taskId].findings = order.map(({ key, fid, ...rest }) => ({ fid, key, ...rest }));
  }
  if (write) {
    writeJson(findingsFile(set), { set, generated_at: new Date().toISOString(), tasks });
    writeJson(mappingFile(set), mapping);
  }
  return { tasks, mapping };
}

/** findings.json and mapping.json as written by collectFindings. */
export function loadFindings(set) {
  const f = readJson(findingsFile(set));
  if (!f) throw new Error(`no findings for set ${set}: run \`crb judge --set ${set}\` first`);
  return { tasks: f.tasks, mapping: readJson(mappingFile(set), {}) };
}

/** A short stable hash of a list of keys (whether a task's findings changed since it was judged). */
export function keysHash(keys) {
  return crypto.createHash("sha256").update([...keys].sort().join("\n")).digest("hex").slice(0, 16);
}

/**
 * A finding's content apart from its shuffled id: what a judge, an auditor or a re-check graded. A
 * requeued or restored attempt keeps its run id and often its issue numbers, so its findings keep
 * their keys; their content tells the attempts apart. Grading records store it (`sig`, `sigs`,
 * `content_hash`); one written before they did is taken as current.
 */
export function findingSig(f) {
  const { fid, key, ...content } = f;
  return crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16);
}

/** keysHash over the findings' keys and content. */
export function contentHash(findings) {
  return keysHash(findings.map(f => `${f.key}\t${findingSig(f)}`));
}

/** Current content signature by finding key, from findings.json's tasks. */
export function sigsByKey(tasks) {
  return new Map(Object.values(tasks).flatMap(e => e.findings.map(f => [f.key, findingSig(f)])));
}

/** Whether a stored signature is out of date: stored, and the finding's content is no longer what it was. */
export const staleSig = (stored, current) => stored !== undefined && stored !== null && current !== undefined && stored !== current;

/** Load a task by id for a set's findings entry. */
export function loadEntryTask(entry, corpus = corpusRoot()) {
  return loadTask(entry.dir, { corpus });
}
