#!/usr/bin/env node
// Blinded pilot measurements (I8): every reviewer appears as X, Y or Z. The label map is drawn once,
// written to ~/.crbench/pilot-map.json and never printed; it is opened in Phase 22.
//
//   node pilot/blind.mjs --log ~/.crbench/logs/pilot-run.log [--out ~/.crbench/pilot-blind]
//
// Prints JSON: per label, archived runs by class, attempts by class/reason (from the run log),
// usage-limit pauses, wall time (median, p95, p99, max), Track B rounds, archive sizes. With the
// pilot set scored, also writes <out>/scores.jsonl with reviewers (and judges) relabelled, for
// crb_analysis.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";
import { listRuns, plannedIds } from "../harness/lib/store.js";
import { crbHome, gradingDir } from "../harness/lib/paths.js";

const SET = "pilot";
const REVIEWERS = ["codex", "claude", "agy"];
const LABELS = ["X", "Y", "Z"];
const CLASSES = ["ok", "reviewer_timeout", "reviewer_stall", "reviewer_malformed", "infra_exhausted", "contaminated"];

export function labelMap(file = path.join(crbHome(), "pilot-map.json")) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const shuffled = [...LABELS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const map = Object.fromEntries(REVIEWERS.map((r, i) => [r, shuffled[i]]));
  fs.writeFileSync(file, JSON.stringify(map) + "\n", { mode: 0o600, flag: "wx" });
  return map;
}

export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
}

function dirBytes(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += dirBytes(p);
    else if (e.isFile()) n += fs.statSync(p).size;
  }
  return n;
}

const reviewerOf = id => id.split("/")[3];
const zeros = keys => Object.fromEntries(keys.map(k => [k, 0]));
const stats = xs => ({ n: xs.length, median: quantile(xs, 0.5), p95: quantile(xs, 0.95), p99: quantile(xs, 0.99), max: xs.length ? Math.max(...xs) : null });

/** Attempts and pauses from the `crb run` log (one line per attempt end or pause). */
export function parseLog(text, map) {
  const attempts = Object.fromEntries(LABELS.map(l => [l, {}]));
  const pauses = zeros(LABELS);
  for (const line of text.split("\n")) {
    let m = line.match(/^\S+ (\S+) (\S+?)\/(\S*?)( FLAGGED)? -> (\S+)$/);
    if (m && map[reviewerOf(m[1])]) {
      const key = `${m[2]}/${m[3]}${m[4] ? " flagged" : ""}`;
      const a = attempts[map[reviewerOf(m[1])]];
      a[key] = (a[key] ?? 0) + 1;
      continue;
    }
    m = line.match(/^\S+ (\S+) paused until /);
    if (m && map[m[1]]) pauses[map[m[1]]]++;
  }
  return { attempts, pauses };
}

export function measure({ log = null, map }) {
  const runs = listRuns(SET).filter(r => r.track === "A");
  const planned = plannedIds(SET);
  const out = { set: SET, planned: planned.length, archived: runs.length, labels: {} };
  for (const l of LABELS) {
    const mine = runs.filter(r => map[r.reviewer] === l);
    const classes = zeros(CLASSES);
    for (const r of mine) classes[r.class] = (classes[r.class] ?? 0) + 1;
    const sizes = mine.map(r => dirBytes(r.archive) / 1e6);
    out.labels[l] = {
      planned: planned.filter(id => map[reviewerOf(id)] === l).length,
      archived: mine.length,
      classes,
      flagged_attempts: mine.filter(r => r.flagged).length,
      wall_s: stats(mine.filter(r => r.class === "ok").map(r => r.wall_s)),
      track_b_rounds: mine.filter(r => fs.existsSync(path.join(r.archive, "round2"))).length,
      archive_mb: { ...stats(sizes), total: sizes.reduce((a, b) => a + b, 0) },
    };
  }
  const flaggedDir = path.join(crbHome(), "runs", "flagged", SET);
  out.flagged_archives = fs.existsSync(flaggedDir) ? listRunsUnder(flaggedDir).length : 0;
  if (log) Object.assign(out, parseLog(fs.readFileSync(log, "utf8"), map));
  return out;
}

function listRunsUnder(dir) {
  const found = [];
  const walk = d => {
    if (fs.existsSync(path.join(d, "run.json"))) return void found.push(d);
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(d, e.name));
  };
  walk(dir);
  return found;
}

/** scores.jsonl of the pilot set with reviewer names (and the judges in loo_judge) relabelled. */
export function blindScores(text, map) {
  const swap = s => s.split("/").map(p => map[p] ?? p).join("/");
  return text.split("\n").filter(Boolean).map(line => {
    const r = JSON.parse(line);
    if (r.reviewer) r.reviewer = map[r.reviewer] ?? r.reviewer;
    if (r.run_id) r.run_id = swap(r.run_id);
    if (r.loo_judge) r.loo_judge = Object.fromEntries(Object.entries(r.loo_judge).map(([j, v]) => [map[j] ?? j, v]));
    delete r.model;
    return JSON.stringify(r);
  }).join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { log: { type: "string" }, out: { type: "string" } } });
  const map = labelMap();
  const res = measure({ log: values.log, map });
  const scores = path.join(gradingDir(SET), "scores.jsonl");
  if (fs.existsSync(scores)) {
    const out = values.out ?? path.join(crbHome(), "pilot-blind");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "scores.jsonl"), blindScores(fs.readFileSync(scores, "utf8"), map));
    res.blind_scores = path.join(out, "scores.jsonl");
  }
  process.stdout.write(JSON.stringify(res, null, 2) + "\n");
}
