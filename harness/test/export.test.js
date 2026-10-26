// crb export (Phase 22): the release bundle carries public tasks with their answer keys, real bugs,
// public runs and scores, the harness and the write-ups; nothing of a private task's answer material,
// no home path, no denied string, no token; a manifest hashes every file. All data is invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { exportBundle } from "../lib/export.js";

const SECRET = "ZEBRA-PRIVATE-ANSWER";
const HOME = "/Users/invented-person";

const write = (root, rel, text) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd });
const commitAll = dir => {
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "x");
};
const walk = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath, e.name)));

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crb-export-"));
  const corpus = path.join(root, "corpus");
  const bench = path.join(root, "bench");
  const runs = path.join(root, "runs");
  const task = (id, summary, extra = {}) => {
    const d = `tasks/pager-js/${id}`;
    write(corpus, `${d}/task.json`, JSON.stringify({ id, repo: "pager-js", kind: "buggy", bugs: [{ id: "B1", summary }] }));
    write(corpus, `${d}/pr.patch`, `--- a/src/pager.js\n+++ b/src/pager.js\n@@ ${id} @@\n`);
    write(corpus, `${d}/fix-B1.patch`, `fix for ${id}: ${summary}\n`);
    write(corpus, `${d}/hidden/test/hidden.test.js`, `// hidden test of ${id}: ${summary}\n`);
    for (const [k, v] of Object.entries(extra)) write(corpus, `${d}/${k}`, v);
  };
  write(corpus, "README.md", "# Invented corpus\n");
  write(corpus, "repos/pager-js/src/pager.js", "export const page = n => n;\n");
  write(corpus, "repos/pager-js/scripts/test.sh", "#!/bin/sh\necho ok\n");
  fs.chmodSync(path.join(corpus, "repos/pager-js/scripts/test.sh"), 0o755);
  task("pager-js-T01", "page zero is accepted when it should be rejected");
  task("pager-js-T02", "the last page drops its final item");
  task("pager-js-T03", `${SECRET}: the cursor wraps past the end`, {
    "task.json": JSON.stringify({ id: "pager-js-T03", repo: "pager-js", kind: "buggy", bugs: [{ id: "B1", summary: `${SECRET}: the cursor wraps past the end`, trigger: "ask for the page after the last one twice", false_rebuttal: "the wrap is intended for carousel views" }] }),
  });
  write(corpus, "tasks/pager-js/pager-js-T04/task.json", JSON.stringify({ id: "pager-js-T04", repo: "pager-js", kind: "decoy", bugs: [], decoys: [{ id: "D1", looks_like: "an off-by-one in the page bound", why_correct: "the bound is \"exclusive\" because\npages start at one", valid_rebuttal: "pages are one-based, so the exclusive bound is right" }] }));
  write(corpus, "realbugs/rb-js-demo-1/task.json", JSON.stringify({ id: "rb-js-demo-1", bugs: [{ id: "B1", summary: "an invented real bug" }] }));
  write(corpus, "realbugs/rb-js-demo-1/repo/index.js", "module.exports = 1;\n");
  // a tracked link whose target the upstream kept in a submodule: it dangles in the checkout
  fs.symlinkSync("../fixtures/labels", path.join(corpus, "realbugs/rb-js-demo-1/repo/labels"));
  write(corpus, "splits.json", JSON.stringify({ seed: "1", public: ["pager-js-T01", "pager-js-T02", "rb-js-demo-1"], private: ["pager-js-T03", "pager-js-T04"] }));
  commitAll(corpus);
  // untracked build output in the corpus stays out
  write(corpus, "repos/pager-js/node_modules/junk/index.js", "junk\n");

  write(bench, "METHODOLOGY.md", "# Methodology\n");
  write(bench, "README.md", "# Bench\n");
  write(bench, "package.json", "{}\n");
  write(bench, "harness/lib/x.js", "export const x = 1;\n");
  write(bench, "analysis/a.py", "A = 1\n");
  write(bench, "report/REPORT.md", `# Report\nRun logs live in ${HOME}/.crbench/runs.\n`);
  write(bench, "results/leaderboard.json", JSON.stringify({ leaderboard: [{ system: "alpha-high", f1: 0.5 }] }));
  write(bench, "results/scores.jsonl", ["pager-js-T01", "pager-js-T03", "rb-js-demo-1"].map(t => JSON.stringify({ track: "A", task: t, tp_weight: 1 })).join("\n") + "\n");
  write(bench, "results/pool.json", JSON.stringify({ set: "final", bugs: [{ id: "P1", task: "pager-js-T01", severity: "major" }, { id: "P2", task: "pager-js-T03", severity: "minor" }, { id: "P3", task: "rb-js-demo-1", severity: "minor" }] }));
  write(bench, "trackc/tasks.txt", "# Track C tasks\npager-js/pager-js-T01\npager-js/pager-js-T03\n");
  write(bench, "pilot/blind.mjs", "export const b = 1;\n");
  write(bench, "AGENTS.md", "dev notes stay out\n");
  commitAll(bench);

  const run = (track, reviewer, t) => {
    const d = `final/${track}/high/${reviewer}/${t}/1`;
    write(runs, `${d}/run.json`, JSON.stringify({ id: d, set: "final", track, task: t, workspace: `/tmp/crw/0000aaaa/pager-js` }));
    write(runs, `${d}/session/output.jsonl`, `${JSON.stringify({ type: "item", cwd: `${HOME}/projects/x`, text: `reviewing ${t}` })}\n`);
  };
  run("A", "codex", "pager-js-T01");
  run("A", "codex", "pager-js-T03");
  run("C", "claude-codex", "pager-js-T01");
  run("A", "claude", "rb-js-demo-1");
  write(runs, "flagged/final/A/high/codex/pager-js-T01/1-abcd/run.json", "{}");
  write(runs, "smoke/A/high/codex/pager-js-T01/1/run.json", "{}");
  const opts = { out: path.join(root, "release"), corpus, bench, runs, set: "final", home: HOME, deny: ["person@example.invalid"] };
  return { root, corpus, bench, runs, opts, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("the bundle carries public tasks, real bugs, public runs and scores; nothing of a private task", () => {
  const s = setup();
  try {
    const out = exportBundle(s.opts);
    const files = walk(s.opts.out).sort();
    assert.ok(files.includes("corpus/tasks/pager-js/pager-js-T01/fix-B1.patch"));
    assert.ok(files.includes("corpus/tasks/pager-js/pager-js-T02/hidden/test/hidden.test.js"));
    assert.ok(files.includes("corpus/realbugs/rb-js-demo-1/repo/index.js"));
    // a tracked link stays a link to the same target, dangling or not
    assert.equal(fs.readlinkSync(path.join(s.opts.out, "corpus/realbugs/rb-js-demo-1/repo/labels")), "../fixtures/labels");
    assert.ok(files.includes("corpus/repos/pager-js/src/pager.js"));
    // executable files stay executable; others do not become so
    assert.equal(fs.statSync(path.join(s.opts.out, "corpus/repos/pager-js/scripts/test.sh")).mode & 0o111, 0o111);
    assert.equal(fs.statSync(path.join(s.opts.out, "corpus/repos/pager-js/src/pager.js")).mode & 0o111, 0);
    assert.ok(files.includes("corpus/splits.json"));
    assert.ok(files.includes("runs/final/A/high/codex/pager-js-T01/1/session/output.jsonl"));
    assert.ok(files.includes("runs/final/C/high/claude-codex/pager-js-T01/1/run.json"));
    assert.ok(files.includes("runs/final/A/high/claude/rb-js-demo-1/1/run.json"));
    for (const f of ["bench/METHODOLOGY.md", "bench/harness/lib/x.js", "bench/analysis/a.py", "bench/report/REPORT.md", "bench/results/leaderboard.json", "bench/trackc/tasks.txt", "bench/pilot/blind.mjs"]) assert.ok(files.includes(f), f);

    // nothing of the private task: no folder, no run, no score row, no answer text anywhere
    assert.ok(!files.some(f => f.includes("pager-js-T03")), files.filter(f => f.includes("pager-js-T03")).join(", "));
    for (const f of files) assert.ok(!fs.readFileSync(path.join(s.opts.out, f), "utf8").includes(SECRET), f);
    const rows = fs.readFileSync(path.join(s.opts.out, "bench/results/scores.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l).task);
    assert.deepEqual(rows, ["pager-js-T01", "rb-js-demo-1"]);
    // the pooled bugs of private tasks leave pool.json
    const pool = JSON.parse(fs.readFileSync(path.join(s.opts.out, "bench/results/pool.json"), "utf8"));
    assert.deepEqual(pool, { set: "final", bugs: [{ id: "P1", task: "pager-js-T01", severity: "major" }, { id: "P3", task: "rb-js-demo-1", severity: "minor" }] });

    // untracked files, dev notes, other sets and flagged attempts stay out
    assert.ok(!files.some(f => f.includes("node_modules") || f.endsWith("AGENTS.md") || f.includes("flagged") || f.includes("smoke")));

    // the home path is redacted
    assert.match(fs.readFileSync(path.join(s.opts.out, "bench/report/REPORT.md"), "utf8"), /Run logs live in ~\/\.crbench\/runs\./);
    assert.ok(!fs.readFileSync(path.join(s.opts.out, "runs/final/A/high/codex/pager-js-T01/1/session/output.jsonl"), "utf8").includes(HOME));

    assert.equal(out.public_tasks, 3);
    assert.equal(out.private_tasks_omitted, 2);
  } finally {
    s.cleanup();
  }
});

test("the manifest lists every file with its SHA-256 and size", () => {
  const s = setup();
  try {
    exportBundle(s.opts);
    const manifest = JSON.parse(fs.readFileSync(path.join(s.opts.out, "manifest.json"), "utf8"));
    const links = fs.readdirSync(s.opts.out, { recursive: true, withFileTypes: true }).filter(e => e.isSymbolicLink()).map(e => path.relative(s.opts.out, path.join(e.parentPath, e.name)));
    assert.deepEqual(links, ["corpus/realbugs/rb-js-demo-1/repo/labels"]);
    const files = [...walk(s.opts.out).filter(f => f !== "manifest.json"), ...links].sort();
    assert.deepEqual(manifest.files.map(f => f.path), files);
    for (const f of manifest.files) {
      // a link is hashed by its target path
      const p = path.join(s.opts.out, f.path);
      assert.equal(f.symlink === true, links.includes(f.path), f.path);
      const buf = f.symlink ? Buffer.from(fs.readlinkSync(p), "utf8") : fs.readFileSync(p);
      assert.equal(f.sha256, crypto.createHash("sha256").update(buf).digest("hex"), f.path);
      assert.equal(f.bytes, buf.length);
    }
    assert.match(manifest.corpus_commit, /^[0-9a-f]{40}$/);
    assert.match(manifest.bench_commit, /^[0-9a-f]{40}$/);
  } finally {
    s.cleanup();
  }
});

test("a leak fails the export and leaves no bundle: private id or answer text, denied string, token", () => {
  const leaks = [
    ["bench", "report/REPORT.md", `The hardest task was pager-js-T03.\n`, /pager-js-T03.*report\/REPORT\.md|report\/REPORT\.md.*pager-js-T03/],
    ["bench", "report/ARTICLE.md", `It found that ${SECRET}: the cursor wraps past the end.\n`, /ARTICLE\.md/],
    // the rest of a private answer key: a bug's trigger and false rebuttal, a decoy's explanation
    ["bench", "report/ARTICLE.md", "One reviewer was fooled when asked: ask for the page after the last one twice.\n", /ARTICLE\.md.*answer key/],
    ["bench", "report/ARTICLE.md", "It argued the wrap is intended for carousel views.\n", /ARTICLE\.md.*answer key/],
    ["bench", "report/ARTICLE.md", "Its reply: pages are one-based, so the exclusive bound is right.\n", /ARTICLE\.md.*answer key/],
    ["bench", "METHODOLOGY.md", "Contact person@example.invalid\n", /denied|person@example\.invalid/],
    // answer prose as a transcript stores it: JSON-escaped quotes and newlines, once or inside another JSON string
    ["runs", "final/A/high/codex/pager-js-T01/1/session/output.jsonl", `${JSON.stringify({ text: 'the bound is "exclusive" because\npages start at one' })}\n`, /output\.jsonl.*answer key/],
    ["runs", "final/A/high/codex/pager-js-T01/1/session/output.jsonl", `${JSON.stringify({ command: JSON.stringify({ text: 'the bound is "exclusive" because\npages start at one' }) })}\n`, /output\.jsonl.*answer key/],
    ["runs", "final/A/high/codex/pager-js-T01/1/session/auth.json", JSON.stringify({ refresh_token: "rt_0123456789abcdefghijklmnop" }), /token/],
    // a public task file that is a byte copy of a private task's answer file
    ["corpus", "tasks/pager-js/pager-js-T02/notes.txt", `fix for pager-js-T03: ${SECRET}: the cursor wraps past the end\n`, /pager-js-T03|private/],
  ];
  for (const [where, rel, text, why] of leaks) {
    const s = setup();
    try {
      write(s[where], rel, text);
      if (where !== "runs") {
        git(s[where], "add", "-A");
        git(s[where], "commit", "-qm", "leak");
      }
      assert.throws(() => exportBundle(s.opts), why, rel);
      assert.ok(!fs.existsSync(s.opts.out), `${rel}: a failed export leaves no bundle`);
      assert.deepEqual(fs.readdirSync(s.root).filter(n => n.startsWith("release")), [], rel);
    } finally {
      s.cleanup();
    }
  }
});

test("an existing output folder is refused, and the export needs a split", () => {
  const s = setup();
  try {
    fs.mkdirSync(s.opts.out);
    assert.throws(() => exportBundle(s.opts), /exists/);
    fs.rmSync(s.opts.out, { recursive: true });
    fs.rmSync(path.join(s.corpus, "splits.json"));
    assert.throws(() => exportBundle(s.opts), /splits\.json/);
  } finally {
    s.cleanup();
  }
});
