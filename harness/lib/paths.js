// Where the bench keeps things: the corpus repo, ~/.crbench, and the pinned cross-review checkout.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** cross-review release every run uses (Fixed decision F6). */
export const PINNED_TAG = "v10.5.1";
export const PINNED_SHA = "2dd22c9c388aadb98cc8a192ab2bc748e882a0dc";

/** The user's own home. Runs give reviewers another HOME; the harness itself keeps this one. */
export function realHome() {
  return process.env.CRB_REAL_HOME || os.homedir();
}

export function crbHome() {
  return process.env.CRB_HOME || path.join(realHome(), ".crbench");
}

export function corpusRoot() {
  return path.resolve(process.env.CRB_CORPUS || path.join(BENCH_ROOT, "..", "cross-review-bench-corpus"));
}

export function pinnedRoot() {
  return process.env.CRB_PINNED || path.join(crbHome(), `cross-review-${PINNED_TAG}`);
}

export function pinnedRunner() {
  return path.join(pinnedRoot(), "skill-packs", "cross-review", "scripts", "review-runner.js");
}

/** Scratch space under the real home: colima mounts only ~, and validation copies live here. */
export function scratchDir() {
  return path.join(crbHome(), "tmp");
}

/** Archived runs, keyed by run id (F15, I9). */
export function runsDir() {
  return path.join(crbHome(), "runs");
}

export function locksDir() {
  return path.join(crbHome(), "locks");
}

export function authBackupsDir() {
  return path.join(crbHome(), "auth-backups");
}

export function cacheDir() {
  return path.join(crbHome(), "cache");
}

/** Live runs: /tmp/crw/<8-hex>/{home,<repo>} (F15), far from ~/projects. */
export function runRoot() {
  return path.resolve(process.env.CRB_RUN_ROOT || "/tmp/crw");
}

/** Grading data of a set: findings, judgments, audit records, pooled bugs, scores (Phase 7). */
export function gradingDir(set) {
  return path.join(crbHome(), "grading", set);
}
