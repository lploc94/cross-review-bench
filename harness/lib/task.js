// crb-task/v1: loading a task directory and checking its task.json.

import fs from "node:fs";
import path from "node:path";
import { corpusRoot } from "./paths.js";

export const KINDS = ["buggy", "clean", "decoy", "realbug"];
export const SEVERITIES = ["critical", "high", "medium", "low"];
export const SEVERITY_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 };
export const DIFFICULTIES = ["L1", "L2", "L3", "L4"];

export class TaskSchemaError extends Error {
  constructor(dir, problems) {
    super(`${dir}: invalid task.json\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

const isStr = v => typeof v === "string" && v.trim() !== "";
const isLines = v => Array.isArray(v) && v.length === 2 && v.every(Number.isInteger) && v[0] >= 1 && v[0] <= v[1];
const isPathList = v => Array.isArray(v) && v.every(isStr);
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
// F20: a hidden test path names a file inside the workspace (and inside <task>/hidden/).
const isRelPath = v => isStr(v) && !path.isAbsolute(v) && !v.split(/[\\/]/).includes("..");
const isRelPathList = v => Array.isArray(v) && v.every(isRelPath);

/** Every schema problem of a parsed task.json, as readable strings; [] when valid. */
export function checkTaskSchema(t) {
  const p = [];
  if (!isObj(t)) return ["task.json is not an object"];
  if (t.schema !== "crb-task/v1") p.push(`schema must be "crb-task/v1" (got ${JSON.stringify(t.schema)})`);
  for (const k of ["id", "repo", "title", "description", "pr_patch"]) if (!isStr(t[k])) p.push(`${k} is required`);
  if (!KINDS.includes(t.kind)) p.push(`kind must be one of ${KINDS.join(", ")}`);
  if (t.visible_test_cmd !== null && t.visible_test_cmd !== undefined && !isStr(t.visible_test_cmd)) p.push("visible_test_cmd must be a command or null");
  if (!Array.isArray(t.bugs)) p.push("bugs must be an array");
  if (!Array.isArray(t.decoys)) p.push("decoys must be an array");
  if (!isRelPathList(t.clean_hidden_tests ?? [])) p.push("clean_hidden_tests must be a list of workspace-relative paths");
  if ((t.clean_hidden_tests ?? []).length && !isStr(t.clean_hidden_test_cmd)) p.push("clean_hidden_test_cmd is required with clean_hidden_tests");
  if (p.some(s => s.startsWith("bugs ") || s.startsWith("decoys "))) return p;

  const real = t.kind === "realbug";
  if (t.kind === "buggy" && (t.bugs.length < 1 || t.bugs.length > 3)) p.push("a buggy task has 1 to 3 bugs");
  if (real && t.bugs.length < 1) p.push("a realbug task has at least one bug");
  if (t.kind === "clean" && t.bugs.length) p.push("a clean task must have no bugs");
  if (t.kind === "decoy" && t.bugs.length) p.push("a decoy task must have no bugs");
  if (t.kind === "decoy" && !t.decoys.length) p.push("a decoy task needs at least one decoy");

  const ids = new Set();
  t.bugs.forEach((b, i) => {
    const at = `bugs[${i}]`;
    if (!isObj(b)) return p.push(`${at} must be an object`);
    if (!/^B\d+$/.test(b.id ?? "")) p.push(`${at}.id must look like B1`);
    else if (ids.has(b.id)) p.push(`${at}.id ${b.id} is duplicated`);
    ids.add(b.id);
    if (!isStr(b.file)) p.push(`${at}.file is required`);
    if (!isLines(b.lines)) p.push(`${at}.lines must be [start, end] with 1 <= start <= end`);
    for (const k of ["category", "summary", "trigger", "fix_patch"]) if (!isStr(b[k])) p.push(`${at}.${k} is required`);
    if (!SEVERITIES.includes(b.severity)) p.push(`${at}.severity must be one of ${SEVERITIES.join(", ")}`);
    if (!DIFFICULTIES.includes(b.difficulty)) p.push(`${at}.difficulty must be one of ${DIFFICULTIES.join(", ")}`);
    if (typeof b.testable !== "boolean") p.push(`${at}.testable must be true or false`);
    if (b.testable === true) {
      if (!isRelPathList(b.hidden_tests) || !b.hidden_tests.length) p.push(`${at}.hidden_tests must list at least one workspace-relative path`);
      if (!isStr(b.hidden_test_cmd)) p.push(`${at}.hidden_test_cmd is required for a testable bug`);
    }
    if (b.testable === false && !isStr(b.justification)) p.push(`${at}.justification is required when testable is false`);
    if (!real) {
      if (!isStr(b.wrong_fix_patch)) p.push(`${at}.wrong_fix_patch is required`);
      if (!isStr(b.false_rebuttal)) p.push(`${at}.false_rebuttal is required`);
    }
  });

  const dids = new Set();
  t.decoys.forEach((d, i) => {
    const at = `decoys[${i}]`;
    if (!isObj(d)) return p.push(`${at} must be an object`);
    if (!/^D\d+$/.test(d.id ?? "")) p.push(`${at}.id must look like D1`);
    else if (dids.has(d.id)) p.push(`${at}.id ${d.id} is duplicated`);
    dids.add(d.id);
    if (!isStr(d.file)) p.push(`${at}.file is required`);
    if (!isLines(d.lines)) p.push(`${at}.lines must be [start, end] with 1 <= start <= end`);
    for (const k of ["looks_like", "why_correct", "valid_rebuttal"]) if (!isStr(d[k])) p.push(`${at}.${k} is required`);
    if (!isRelPathList(d.hidden_tests ?? [])) p.push(`${at}.hidden_tests must be a list of workspace-relative paths`);
    if ((d.hidden_tests ?? []).length && !isStr(d.hidden_test_cmd)) p.push(`${at}.hidden_test_cmd is required with hidden_tests`);
  });
  return p;
}

/**
 * Load and check a task directory. Adds dir, repoDir (the clean base) and repoConfig
 * (crb-repo.json). Synthetic tasks use <corpus>/repos/<repo>; real bugs carry their own repo/.
 */
export function loadTask(dir, { corpus = corpusRoot() } = {}) {
  const abs = path.resolve(dir);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(abs, "task.json"), "utf8"));
  } catch (e) {
    throw new TaskSchemaError(abs, [`cannot read task.json: ${e.message}`]);
  }
  const problems = checkTaskSchema(raw);
  if (!isObj(raw)) throw new TaskSchemaError(abs, problems);
  const repoDir = raw.kind === "realbug" ? path.join(abs, "repo") : path.join(corpus, "repos", String(raw.repo));
  let repoConfig = null;
  let readable = true;
  try {
    repoConfig = JSON.parse(fs.readFileSync(path.join(repoDir, "crb-repo.json"), "utf8"));
  } catch (e) {
    readable = false;
    problems.push(`cannot read ${path.join(repoDir, "crb-repo.json")}: ${e.message}`);
  }
  if (readable && !isObj(repoConfig)) problems.push("crb-repo.json is not an object");
  else if (readable && (raw.visible_test_cmd ?? null) === null && !isStr(repoConfig.test_cmd)) {
    problems.push("crb-repo.json test_cmd is required (a non-empty command) unless the task sets visible_test_cmd");
  }
  if (isStr(raw.pr_patch) && !fs.existsSync(path.join(abs, raw.pr_patch))) problems.push(`pr_patch ${raw.pr_patch} does not exist`);
  const entries = v => (Array.isArray(v) ? v.filter(isObj) : []);
  const paths = v => (Array.isArray(v) ? v : []);
  for (const b of entries(raw.bugs)) {
    for (const k of ["fix_patch", "wrong_fix_patch"]) {
      if (isStr(b[k]) && !fs.existsSync(path.join(abs, b[k]))) problems.push(`${b.id}.${k} ${b[k]} does not exist`);
    }
  }
  const hidden = [
    ...entries(raw.bugs).flatMap(b => paths(b.hidden_tests)),
    ...entries(raw.decoys).flatMap(d => paths(d.hidden_tests)),
    ...paths(raw.clean_hidden_tests),
  ];
  for (const h of hidden) {
    if (isRelPath(h) && !fs.existsSync(path.join(abs, "hidden", h))) problems.push(`hidden test hidden/${h} does not exist`);
  }
  if (problems.length) throw new TaskSchemaError(abs, problems);
  return { ...raw, dir: abs, repoDir, repoConfig };
}

/** Task directories of one repo, of every repo, or of the real-bug set. */
export function listTasks({ corpus = corpusRoot(), repo, all, realbugs } = {}) {
  const dirsIn = d => (fs.existsSync(d) ? fs.readdirSync(d).filter(n => fs.existsSync(path.join(d, n, "task.json"))).sort().map(n => path.join(d, n)) : []);
  if (realbugs) return dirsIn(path.join(corpus, "realbugs"));
  const tasksDir = path.join(corpus, "tasks");
  const repos = repo ? [repo] : all ? (fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : []) : [];
  return repos.flatMap(r => dirsIn(path.join(corpus, "tasks", r)));
}

const tally = (xs, keys) => Object.fromEntries([...new Set([...keys, ...xs])].map(k => [k, xs.filter(x => x === k).length]));

/**
 * One repo's tasks against the F8 quotas: { stats, checks: [{quota, ok, want, got}], ok }.
 * Counts come from task.json only; `crb validate` proves the tasks themselves.
 */
export function quotaStats(tasks, quotas) {
  const synthetic = tasks.filter(t => t.kind !== "realbug");
  const bugs = synthetic.flatMap(t => t.bugs);
  const stats = {
    tasks: synthetic.length,
    kinds: tally(synthetic.map(t => t.kind), Object.keys(quotas.kinds)),
    bugs: bugs.length,
    bugs_per_task: tally(synthetic.filter(t => t.kind === "buggy").map(t => String(t.bugs.length)), Object.keys(quotas.bugsPerTask)),
    difficulty: tally(bugs.map(b => b.difficulty), Object.keys(quotas.difficulty)),
    severity: tally(bugs.map(b => b.severity), Object.keys(quotas.severity)),
    categories: tally(bugs.map(b => b.category), []),
    untestable: bugs.filter(b => !b.testable).length,
  };
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const checks = [
    { quota: "kinds", ok: same(stats.kinds, quotas.kinds), want: quotas.kinds, got: stats.kinds },
    { quota: "bugs_per_task", ok: same(stats.bugs_per_task, Object.fromEntries(Object.entries(quotas.bugsPerTask).map(([k, v]) => [String(k), v]))), want: quotas.bugsPerTask, got: stats.bugs_per_task },
    { quota: "difficulty", ok: same(stats.difficulty, quotas.difficulty), want: quotas.difficulty, got: stats.difficulty },
    { quota: "severity", ok: same(stats.severity, quotas.severity), want: quotas.severity, got: stats.severity },
    { quota: "categories", ok: Object.keys(stats.categories).length >= quotas.minCategories, want: `>= ${quotas.minCategories}`, got: Object.keys(stats.categories).length },
    { quota: "untestable", ok: stats.untestable <= quotas.maxUntestable, want: `<= ${quotas.maxUntestable}`, got: stats.untestable },
  ];
  return { stats, checks, ok: checks.every(c => c.ok) };
}
