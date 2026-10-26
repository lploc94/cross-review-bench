import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { validateTask, hintWords, addedLines } from "../lib/validate.js";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "corpus");

/** A writable copy of the fixture corpus, so a test can mutate one task. */
function copyCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-corpus-"));
  fs.cpSync(FX, dir, { recursive: true });
  return dir;
}
const taskDir = (corpus, id) => path.join(corpus, "tasks/pager-js", id);
const failed = res => res.results.filter(r => !r.ok).map(r => r.oracle);

for (const id of ["pager-js-T01", "pager-js-T02", "pager-js-T03"]) {
  test(`${id} passes every oracle`, async () => {
    const res = await validateTask(taskDir(FX, id), { corpus: FX });
    assert.deepEqual(failed(res), [], JSON.stringify(res.results, null, 2));
    assert.equal(res.ok, true);
  });
}

test("T01 runs every oracle it should", async () => {
  const res = await validateTask(taskDir(FX, "pager-js-T01"), { corpus: FX });
  const seen = new Set(res.results.map(r => r.oracle));
  for (const o of ["V1", "V2", "V3", "V4", "V5", "V7", "V8", "V9"]) assert.ok(seen.has(o), `missing ${o}`);
  // B2's hidden command runs every file in test/hidden/: it passes after fix-B2 only if B1's failing test is absent
  assert.ok(res.results.some(r => r.oracle === "V4" && r.ok && /B2/.test(r.detail)));
});

async function mutated(mutate) {
  const corpus = copyCorpus();
  try {
    const dir = taskDir(corpus, "pager-js-T01");
    mutate(dir);
    return await validateTask(dir, { corpus });
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
}
const editJson = (dir, f) => {
  const p = path.join(dir, "task.json");
  const t = JSON.parse(fs.readFileSync(p, "utf8"));
  f(t);
  fs.writeFileSync(p, JSON.stringify(t, null, 2));
};

test("V3 fails when a hidden test already passes on the PR", async () => {
  const res = await mutated(dir => fs.writeFileSync(path.join(dir, "hidden/test/hidden/page-zero.test.js"),
    'import { test } from "node:test";\ntest("always", () => {});\n'));
  assert.ok(failed(res).includes("V3"));
  assert.equal(res.ok, false);
});

test("V4 fails when the fix does not fix", async () => {
  const res = await mutated(dir => fs.copyFileSync(path.join(dir, "wrongfix-B2.patch"), path.join(dir, "fix-B2.patch")));
  assert.ok(failed(res).includes("V4"));
});

test("V5 fails when the wrong fix equals the fix", async () => {
  const res = await mutated(dir => fs.copyFileSync(path.join(dir, "fix-B1.patch"), path.join(dir, "wrongfix-B1.patch")));
  assert.ok(failed(res).includes("V5"));
});

test("V7 fails when the bug lines are outside the PR's changes", async () => {
  const res = await mutated(dir => editJson(dir, t => { t.bugs[0].lines = [1, 1]; }));
  assert.ok(failed(res).includes("V7"));
});

test("V2 fails when the PR breaks the repository's typecheck or lint, and passes when both pass", async () => {
  const withRepoCmds = async cmds => {
    const corpus = copyCorpus();
    try {
      const p = path.join(corpus, "repos/pager-js/crb-repo.json");
      fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, "utf8")), ...cmds }, null, 2));
      return await validateTask(taskDir(corpus, "pager-js-T01"), { corpus });
    } finally {
      fs.rmSync(corpus, { recursive: true, force: true });
    }
  };
  // passes on the base, fails once the PR adds pageCount
  const rejectsPr = "! grep -q 'export function pageCount' src/pager.js";
  for (const [key, word] of [["lint_cmd", "lint"], ["typecheck_cmd", "typecheck"]]) {
    const res = await withRepoCmds({ [key]: rejectsPr });
    const v2 = res.results.find(r => r.oracle === "V2");
    assert.equal(v2.ok, false, JSON.stringify(v2));
    assert.match(v2.detail, new RegExp(`${word} fails on the PR`));
    assert.equal(res.results.some(r => r.oracle === "V3"), false); // stops like a red visible suite
  }
  const res = await withRepoCmds({ typecheck_cmd: "true", lint_cmd: "test -f src/pager.js" });
  assert.deepEqual(failed(res), []);
  assert.match(res.results.find(r => r.oracle === "V2").detail, /typecheck and lint pass/);
});

test("every command of a validation shares one GOCACHE inside its scratch root, removed afterwards", async () => {
  const corpus = copyCorpus();
  const seen = path.join(corpus, "gocache-seen");
  try {
    const p = path.join(corpus, "repos/pager-js/crb-repo.json");
    const record = `case "$GOCACHE" in */validate-*/gocache) echo "$GOCACHE" >> '${seen}';; *) exit 1;; esac`;
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, "utf8")), typecheck_cmd: record, lint_cmd: record }, null, 2));
    const res = await validateTask(taskDir(corpus, "pager-js-T01"), { corpus });
    assert.deepEqual(failed(res), []);
    const dirs = [...new Set(fs.readFileSync(seen, "utf8").trim().split("\n"))];
    assert.equal(dirs.length, 1);
    assert.equal(fs.existsSync(dirs[0]), false);
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
});

test("every stage gets its own .venv, built in place (a virtualenv names its directory)", async () => {
  const corpus = copyCorpus();
  try {
    const p = path.join(corpus, "repos/pager-js/crb-repo.json");
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    // like uv: the environment records the absolute path it was built in
    const deps = "test -d .venv || { mkdir .venv && pwd -P > .venv/home; }";
    const own = 'test "$(cat .venv/home)" = "$(pwd -P)"';
    fs.writeFileSync(p, JSON.stringify({ ...cfg, deps_cmd: deps, test_cmd: `${own} && ${cfg.test_cmd}`, lint_cmd: own }, null, 2));
    const res = await validateTask(taskDir(corpus, "pager-js-T01"), { corpus });
    assert.deepEqual(failed(res), [], JSON.stringify(res.results.filter(r => !r.ok), null, 2));
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
});

test("V8 fails when the description hints at a bug", async () => {
  const res = await mutated(dir => editJson(dir, t => { t.description += " Also fixes a bug in paging."; }));
  assert.ok(failed(res).includes("V8"));
});

test("a schema error is reported as V9 with exit code 2", async () => {
  const res = await mutated(dir => editJson(dir, t => { t.kind = "nope"; }));
  assert.equal(res.exitCode, 2);
  assert.deepEqual(failed(res), ["V9"]);
});

test("hint words match whole words in the description and added lines only", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " const bug = 1; // context line, not added",
    "+logger.debug({ id }, \"debugging the planner\");",
    "+const x = 2;",
  ].join("\n");
  assert.deepEqual(hintWords("Add debug logging to the planner", patch, []), []);
  assert.deepEqual(hintWords("Fix the BUG in paging", "", []), ["bug"]);
  assert.deepEqual(hintWords("", patch.replace("const x = 2;", "// TODO: remove"), []), ["todo"]);
  assert.deepEqual(hintWords("A hidden field", "", ["hidden"]), []);
});

test("addedLines maps added lines to new-file line numbers", () => {
  const patch = fs.readFileSync(path.join(FX, "tasks/pager-js/pager-js-T01/pr.patch"), "utf8");
  const lines = addedLines(patch);
  assert.deepEqual([...lines.get("src/pager.js")], [5, 6, 9, 10, 11, 12, 13, 14]);
});

async function mutatedTask(id, mutate, opts = {}) {
  const corpus = copyCorpus();
  try {
    const dir = taskDir(corpus, id);
    await mutate(dir, corpus);
    const res = await validateTask(dir, { corpus, ...opts });
    return { res, corpus };
  } finally {
    if (!opts.keep) fs.rmSync(corpus, { recursive: true, force: true });
  }
}

test("a hidden test that times out is not taken as a failing test", async () => {
  const { res } = await mutatedTask("pager-js-T01", dir => editJson(dir, t => {
    t.bugs[0].hidden_test_cmd = 'if grep -q "page < 1" src/pager.js; then exit 0; else sleep 5; fi';
  }), { timeoutMs: 1500 });
  const v3 = res.results.find(r => r.oracle === "V3" && r.detail.startsWith("B1"));
  assert.equal(v3.ok, false);
  assert.match(v3.detail, /timed out/);
  const v5 = res.results.filter(r => r.oracle === "V5");
  assert.ok(v5.some(r => !r.ok && /timed out/.test(r.detail)), JSON.stringify(v5));
});

test("commands do not inherit the harness's environment", async () => {
  process.env.CRB_SENTINEL_VAR = "inherited";
  try {
    const { res } = await mutatedTask("pager-js-T02", dir => editJson(dir, t => {
      t.visible_test_cmd = 'test -z "$CRB_SENTINEL_VAR" && node --test "test/*.test.js"';
    }), { env: { EXTRA_OK: "1" } });
    assert.deepEqual(failed(res), [], JSON.stringify(res.results, null, 2));
  } finally {
    delete process.env.CRB_SENTINEL_VAR;
  }
});

test("a relative symlink in the repo stays inside the copy", async () => {
  const corpus = copyCorpus();
  try {
    const repo = path.join(corpus, "repos/pager-js");
    fs.writeFileSync(path.join(repo, "data.txt"), "original\n");
    fs.symlinkSync("data.txt", path.join(repo, "link.txt"));
    const dir = taskDir(corpus, "pager-js-T02");
    editJson(dir, t => { t.visible_test_cmd = 'echo mutated > link.txt && node --test "test/*.test.js"'; });
    const res = await validateTask(dir, { corpus });
    assert.deepEqual(failed(res), [], JSON.stringify(res.results, null, 2));
    assert.equal(fs.readFileSync(path.join(repo, "data.txt"), "utf8"), "original\n");
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
});

test("a symlink that points outside the repo stops validation", async () => {
  const corpus = copyCorpus();
  try {
    fs.symlinkSync("../../../outside.txt", path.join(corpus, "repos/pager-js/escape.txt"));
    const res = await validateTask(taskDir(corpus, "pager-js-T02"), { corpus });
    assert.equal(res.ok, false);
    assert.ok(res.results.some(r => r.oracle === "ERROR" && /escape\.txt.*outside/.test(r.detail)), JSON.stringify(res.results));
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
});

test("an escaping hidden test path is a schema error and touches nothing", async () => {
  const corpus = copyCorpus();
  try {
    const sentinel = path.join(corpus, "sentinel.txt");
    fs.writeFileSync(sentinel, "preserve");
    const dir = taskDir(corpus, "pager-js-T02");
    editJson(dir, t => { t.clean_hidden_tests = ["../../../sentinel.txt"]; t.clean_hidden_test_cmd = "true"; });
    const res = await validateTask(dir, { corpus });
    assert.equal(res.exitCode, 2);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve");
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
});

test("combined checks run each bug's hidden tests in a fresh copy", async () => {
  // Hidden commands that leave build output behind, and wrong fixes that together fix B2:
  // a shared workspace would keep B1's failing compiled test around during B2's check.
  const { res } = await mutatedTask("pager-js-T01", (dir, corpus) => {
    const p = path.join(dir, "wrongfix-B1.patch");
    fs.writeFileSync(p, gitPatch(corpus, dir, src => src
      .replace("export function paginate", "Math.round = Math.ceil;\nexport function paginate")
      .replace("page < 0)", "page < 0 || Object.is(page, -0))")));
    editJson(dir, t => {
      for (const b of t.bugs) b.hidden_test_cmd = 'mkdir -p test/compiled && cp test/hidden/*.js test/compiled/ && node --test "test/compiled/*.test.js"';
    });
  });
  const together = res.results.filter(r => r.oracle === "V5" && /together/.test(r.detail));
  assert.equal(together.length, 1, JSON.stringify(res.results, null, 2));
  assert.equal(together[0].ok, false);
  assert.match(together[0].detail, /B2/);
});

/** A patch against base+PR of the pager repo that rewrites src/pager.js with `edit`. */
function gitPatch(corpus, dir, edit) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "crb-patch-"));
  try {
    fs.cpSync(path.join(corpus, "repos/pager-js"), work, { recursive: true });
    const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: work, encoding: "utf8" });
    git("init", "-q");
    git("apply", path.join(dir, "pr.patch"));
    git("add", "-A");
    git("commit", "-qm", "pr");
    const f = path.join(work, "src/pager.js");
    fs.writeFileSync(f, edit(fs.readFileSync(f, "utf8")));
    return git("diff");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

test("addedLines decodes git's quoted file names", () => {
  const patch = [
    'diff --git "a/src/\\303\\241.js" "b/src/\\303\\241.js"',
    'index 1111111..2222222 100644',
    '--- "a/src/\\303\\241.js"',
    '+++ "b/src/\\303\\241.js"',
    "@@ -1 +1 @@",
    "-a",
    "+b",
    'diff --git "a/q\\"t.js" "b/q\\"t.js"',
    '--- "a/q\\"t.js"',
    '+++ "b/q\\"t.js"',
    "@@ -1 +1,2 @@",
    " a",
    "+b",
    "diff --git a/with space.js b/with space.js",
    "--- a/with space.js\t",
    "+++ b/with space.js\t",
    "@@ -0,0 +1 @@",
    "+x",
  ].join("\n");
  const lines = addedLines(patch);
  assert.deepEqual([...lines.keys()], ["src/á.js", 'q"t.js', "with space.js"]);
  assert.deepEqual([...lines.get('q"t.js')], [2]);
});

test("an added line that starts with ++ is scanned for hint words", () => {
  const patch = [
    "diff --git a/src/c.js b/src/c.js",
    "--- a/src/c.js",
    "+++ b/src/c.js",
    "@@ -1,1 +1,2 @@",
    " let counter = 0;",
    "+++counter; // TODO: revisit",
  ].join("\n");
  assert.deepEqual(hintWords("", patch, []), ["todo"]);
  assert.deepEqual([...addedLines(patch).get("src/c.js")], [2]);
});

test("a symlink the PR adds cannot carry hidden tests or writes outside the workspace", async () => {
  const corpus = copyCorpus();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crb-outside-"));
  try {
    const sentinel = path.join(outside, "sentinel.txt");
    fs.writeFileSync(sentinel, "preserve");
    const dir = taskDir(corpus, "pager-js-T02");
    fs.appendFileSync(path.join(dir, "pr.patch"),
      `diff --git a/output b/output\nnew file mode 120000\n--- /dev/null\n+++ b/output\n@@ -0,0 +1 @@\n+${outside}\n\\ No newline at end of file\n`);
    fs.mkdirSync(path.join(dir, "hidden/output"));
    fs.writeFileSync(path.join(dir, "hidden/output/sentinel.txt"), "replacement");
    editJson(dir, t => { t.clean_hidden_tests = ["output/sentinel.txt"]; t.clean_hidden_test_cmd = "true"; });
    const res = await validateTask(dir, { corpus });
    assert.equal(res.ok, false);
    assert.ok(res.results.some(r => !r.ok && /output.*outside/.test(r.detail)), JSON.stringify(res.results));
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve");
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a null crb-repo.json is a schema error", async () => {
  const corpus = copyCorpus();
  try {
    fs.writeFileSync(path.join(corpus, "repos/pager-js/crb-repo.json"), "null");
    const res = await validateTask(taskDir(corpus, "pager-js-T02"), { corpus });
    assert.equal(res.exitCode, 2);
    assert.match(res.results[0].detail, /crb-repo\.json is not an object/);
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
  }
});
