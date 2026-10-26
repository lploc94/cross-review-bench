// crb validate: prove that a task's ground truth is real (oracles V1–V9, plan Phase 1).
//
// Every oracle that runs tests works on a fresh copy of the prepared base (stage), with its own
// services lease when the repo needs Postgres/Redis. Hidden tests are copied into a stage only for
// their own check and removed afterwards (F20), so one bug's failing test never leaks into another.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run, sh, tail, cleanEnv, interrupted } from "./exec.js";
import { loadTask, TaskSchemaError } from "./task.js";
import { scratchDir } from "./paths.js";
import { prepareDeps, toolchainEnv } from "./cache.js";
import { checkSource, SINCE } from "./realbugs.js";

export const HINT_WORDS = ["bug", "bugs", "fixme", "todo", "xxx", "hack", "intentional", "planted", "bench", "crb", "decoy", "hidden"];
const COPY_EXCLUDE = [".git", "node_modules", ".venv", "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"];
const GIT_ID = ["-c", "user.email=dev@example.com", "-c", "user.name=Dev", "-c", "commit.gpgsign=false"];
const NEAR = 10;

// ---------- patch parsing ----------

/** A file name from a ---/+++ header: git quotes unusual names C-style ("b/\303\241.js"). */
function headerPath(raw) {
  const s = raw.replace(/\r$/, "");
  if (!s.startsWith('"')) return s.split("\t")[0];
  const bytes = [];
  const ESC = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (let i = 1; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i));
    if (ch === '"') break;
    if (ch !== "\\") { bytes.push(...Buffer.from(ch)); i += ch.length; continue; }
    const n = s[i + 1];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(s.slice(i + 1, i + 4), 8)); i += 4; continue; }
    bytes.push(ESC[n] ?? n.charCodeAt(0));
    i += 2;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Hunks of a unified diff. A hunk's body is bounded by the line counts in its @@ header, so an added
 * line that happens to start with "++" or "--" is never mistaken for a file header.
 */
function* hunks(patch) {
  let oldFile = null;
  let newFile = null;
  const lines = patch.split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i++];
    if (l.startsWith("diff --git ")) { oldFile = newFile = null; continue; }
    if (l.startsWith("--- ")) { const p = headerPath(l.slice(4)); oldFile = p === "/dev/null" ? null : p.replace(/^a\//, ""); continue; }
    if (l.startsWith("+++ ")) { const p = headerPath(l.slice(4)); newFile = p === "/dev/null" ? null : p.replace(/^b\//, ""); continue; }
    const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
    let newLeft = m[4] === undefined ? 1 : Number(m[4]);
    const body = [];
    while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const b = lines[i];
      if (b.startsWith("\\")) { i++; continue; } // "\ No newline at end of file"
      if (b.startsWith("+")) newLeft--;
      else if (b.startsWith("-")) oldLeft--;
      else if (b.startsWith(" ") || b === "") { oldLeft--; newLeft--; }
      else break;
      body.push(b);
      i++;
    }
    const file = newFile ?? oldFile;
    if (file) yield { file, oldStart: Number(m[1]), newStart: Number(m[3]), body };
  }
}

/** file → Set of new-file line numbers of the patch's added lines. */
export function addedLines(patch) {
  const out = new Map();
  for (const h of hunks(patch)) {
    const set = out.get(h.file) ?? new Set();
    let n = h.newStart;
    for (const l of h.body) {
      if (l.startsWith("+")) { set.add(n); n++; } else if (!l.startsWith("-")) n++;
    }
    out.set(h.file, set);
  }
  return out;
}

/** file → Set of old-file line numbers the patch removes or inserts at. */
export function touchedOldLines(patch) {
  const out = new Map();
  for (const h of hunks(patch)) {
    const set = out.get(h.file) ?? new Set();
    let o = h.oldStart;
    for (const l of h.body) {
      if (l.startsWith("-")) { set.add(o); o++; } else if (l.startsWith("+")) set.add(o); else o++;
    }
    out.set(h.file, set);
  }
  return out;
}

/** Hint words (whole words, case-insensitive) in the description and the patch's added lines. */
export function hintWords(description, patch, allow = []) {
  const added = [...hunks(patch || "")].flatMap(h => h.body.filter(l => l.startsWith("+")).map(l => l.slice(1)));
  const text = [description || "", ...added].join("\n");
  const allowed = new Set(allow.map(w => w.toLowerCase()));
  return HINT_WORDS.filter(w => !allowed.has(w) && new RegExp(`\\b${w}\\b`, "i").test(text));
}

// ---------- stages ----------

async function cloneDir(src, dest) {
  const r = await run("cp", ["-cR", src, dest]);
  if (r.code !== 0) fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
}

const leaves = rel => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

function* symlinksUnder(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (COPY_EXCLUDE.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) yield p;
    else if (e.isDirectory()) yield* symlinksUnder(p);
  }
}

/**
 * Every symlink under dir (the repo, or a stage after a patch) must resolve inside dir, so writes
 * through it never reach the corpus or the host. Dependency folders (COPY_EXCLUDE) are not walked.
 */
function checkSymlinks(dir) {
  for (const link of symlinksUnder(dir)) {
    const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
    if (leaves(path.relative(dir, target))) throw new Error(`symlink ${path.relative(dir, link)} points outside the repository (${fs.readlinkSync(link)})`);
  }
}

async function prepareBase(task, root) {
  const base = path.join(root, "base");
  fs.cpSync(task.repoDir, base, {
    recursive: true,
    verbatimSymlinks: true,
    filter: src => !COPY_EXCLUDE.includes(path.basename(src)) || src === task.repoDir,
  });
  checkSymlinks(base);
  const env = cleanEnv();
  const init = await run("git", ["init", "-q"], { cwd: base, env });
  const add = await run("git", ["add", "-A"], { cwd: base, env });
  const commit = await run("git", [...GIT_ID, "commit", "-q", "-m", "Initial import"], { cwd: base, env });
  if ([init, add, commit].some(r => r.code !== 0)) throw new Error(`cannot create base git repo: ${tail(commit)}`);
  await prepareDeps(task, base, { GOCACHE: toolchainEnv({ scratch: root }).GOCACHE });
  return base;
}

function noServices(task) {
  return {
    provision: async () => {
      if ((task.repoConfig.services ?? []).length) throw new Error(`repo needs services ${task.repoConfig.services.join(", ")} but none were provided`);
      return {};
    },
    release: async () => {},
  };
}

async function applyPatch(ws, patchPath) {
  const env = cleanEnv();
  const check = await run("git", ["apply", "--check", patchPath], { cwd: ws, env });
  if (check.code !== 0) return { ok: false, detail: `${path.basename(patchPath)} does not apply: ${tail(check, 4)}` };
  const apply = await run("git", ["apply", patchPath], { cwd: ws, env });
  if (apply.code !== 0) return { ok: false, detail: `${path.basename(patchPath)} failed: ${tail(apply, 4)}` };
  try {
    checkSymlinks(ws);
  } catch (e) {
    return { ok: false, detail: `${path.basename(patchPath)}: ${e.message}` };
  }
  return { ok: true };
}

/**
 * ws/rel for a hidden test. Refuses a path that leaves ws lexically or through a symlink on the way
 * (resolved at the deepest existing ancestor), and a destination that is itself a symlink.
 */
function inside(ws, rel) {
  const dest = path.resolve(ws, rel);
  if (path.isAbsolute(rel) || leaves(path.relative(ws, dest))) throw new Error(`hidden test path ${rel} leaves the workspace`);
  let probe = dest;
  while (!fs.lstatSync(probe, { throwIfNoEntry: false })) probe = path.dirname(probe);
  if (leaves(path.relative(fs.realpathSync(ws), fs.realpathSync(probe)))) throw new Error(`hidden test path ${rel} leads outside the workspace through a symlink`);
  if (fs.lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`hidden test path ${rel} is a symlink in the workspace`);
  return dest;
}

export function copyHidden(task, ws, rels) {
  for (const rel of rels) {
    const dest = inside(ws, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(task.dir, "hidden", rel), dest);
  }
}

export function removeHidden(ws, rels) {
  for (const rel of rels) fs.rmSync(inside(ws, rel), { force: true });
}

// ---------- the validator ----------

/**
 * Validate one task directory. Resolves { task, results: [{oracle, ok, detail}], ok, exitCode }.
 * exitCode: 0 every oracle passed, 1 an oracle failed, 2 schema/usage error.
 */
export async function validateTask(dir, { corpus, services, env: extraEnv = {}, timeoutMs } = {}) {
  const results = [];
  const push = (oracle, ok, detail) => results.push({ oracle, ok, detail });
  let task;
  try {
    task = loadTask(dir, corpus ? { corpus } : {});
  } catch (e) {
    if (!(e instanceof TaskSchemaError)) throw e;
    push("V9", false, e.problems.join("; "));
    return { task: null, results, ok: false, exitCode: 2 };
  }
  const realbug = task.kind === "realbug";
  if (realbug) {
    let problems;
    try {
      problems = checkSource(JSON.parse(fs.readFileSync(path.join(task.dir, "source.json"), "utf8")), { since: SINCE });
    } catch (e) {
      problems = [`cannot read source.json: ${e.message}`];
    }
    if (problems.length) {
      push("V9", false, problems.join("; "));
      return { task, results, ok: false, exitCode: 2 };
    }
  }
  push("V9", true, "schema valid");
  const prPath = path.join(task.dir, task.pr_patch);
  const prText = fs.readFileSync(prPath, "utf8");

  // V8: no hint words
  if (!realbug) {
    const words = hintWords(task.description, prText, task.repoConfig.allow_words ?? []);
    push("V8", words.length === 0, words.length ? `hint words: ${words.join(", ")}` : "no hint words");
  }

  // V7: each bug lies in lines the PR adds or changes
  const added = addedLines(prText);
  for (const b of task.bugs) {
    if (realbug && b.justification) { push("V7", true, `${b.id}: waived (${b.justification})`); continue; }
    const set = added.get(b.file) ?? new Set();
    let hit = false;
    for (let n = b.lines[0]; n <= b.lines[1]; n++) if (set.has(n)) hit = true;
    push("V7", hit, hit ? `${b.id}: inside the PR's changes` : `${b.id}: ${b.file}:${b.lines.join("-")} is not in a line the PR adds or changes`);
  }

  const svc = services ? services(task) : noServices(task);
  const visible = task.visible_test_cmd ?? task.repoConfig.test_cmd;
  const root = path.join(scratchDir(), `validate-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(root, { recursive: true });
  let stageN = 0;

  async function withStage(fn) {
    const ws = path.join(root, `stage-${++stageN}`);
    await cloneDir(base, ws);
    // a virtualenv names the directory it was built in (script shebangs, the project's .pth), so a
    // cloned one would run the base's code: build the stage its own from the dependency cache
    if (fs.existsSync(path.join(ws, ".venv"))) {
      fs.rmSync(path.join(ws, ".venv"), { recursive: true, force: true });
      await prepareDeps(task, ws, { GOCACHE: toolchainEnv({ scratch: root }).GOCACHE });
    }
    const hex = crypto.randomBytes(4).toString("hex");
    const env = cleanEnv({ ...toolchainEnv({ scratch: root }), ...(await svc.provision(hex)), ...extraEnv });
    try {
      return await fn(ws, env);
    } finally {
      await svc.release(hex);
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
  const test = (line, ws, env) => sh(line, { cwd: ws, env, timeoutMs });

  let base;
  try {
    base = await prepareBase(task, root);

    // V1: base passes its visible tests
    await withStage(async (ws, env) => {
      const r = await test(visible, ws, env);
      push("V1", r.code === 0, r.code === 0 ? "base visible tests pass" : `base visible tests fail:\n${tail(r)}`);
    });

    // V2: the PR applies and keeps visible tests, typecheck and lint green
    let prOk = false;
    await withStage(async (ws, env) => {
      const a = await applyPatch(ws, prPath);
      if (!a.ok) return push("V2", false, a.detail);
      const r = await test(visible, ws, env);
      if (r.code !== 0) return push("V2", false, `visible tests fail on the PR:\n${tail(r)}`);
      // a reviewer may run the repository's own checks; a PR that fails them carries a defect nobody chose
      const checks = realbug ? [] : [["typecheck", task.repoConfig.typecheck_cmd], ["lint", task.repoConfig.lint_cmd]].filter(([, c]) => c);
      for (const [name, cmd] of checks) {
        const c = await test(cmd, ws, env);
        if (c.code !== 0) return push("V2", false, `${name} fails on the PR:\n${tail(c)}`);
      }
      prOk = true;
      push("V2", true, `PR applies; visible tests pass${checks.length ? `; ${checks.map(([n]) => n).join(" and ")} pass` : ""}`);
    });
    if (!prOk) return finish();

    const withPr = (fn) => withStage(async (ws, env) => {
      const a = await applyPatch(ws, prPath);
      if (!a.ok) throw new Error(a.detail);
      return fn(ws, env);
    });
    const hiddenRun = async (ws, env, rels, cmd) => {
      copyHidden(task, ws, rels);
      try { return await test(cmd, ws, env); } finally { removeHidden(ws, rels); }
    };
    const testable = task.bugs.filter(b => b.testable);
    // Combined checks apply one patch of every bug, then run one bug's hidden tests per fresh stage,
    // so build output a hidden test leaves behind never decides another bug's check.
    const withAll = (key, fn) => withPr(async (ws, env) => {
      for (const b of task.bugs) {
        const a = await applyPatch(ws, path.join(task.dir, b[key]));
        if (!a.ok) return `${b.id}: ${a.detail}`;
      }
      return fn(ws, env);
    });
    // An expected failure must be a completed run with a nonzero exit, never a timeout or a kill.
    const failsAsExpected = r => !interrupted(r) && r.code !== 0;

    // V3: each hidden test fails on the PR
    for (const b of testable) {
      await withPr(async (ws, env) => {
        const r = await hiddenRun(ws, env, b.hidden_tests, b.hidden_test_cmd);
        const ok = failsAsExpected(r);
        push("V3", ok, ok ? `${b.id}: hidden tests fail on the PR` : interrupted(r) ? `${b.id}: hidden tests did not finish on the PR: ${tail(r, 4)}` : `${b.id}: hidden tests already pass on the PR`);
      });
    }

    // V4: each fix makes its hidden test pass; all fixes together keep everything green
    for (const b of task.bugs) {
      await withPr(async (ws, env) => {
        const a = await applyPatch(ws, path.join(task.dir, b.fix_patch));
        if (!a.ok) return push("V4", false, `${b.id}: ${a.detail}`);
        if (!b.testable) return push("V4", true, `${b.id}: fix applies (not testable: ${b.justification})`);
        const r = await hiddenRun(ws, env, b.hidden_tests, b.hidden_test_cmd);
        push("V4", r.code === 0, r.code === 0 ? `${b.id}: hidden tests pass after ${b.fix_patch}` : `${b.id}: hidden tests still fail after ${b.fix_patch}:\n${tail(r)}`);
      });
    }
    if (task.bugs.length) {
      let problem = await withAll("fix_patch", async (ws, env) => {
        const v = await test(visible, ws, env);
        return v.code === 0 ? null : `visible tests fail:\n${tail(v)}`;
      });
      for (const b of testable) {
        if (problem) break;
        problem = await withAll("fix_patch", async (ws, env) => {
          const r = await hiddenRun(ws, env, b.hidden_tests, b.hidden_test_cmd);
          return r.code === 0 ? null : `${b.id} hidden tests fail:\n${tail(r)}`;
        });
      }
      push("V4", !problem, problem ? `all fixes: ${problem}` : "all fixes: visible and hidden tests pass");
    }

    // V5: wrong fixes are different, nearby, and leave the bug in place — alone and together
    if (!realbug && task.bugs.length) {
      for (const b of task.bugs) {
        const wf = fs.readFileSync(path.join(task.dir, b.wrong_fix_patch), "utf8");
        const fx = fs.readFileSync(path.join(task.dir, b.fix_patch), "utf8");
        if (!wf.trim()) { push("V5", false, `${b.id}: ${b.wrong_fix_patch} is empty`); continue; }
        if (wf.trim() === fx.trim()) { push("V5", false, `${b.id}: ${b.wrong_fix_patch} equals ${b.fix_patch}`); continue; }
        const near = [...(touchedOldLines(wf).get(b.file) ?? [])].some(n => n >= b.lines[0] - NEAR && n <= b.lines[1] + NEAR);
        if (!near) { push("V5", false, `${b.id}: ${b.wrong_fix_patch} does not touch ${b.file} within ±${NEAR} lines of the bug`); continue; }
        if (!b.testable) { push("V5", true, `${b.id}: wrong fix differs and is nearby (not testable)`); continue; }
        await withPr(async (ws, env) => {
          const a = await applyPatch(ws, path.join(task.dir, b.wrong_fix_patch));
          if (!a.ok) return push("V5", false, `${b.id}: ${a.detail}`);
          const r = await hiddenRun(ws, env, b.hidden_tests, b.hidden_test_cmd);
          const ok = failsAsExpected(r);
          push("V5", ok, ok ? `${b.id}: hidden tests still fail with ${b.wrong_fix_patch}` : interrupted(r) ? `${b.id}: hidden tests did not finish with ${b.wrong_fix_patch}: ${tail(r, 4)}` : `${b.id}: ${b.wrong_fix_patch} makes the hidden tests pass`);
        });
      }
      // with testable bugs, each combined stage below also proves that the wrong fixes apply together
      let problem = testable.length ? null : await withAll("wrong_fix_patch", async () => null);
      for (const b of testable) {
        if (problem) break;
        problem = await withAll("wrong_fix_patch", async (ws, env) => {
          const r = await hiddenRun(ws, env, b.hidden_tests, b.hidden_test_cmd);
          if (failsAsExpected(r)) return null;
          return interrupted(r) ? `${b.id} hidden tests did not finish: ${tail(r, 4)}` : `${b.id} hidden tests pass`;
        });
      }
      push("V5", !problem, problem ? `all wrong fixes together: ${problem}` : "all wrong fixes apply together and every hidden test still fails");
    }

    // V6: clean and decoy hidden tests pass on the PR
    if ((task.clean_hidden_tests ?? []).length) {
      await withPr(async (ws, env) => {
        const r = await hiddenRun(ws, env, task.clean_hidden_tests, task.clean_hidden_test_cmd);
        push("V6", r.code === 0, r.code === 0 ? "clean hidden tests pass" : `clean hidden tests fail:\n${tail(r)}`);
      });
    }
    for (const d of task.decoys) {
      if (!(d.hidden_tests ?? []).length) continue;
      await withPr(async (ws, env) => {
        const r = await hiddenRun(ws, env, d.hidden_tests, d.hidden_test_cmd);
        push("V6", r.code === 0, r.code === 0 ? `${d.id}: decoy hidden tests pass` : `${d.id}: decoy hidden tests fail:\n${tail(r)}`);
      });
    }
    return finish();
  } catch (e) {
    push("ERROR", false, e.message);
    return finish();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  function finish() {
    const ok = results.every(r => r.ok);
    return { task, results, ok, exitCode: ok ? 0 : 1 };
  }
}
