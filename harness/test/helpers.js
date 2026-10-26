// Shared setup for tests that drive the real pinned runner with cross-review's fake codex/claude/agy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pinnedRoot } from "../lib/paths.js";
import { loadTask } from "../lib/task.js";

export const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "corpus");
export const PINNED = pinnedRoot();
const helpers = path.join(PINNED, "tests", "helpers");
const { writeFakeCodex } = await import(path.join(helpers, "fake-codex.js"));
const { writeFakeClaude } = await import(path.join(helpers, "fake-claude.js"));
const { writeFakeAgy } = await import(path.join(helpers, "fake-agy.js"));

export const REVIEW = `### ISSUE-1: Page zero is accepted
- Category: logic
- Severity: medium
- Location: src/pager.js:6
- Problem: invented finding for the harness test
- Evidence: invented
- Why it matters: invented
- Suggested fix: invented

### VERDICT
- Status: REVISE
- Reason: invented
`;

/**
 * A temporary bench: fake CLIs on PATH, a fake real home with login files, the toy corpus committed
 * to git, and CRB_* pointing at temp dirs. `review` is what every fake reviewer answers.
 */
export function e2eSetup({ review = REVIEW } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crb-e2e-"));
  const d = name => { const p = path.join(root, name); fs.mkdirSync(p, { recursive: true }); return p; };
  const bin = d("bin");
  writeFakeCodex(bin);
  writeFakeClaude(bin);
  writeFakeAgy(bin);
  const real = d("realhome");
  fs.mkdirSync(path.join(real, ".codex"));
  fs.writeFileSync(path.join(real, ".codex/auth.json"), JSON.stringify({ last_refresh: "2026-10-01T00:00:00Z" }));
  fs.writeFileSync(path.join(real, ".claude.json"), JSON.stringify({ userID: "u", hasCompletedOnboarding: true }));
  fs.mkdirSync(path.join(real, "Library/Keychains"), { recursive: true });
  const corpus = d("corpus");
  fs.cpSync(FX, corpus, { recursive: true });
  const git = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], { cwd: corpus });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "corpus");
  const out = path.join(root, "review.md");
  fs.writeFileSync(out, review);
  const env = {
    CRB_HOME: d("crbhome"), CRB_RUN_ROOT: d("crw"), CRB_REAL_HOME: real, CRB_CORPUS: corpus, CRB_PINNED: PINNED, CRB_TEST: "1",
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FAKE_CODEX_OUTPUT: out, FAKE_CODEX_LOG: path.join(root, "codex.log"),
    FAKE_CLAUDE_OUTPUT: out, FAKE_CLAUDE_LOG: path.join(root, "claude.log"),
    FAKE_AGY_OUTPUT: out, FAKE_AGY_LOG: path.join(root, "agy.log"), FAKE_AGY_MODELS_FAIL: "1",
  };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const task = id => loadTask(path.join(corpus, "tasks/pager-js", id), { corpus });
  return {
    root, bin, env, corpus, task,
    tasks: ["pager-js-T01", "pager-js-T02", "pager-js-T03"].map(task),
    // review turns only: the harness's `<cli> --version` lookups (run.json cli_version) are left out
    log: name => fs.existsSync(path.join(root, `${name}.log`)) ? fs.readFileSync(path.join(root, `${name}.log`), "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(c => !(c.args?.length === 1 && c.args[0] === "--version")) : [],
    restore() {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A finished Track A run archive for grading tests: run.json, round1/wait.json (and round2/ for a
 * Track B round). blocks are ISSUE blocks ({ id, title, location, … }); log: round 1's event log lines
 * (round1/session/output.jsonl).
 */
export function fakeRun({ set = "smoke", reviewer, task, repo = "pager-js", kind, n = 1, config = "high", blocks = [], verdict = "REVISE", cls = "ok", trackB = null, round2 = null, log = null, workspace = "/tmp/crw/0000aaaa/pager-js" }) {
  const id = `${set}/A/${config}/${reviewer}/${task}/${n}`;
  const dir = path.join(process.env.CRB_HOME, "runs", id);
  const wait = blocks => ({ status: "completed", review: { format: "review", blocks: blocks.map(b => ({ prefix: "ISSUE", category: "bug", severity: "medium", problem: "p", evidence: "e", suggested_fix: "s", ...b })), verdict: verdict ? { status: verdict } : null } });
  fs.mkdirSync(path.join(dir, "round1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "round1", "wait.json"), JSON.stringify(wait(blocks)));
  fs.writeFileSync(path.join(dir, "wait.json"), JSON.stringify(wait(blocks)));
  if (log) {
    fs.mkdirSync(path.join(dir, "round1", "session"), { recursive: true });
    fs.writeFileSync(path.join(dir, "round1", "session", "output.jsonl"), log.map(l => JSON.stringify(l)).join("\n") + "\n");
  }
  if (round2) {
    fs.mkdirSync(path.join(dir, "round2"), { recursive: true });
    fs.writeFileSync(path.join(dir, "round2", "wait.json"), JSON.stringify(wait(round2)));
  }
  const record = {
    id, set, track: "A", config, reviewer, model: `${reviewer}-model`, effort: "high", task, repo, kind, n,
    final: true, class: cls, verdict: cls === "ok" ? verdict : null, issues: blocks.length, workspace, wall_s: 10,
    ...(trackB ? { track_b: trackB } : {}),
  };
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(record));
  return record;
}
