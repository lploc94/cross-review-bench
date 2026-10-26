import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadTask } from "../lib/task.js";
import { materialize } from "../lib/workspace.js";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "corpus");

/** The fixture corpus as its own git repo (the harness archives corpus HEAD), with one uncommitted edit. */
function gitCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-gitcorpus-"));
  fs.cpSync(FX, dir, { recursive: true });
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "corpus");
  fs.appendFileSync(path.join(dir, "repos/pager-js/src/pager.js"), "// uncommitted\n");
  return dir;
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base)); else out.push(path.relative(base, p));
  }
  return out;
}

test("a task workspace is the committed repo plus the uncommitted PR, with no answer material", async () => {
  const corpus = gitCorpus();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-run-"));
  try {
    const task = loadTask(path.join(corpus, "tasks/pager-js/pager-js-T01"), { corpus });
    const ws = await materialize(task, runDir);
    assert.equal(ws, path.join(runDir, "pager-js"));
    const git = (...a) => execFileSync("git", a, { cwd: ws, encoding: "utf8" });
    const log = git("log", "--format=%an <%ae> %aI|%cn <%ce> %cI|%s").trim().split("\n");
    assert.deepEqual(log, ["Dev <dev@example.com> 2026-01-01T00:00:00Z|Dev <dev@example.com> 2026-01-01T00:00:00Z|Initial import"]);
    assert.notEqual(git("status", "--porcelain").trim(), "");
    assert.equal(git("diff", "--stat").includes("src/pager.js"), true);
    // corpus HEAD, not the corpus working tree
    assert.equal(fs.readFileSync(path.join(ws, "src/pager.js"), "utf8").includes("// uncommitted"), false);
    const files = walk(ws);
    for (const f of files) {
      assert.doesNotMatch(f, /(^|\/)(task\.json|hidden|fix-|wrongfix-|crb-repo\.json)/, f);
    }
    assert.ok(files.includes("src/pager.js") && files.includes("test/pager.test.js"), files.join(","));
    // the PR's patch text is applied, not copied in
    assert.equal(files.some(f => f.endsWith(".patch")), false);
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("materialize can leave the PR out (Track C baselines and checks)", async () => {
  const corpus = gitCorpus();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-run-"));
  try {
    const task = loadTask(path.join(corpus, "tasks/pager-js/pager-js-T01"), { corpus });
    const ws = await materialize(task, runDir, { applyPatch: false });
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: ws, encoding: "utf8" }).trim(), "");
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("a corpus that is not a git repository is refused", async () => {
  const corpus = fs.mkdtempSync(path.join(os.tmpdir(), "crb-nogit-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-run-"));
  try {
    fs.cpSync(FX, corpus, { recursive: true });
    const task = loadTask(path.join(corpus, "tasks/pager-js/pager-js-T01"), { corpus });
    await assert.rejects(materialize(task, runDir), /git/);
  } finally {
    fs.rmSync(corpus, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
