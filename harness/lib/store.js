// Run ids, locks, atomic writes and the run archive (F15, I9).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runsDir, locksDir } from "./paths.js";
import { SETS, TRACKS } from "./config.js";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `<set>/<track>/<config>/<reviewer>/<task>/<n>` (I9). */
export function runId({ set, track, config, reviewer, task, n }) {
  if (!SETS.includes(set)) throw new Error(`set must be one of ${SETS.join(", ")} (got ${set})`);
  if (!TRACKS.includes(track)) throw new Error(`track must be one of ${TRACKS.join(", ")} (got ${track})`);
  const parts = [set, track, config, reviewer, task, String(n)];
  for (const p of parts) if (!SEGMENT.test(p)) throw new Error(`invalid run id segment ${JSON.stringify(p)}`);
  return parts.join("/");
}

export function runPath(id) {
  return path.join(runsDir(), id);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function readRun(id) {
  return readJson(path.join(runPath(id), "run.json"));
}

/** A run is done when its archive holds a final record (ok, scored reviewer failure, contaminated). */
export function isDone(id) {
  return readRun(id)?.final === true;
}

/** Write a file through a temporary name in the same directory, then rename. */
export function writeAtomic(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run fn holding the lock `name` (a directory under ~/.crbench/locks). A lock whose holder process
 * is gone is taken over; waiting longer than timeoutMs throws.
 */
export function withLockSync(name, fn, { timeoutMs = 120_000 } = {}) {
  fs.mkdirSync(locksDir(), { recursive: true });
  const dir = path.join(locksDir(), `${name}.lock`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // no pid yet means the holder is between mkdir and writing it: wait
      const pid = Number(readJson(path.join(dir, "pid")));
      if (pid && !alive(pid)) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${dir}`);
      sleepSync(50);
    }
  }
  try { return fn(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Archive one attempt. `dest` is the run's archive (final records) or a flagged slot. Files are
 * staged under runs/.staging and renamed into place, replacing an earlier non-final record.
 * `files` maps archive-relative names to strings; `dirs` maps names to directories to copy.
 */
export function archive(dest, { files = {}, dirs = {} }) {
  const staging = path.join(runsDir(), ".staging", crypto.randomBytes(6).toString("hex"));
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const [name, src] of Object.entries(dirs)) {
      // timestamps kept: a Track B run's round1/ shows it was written before the answer patches
      if (src && fs.existsSync(src)) fs.cpSync(src, path.join(staging, name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    }
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
      fs.writeFileSync(path.join(staging, name), text);
    }
    withLockSync("archive", () => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) {
        const trash = path.join(runsDir(), ".staging", `trash-${crypto.randomBytes(6).toString("hex")}`);
        fs.renameSync(dest, trash);
        fs.rmSync(trash, { recursive: true, force: true });
      }
      fs.renameSync(staging, dest);
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return dest;
}

/** Where a flagged attempt goes: runs/flagged/<run id>/<hex> (never read as a result). */
export function flaggedPath(id, hex) {
  return path.join(runsDir(), "flagged", id, hex);
}

/**
 * Where an attempt goes that a corrected audit rule shows should never have run (an earlier attempt
 * of the run turned out clean): runs/superseded/<run id>/<hex>. Never read as a result, never a flag.
 */
export function supersededPath(id, hex) {
  return path.join(runsDir(), "superseded", id, hex);
}

/** Flagged attempts a run has had, in any batch (the second flag makes it contaminated). */
export function flaggedAttempts(id) {
  try { return fs.readdirSync(path.join(runsDir(), "flagged", id)).length; } catch { return 0; }
}

/** The ids every `crb run` of a set has planned (status --complete compares against them). */
export function addPlanned(set, ids) {
  const file = path.join(runsDir(), set, "plan.json");
  withLockSync("plan", () => {
    const known = new Set(readJson(file)?.ids ?? []);
    for (const id of ids) known.add(id);
    writeAtomic(file, JSON.stringify({ ids: [...known].sort() }, null, 2) + "\n");
  });
}

export function plannedIds(set) {
  return readJson(path.join(runsDir(), set, "plan.json"))?.ids ?? [];
}

/** Every archived run record of a set (flagged attempts and staging excluded). */
export function listRuns(set) {
  const root = path.join(runsDir(), set);
  const out = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    if (fs.existsSync(path.join(dir, "run.json"))) {
      const r = readJson(path.join(dir, "run.json"));
      if (r) out.push({ ...r, archive: dir });
      return;
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(dir, e.name));
  };
  walk(root);
  return out;
}
