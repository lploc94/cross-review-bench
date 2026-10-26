import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTaskSchema, loadTask, TaskSchemaError, quotaStats, listTasks } from "../lib/task.js";
import { QUOTAS } from "../lib/config.js";
import { execFileSync } from "node:child_process";
import os from "node:os";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "corpus");
const t01 = () => JSON.parse(fs.readFileSync(path.join(FX, "tasks/pager-js/pager-js-T01/task.json"), "utf8"));

test("the fixture tasks pass the schema", () => {
  for (const id of ["pager-js-T01", "pager-js-T02", "pager-js-T03"]) {
    const task = loadTask(path.join(FX, "tasks/pager-js", id), { corpus: FX });
    assert.equal(task.id, id);
    assert.equal(task.repoDir, path.join(FX, "repos/pager-js"));
    assert.equal(task.repoConfig.language, "js");
  }
});

test("a buggy bug without false_rebuttal is rejected", () => {
  const t = t01();
  delete t.bugs[0].false_rebuttal;
  assert.match(checkTaskSchema(t).join("\n"), /bugs\[0\]\.false_rebuttal/);
});

test("an unknown kind is rejected", () => {
  const t = t01();
  t.kind = "broken";
  assert.match(checkTaskSchema(t).join("\n"), /kind/);
});

test("testable:false needs a justification", () => {
  const t = t01();
  t.bugs[1].testable = false;
  t.bugs[1].justification = null;
  assert.match(checkTaskSchema(t).join("\n"), /bugs\[1\]\.justification/);
});

test("a realbug needs no wrong fix or false rebuttal", () => {
  const t = t01();
  t.kind = "realbug";
  for (const b of t.bugs) { delete b.wrong_fix_patch; delete b.false_rebuttal; }
  assert.deepEqual(checkTaskSchema(t), []);
});

test("clean tasks carry no bugs and decoy tasks need a decoy", () => {
  const t = t01();
  t.kind = "clean";
  assert.match(checkTaskSchema(t).join("\n"), /clean task must have no bugs/);
  t.kind = "decoy";
  t.bugs = [];
  assert.match(checkTaskSchema(t).join("\n"), /decoy task needs at least one decoy/);
});

test("loadTask throws TaskSchemaError listing every problem", () => {
  const dir = fs.mkdtempSync(path.join(FX, "..", "tmp-task-"));
  try {
    const t = t01();
    t.schema = "crb-task/v0";
    t.bugs[0].severity = "huge";
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(t));
    assert.throws(() => loadTask(dir, { corpus: FX }), err => {
      assert.ok(err instanceof TaskSchemaError);
      assert.match(err.message, /schema/);
      assert.match(err.message, /severity/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hidden test paths must stay inside the workspace", () => {
  for (const bad of ["../../../sentinel.txt", "/tmp/x.test.js", "test/../../x.js"]) {
    const t = t01();
    t.bugs[0].hidden_tests = [bad];
    assert.match(checkTaskSchema(t).join("\n"), /bugs\[0\]\.hidden_tests/, bad);
    const c = t01();
    c.kind = "clean"; c.bugs = []; c.clean_hidden_tests = [bad]; c.clean_hidden_test_cmd = "true";
    assert.match(checkTaskSchema(c).join("\n"), /clean_hidden_tests/, bad);
  }
});

test("non-object bug and decoy entries are schema problems, not crashes", () => {
  const t = t01();
  t.bugs = [null, 3];
  t.decoys = ["D1"];
  const p = checkTaskSchema(t).join("\n");
  assert.match(p, /bugs\[0\] must be an object/);
  assert.match(p, /bugs\[1\] must be an object/);
  assert.match(p, /decoys\[0\] must be an object/);
});

function withTaskDir(t, fn, repoConfig) {
  const corpus = fs.mkdtempSync(path.join(FX, "..", "tmp-corpus-"));
  try {
    fs.cpSync(FX, corpus, { recursive: true });
    const dir = path.join(corpus, "tasks/pager-js/pager-js-T01");
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(t));
    if (repoConfig) fs.writeFileSync(path.join(corpus, "repos/pager-js/crb-repo.json"), JSON.stringify(repoConfig));
    return fn(dir, corpus);
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
}

test("loadTask reports a non-object task.json and null bugs as schema errors", () => {
  for (const raw of [null, [], { ...t01(), bugs: [null] }]) {
    withTaskDir(raw, (dir, corpus) => assert.throws(() => loadTask(dir, { corpus }), TaskSchemaError));
  }
});

test("a blank effective visible test command is a schema error", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(FX, "repos/pager-js/crb-repo.json"), "utf8"));
  withTaskDir(t01(), (dir, corpus) => assert.throws(() => loadTask(dir, { corpus }), /test_cmd/), { ...cfg, test_cmd: "" });
  withTaskDir(t01(), (dir, corpus) => assert.throws(() => loadTask(dir, { corpus }), /test_cmd/), { ...cfg, test_cmd: undefined });
  // a task-level command makes the repo default unnecessary
  withTaskDir({ ...t01(), visible_test_cmd: "node --test \"test/*.test.js\"" }, (dir, corpus) => assert.equal(loadTask(dir, { corpus }).id, "pager-js-T01"), { ...cfg, test_cmd: "" });
});

/** A repo's tasks meeting F8 exactly: 11 buggy (7×1, 3×2, 1×3 = 16 bugs), 3 clean, 2 decoy. */
function f8Tasks() {
  const diff = [..."1112222233333444"].map(n => `L${n}`);
  const sev = ["critical", "critical", ...Array(6).fill("high"), ...Array(6).fill("medium"), "low", "low"];
  const cats = ["logic", "boundary", "concurrency", "security", "data-integrity", "error-handling"];
  let k = 0;
  const bug = () => { const i = k++; return { id: `B${i}`, difficulty: diff[i], severity: sev[i], category: cats[i % cats.length], testable: i >= 2 }; };
  const counts = [1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3];
  return [
    ...counts.map(n => ({ kind: "buggy", bugs: Array.from({ length: n }, bug) })),
    ...Array(3).fill(0).map(() => ({ kind: "clean", bugs: [] })),
    ...Array(2).fill(0).map(() => ({ kind: "decoy", bugs: [] })),
  ];
}

test("F8 quota stats: an exact repo passes; each kind of miss is named", () => {
  const ok = quotaStats(f8Tasks(), QUOTAS);
  assert.equal(ok.ok, true, JSON.stringify(ok.checks));
  assert.deepEqual([ok.stats.tasks, ok.stats.bugs, ok.stats.untestable, Object.keys(ok.stats.categories).length], [16, 16, 2, 6]);
  const miss = mutate => { const t = f8Tasks(); mutate(t); return quotaStats(t, QUOTAS).checks.filter(c => !c.ok).map(c => c.quota); };
  assert.deepEqual(miss(t => { t[0].bugs[0].difficulty = "L4"; }), ["difficulty"]);
  assert.deepEqual(miss(t => { t[0].bugs[0].severity = "low"; }), ["severity"]);
  assert.deepEqual(miss(t => { t.forEach(x => x.bugs.forEach(b => { b.category = "logic"; })); }), ["categories"]);
  assert.deepEqual(miss(t => { t.forEach(x => x.bugs.forEach(b => { b.testable = false; })); }), ["untestable"]);
  assert.deepEqual(miss(t => { t[15].kind = "clean"; }), ["kinds"]);
  assert.deepEqual(miss(t => { t[9].bugs.push(t[8].bugs.pop()); }), ["bugs_per_task"]);
});

test("crb validate --repo R --stats prints the quota table without running oracles", () => {
  const crb = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "crb.js");
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), "crb-stats-"));
  try {
    fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "corpus"), corpus, { recursive: true });
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    let code = 0, out = "";
    try { out = execFileSync(process.execPath, [crb, "validate", "--repo", "pager-js", "--stats"], { env: { ...env, CRB_CORPUS: corpus }, encoding: "utf8" }); } catch (e) { code = e.status; out = e.stdout; }
    const r = JSON.parse(out);
    assert.equal(code, 1, "the toy repo is far below F8");
    assert.deepEqual([r.repo, r.stats.tasks, r.stats.kinds, r.stats.bugs], ["pager-js", 3, { buggy: 1, clean: 1, decoy: 1 }, 2]);
    assert.ok(r.checks.find(c => c.quota === "kinds" && !c.ok));
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
});

test("listTasks --all skips files such as .gitkeep next to the repository folders", () => {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), "crb-list-"));
  try {
    fs.mkdirSync(path.join(corpus, "tasks", "pager-js", "pager-js-T01"), { recursive: true });
    fs.writeFileSync(path.join(corpus, "tasks", "pager-js", "pager-js-T01", "task.json"), "{}");
    fs.writeFileSync(path.join(corpus, "tasks", ".gitkeep"), "");
    fs.writeFileSync(path.join(corpus, "tasks", "pager-js", "notes.md"), "");
    assert.deepEqual(listTasks({ corpus, all: true }), [path.join(corpus, "tasks", "pager-js", "pager-js-T01")]);
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
});
