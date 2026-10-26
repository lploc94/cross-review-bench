// Track C with fake orchestrators: the fake claude/codex play the orchestrator by running the
// installed cross-review runner (begin/wait/end) and applying a fix, then print their usual turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planLoops, runTrackC, cellConfig, loopPrompt, classifyLoop, testWorkspace, readSessions, spawnOrchestrator } from "../lib/trackc.js";
import { runBatch, decide } from "../lib/scheduler.js";
import { listRuns, archive, runPath, addPlanned } from "../lib/store.js";
import { e2eSetup } from "./helpers.js";
import { infraReason as infraReasonOf } from "../lib/failures.js";

const QUICK = { infraDelayMs: 10, usageBaseMs: 10, usageMaxMs: 40, infraRetries: 3, reviewerRetries: 1 };

/**
 * Wrap the fake `claude` and `codex`: called as an orchestrator (no CROSS_REVIEW_REVIEWER, a turn
 * rather than `mcp …`), log what it got, run review-impl through the installed runner when the
 * prompt asks for it, apply FAKE_ORCH_PATCH, sleep FAKE_ORCH_SLEEP_MS; then hand over to the fake.
 */
function wrapOrchestrators(ctx) {
  const real = path.join(ctx.root, "realbin");
  fs.mkdirSync(real, { recursive: true });
  for (const name of ["claude", "codex"]) {
    fs.renameSync(path.join(ctx.bin, name), path.join(real, name));
    fs.writeFileSync(path.join(ctx.bin, name), `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const turn = ${name === "claude" ? 'args.includes("-p")' : 'args[0] === "exec"'};
if (turn && !process.env.CROSS_REVIEW_REVIEWER) {
  const home = process.env.HOME;
  let config = null;
  try { config = JSON.parse(fs.readFileSync(path.join(home, ".cross-review", "config.json"), "utf8")); } catch {}
  fs.appendFileSync(process.env.FAKE_ORCH_LOG, JSON.stringify({ name: ${JSON.stringify(name)}, args, prompt, cwd: process.cwd(), reviewerEnv: process.env.CROSS_REVIEW_REVIEWER ?? null, probe: process.env.CRB_PROBE ?? null, config }) + "\\n");
  if (/review-impl/.test(prompt)) {
    const runner = path.join(home, ".claude", "skills", "cross-review", "scripts", "review-runner.js");
    const fmt = fs.readFileSync(path.join(home, ".claude", "skills", "review-impl", "references", "output-format.md"), "utf8").match(/\`\`\`(?:markdown)?\\n([\\s\\S]*?)\`\`\`/)[1];
    const run = (a, input) => JSON.parse(cp.execFileSync(process.execPath, [runner, ...a], { input, encoding: "utf8" }));
    // a slow reviewer for this review only (the installer's \`codex mcp add\` runs the same fake codex)
    if (process.env.FAKE_ORCH_REVIEW_SLOW_MS) process.env.FAKE_CODEX_SLOW_MS = process.env.FAKE_ORCH_REVIEW_SLOW_MS;
    const b = run(["begin", "--skill", "review-impl", "--mode", "working-tree", "--input", "-", "--working-dir", process.cwd()], "## USER_REQUEST\\nthe PR\\n\\n## OUTPUT_FORMAT\\n" + fmt);
    if (process.env.FAKE_ORCH_NOWAIT) {
      // walk away from a review still running: record its reviewer's pid
      const st = JSON.parse(fs.readFileSync(path.join(b.session_dir, "state.json"), "utf8"));
      delete process.env.FAKE_CODEX_SLOW_MS;
      fs.appendFileSync(process.env.FAKE_ORCH_LOG, JSON.stringify({ left: b.session_dir, pid: st.pid, watchdog: st.watchdog_pid }) + "\\n");
    } else {
      let w;
      do { w = run(["wait", b.session_dir, "--max-wait", "5"]); } while (w.next === "running");
      run(["end", b.session_dir]);
    }
  }
  if (process.env.FAKE_ORCH_PATCH) cp.execFileSync("git", ["apply", process.env.FAKE_ORCH_PATCH], { cwd: process.cwd() });
  const ms = Number(process.env.FAKE_ORCH_SLEEP_MS || 0);
  if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const r = cp.spawnSync(${JSON.stringify(path.join(real, name))}, args, { input: prompt, stdio: ["pipe", "inherit", "inherit"] });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
  }
  const log = path.join(ctx.root, "orch.log");
  process.env.FAKE_ORCH_LOG = log;
  return () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);
}

function probeTask(ctx) {
  // the visible and hidden test commands record which hidden files exist while they run
  const dir = path.join(ctx.corpus, "tasks/pager-js/pager-js-T01");
  const t = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
  t.visible_test_cmd = 'ls test/hidden > "$CRB_PROBE/visible.txt" 2>/dev/null; node --test "test/*.test.js"';
  for (const b of t.bugs) b.hidden_test_cmd = `ls test/hidden > "$CRB_PROBE/${b.id}.txt"; ${b.hidden_test_cmd}`;
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(t, null, 2));
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qam", "probe"], { cwd: ctx.corpus });
  return ctx.task("pager-js-T01");
}

const probeDir = ctx => { const p = path.join(ctx.root, `probe-${Math.random().toString(16).slice(2)}`); fs.mkdirSync(p); return p; };
const readProbe = (dir, name) => fs.readFileSync(path.join(dir, `${name}.txt`), "utf8").trim().split("\n").filter(Boolean);

test("loops are task × orchestrator × cell; cells get their reviewer's high settings; prompts per client", () => {
  const task = { id: "toy-T01", repo: "toy", kind: "buggy", description: "  Add pageCount.  " };
  const loops = planLoops({ set: "smoke", tasks: [task], orchestrators: ["claude", "codex"], cells: ["codex", "none"] });
  assert.deepEqual(loops.map(l => [l.id, l.queue, l.model, l.effort]), [
    ["smoke/C/high/claude-codex/toy-T01/1", "claude", "claude-opus-5-5", "high"],
    ["smoke/C/high/claude-none/toy-T01/1", "claude", "claude-opus-5-5", "high"],
    ["smoke/C/high/codex-codex/toy-T01/1", "codex", "gpt-6-astra", "high"],
    ["smoke/C/high/codex-none/toy-T01/1", "codex", "gpt-6-astra", "high"],
  ]);
  assert.throws(() => planLoops({ set: "smoke", tasks: [{ ...task, kind: "clean" }], orchestrators: ["claude"], cells: ["none"] }), /buggy/);
  assert.throws(() => planLoops({ set: "smoke", tasks: [task], orchestrators: ["agy"], cells: ["none"] }), /orchestrator/);
  assert.throws(() => planLoops({ set: "smoke", tasks: [task], orchestrators: ["claude"], cells: ["gpt"] }), /cell/);
  assert.deepEqual(cellConfig("agy"), { reviewer: "agy", reviewers: { agy: { model: "gemini-4-argon", effort: "high" } } });
  assert.deepEqual(cellConfig("claude"), { reviewer: "claude", reviewers: { claude: { model: "claude-opus-5-5", effort: "high" } } });
  assert.equal(cellConfig("none"), null);
  assert.match(loopPrompt(task, "claude", "codex"), /^The working tree has an uncommitted change implementing: Add pageCount\.\n\nRun the \/review-impl skill/);
  assert.match(loopPrompt(task, "codex", "agy"), /Run the \$review-impl skill .* Do not commit\./);
  assert.match(loopPrompt(task, "codex", "none"), /Review the uncommitted change yourself .* Do not commit\./);
  assert.doesNotMatch(loopPrompt(task, "codex", "none"), /review-impl/);
});

test("a loop's class: reviewer infra first, then the deadline, then the orchestrator's turn", () => {
  const done = { turnCompleted: true, turnFailed: false, lines: 5 };
  const ok = { code: 0, timedOut: false };
  assert.deepEqual(classifyLoop({ spawnRes: ok, events: done, sessions: [] }), { class: "ok", reason: "completed" });
  assert.equal(classifyLoop({ spawnRes: { code: 127 }, events: { lines: 0 }, sessions: [] }).reason, "orchestrator_not_found");
  assert.equal(classifyLoop({ spawnRes: { code: null, timedOut: true }, events: { lines: 3 }, sessions: [] }).class, "reviewer_timeout");
  assert.deepEqual(classifyLoop({ spawnRes: ok, events: done, sessions: [{ reviewer: "agy", infra: "usage_limit" }] }), { class: "infra", reason: "usage_limit", source: "agy review" });
  assert.equal(classifyLoop({ spawnRes: { code: 1 }, events: { turnFailed: true, failMessage: "401 Unauthorized", lines: 2 }, sessions: [] }).reason, "auth");
  assert.equal(classifyLoop({ spawnRes: { code: 1 }, events: { turnFailed: true, failMessage: "boom", lines: 2 }, sessions: [] }).reason, "orchestrator_failed");
  // a completed turn whose text mentions rate limits is still a completed turn
  assert.equal(classifyLoop({ spawnRes: ok, events: { ...done, failMessage: null }, sessions: [], stderr: "429 too many requests" }).class, "ok");
});

test("a session's failed or unstarted turn is reviewer infra, read from error.log, final.txt or an archived final; a timeout or stall is not", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "crb-rs-"));
  try {
    const session = (name, statuses, files = {}) => {
      const sd = path.join(ws, ".cross-review", "sessions", name);
      fs.mkdirSync(path.join(sd, "outputs"), { recursive: true });
      fs.writeFileSync(path.join(sd, "state.json"), JSON.stringify({ skill_name: "review-impl", reviewer: "agy" }));
      if (statuses) fs.writeFileSync(path.join(sd, "rounds.json"), JSON.stringify(statuses.map((status, i) => ({ round: i + 1, status }))));
      for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(sd, f), text);
    };
    session("a-final", ["failed"], { "final.txt": JSON.stringify({ status: "failed", error: "You have hit your usage limit. Try again later." }) });
    session("b-archived", ["failed", "completed"], { "outputs/final-round-001.json": JSON.stringify({ error: "401 Unauthorized" }) });
    session("c-plain", ["start_failed"], { "error.log": "spawn went wrong\n" });
    session("d-none", null);
    session("e-timeout", ["timeout"], { "error.log": "429 too many requests\n" });
    session("f-stalled", ["stalled"], { "error.log": "ECONNRESET\n" });
    session("g-ok", ["completed", "running"]);
    const got = Object.fromEntries(readSessions(ws).map(s => [s.name, s.infra]));
    assert.equal(got["a-final"], infraReasonOf("You have hit your usage limit. Try again later."));
    assert.ok(got["a-final"]);
    assert.equal(got["b-archived"], "auth");
    assert.equal(got["c-plain"], "reviewer_failed");
    assert.equal(got["d-none"], "reviewer_failed", "a session whose first turn never started");
    assert.deepEqual([got["e-timeout"], got["f-stalled"], got["g-ok"]], [null, null, null]);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("testWorkspace: visible tests with no hidden file, each bug's hidden tests alone, an orchestrator's file at that path kept", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crb-tw-"));
  try {
    const ws = path.join(root, "ws");
    const tdir = path.join(root, "task");
    fs.mkdirSync(path.join(ws, "t"), { recursive: true });
    fs.mkdirSync(path.join(tdir, "hidden", "t"), { recursive: true });
    fs.writeFileSync(path.join(tdir, "hidden", "t", "a.sh"), "exit 0\n");
    fs.writeFileSync(path.join(tdir, "hidden", "t", "b.sh"), "exit 1\n");
    fs.writeFileSync(path.join(ws, "t", "b.sh"), "orchestrator's own\n");
    const probe = path.join(root, "probe");
    fs.mkdirSync(probe);
    const task = {
      dir: tdir, visible_test_cmd: 'ls t > "$P/visible.txt"; exit 3', repoConfig: { test_cmd: "true" },
      bugs: [
        { id: "B2", testable: true, hidden_tests: ["t/b.sh"], hidden_test_cmd: 'ls t > "$P/B2.txt"; sh t/b.sh' },
        { id: "B1", testable: true, hidden_tests: ["t/a.sh"], hidden_test_cmd: 'ls t > "$P/B1.txt"; sh t/a.sh' },
        { id: "B3", testable: false, justification: "invented" },
      ],
    };
    const r = await testWorkspace(task, ws, { P: probe });
    assert.equal(r.visible_ok, false, "a failing visible suite is a regression");
    assert.deepEqual(r.bugs.map(b => [b.id, b.fixed]), [["B1", true], ["B2", false], ["B3", null]]);
    assert.deepEqual([r.bugs_fixed, r.bugs_testable], [["B1"], 2]);
    assert.deepEqual(readProbe(probe, "visible"), ["b.sh"]);
    assert.deepEqual(readProbe(probe, "B1"), ["a.sh", "b.sh"]);
    assert.deepEqual(readProbe(probe, "B2"), ["b.sh"]);
    assert.ok(!fs.existsSync(path.join(ws, "t", "a.sh")));
    assert.equal(fs.readFileSync(path.join(ws, "t", "b.sh"), "utf8"), "orchestrator's own\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Track C loops end to end with fake orchestrators: cell config, clean env, tests after the loop, results", { timeout: 600_000 }, async () => {
  const ctx = e2eSetup();
  const orchLog = wrapOrchestrators(ctx);
  try {
    const task = probeTask(ctx);
    process.env.FAKE_ORCH_PATCH = path.join(task.dir, "fix-B1.patch");
    const probes = {};
    const loops = planLoops({ set: "smoke", tasks: [task], orchestrators: ["claude", "codex"], cells: ["codex", "none"] });
    const s = await runBatch(loops, {
      minFreeBytes: 0, retry: QUICK,
      execute: (spec, counters) => {
        probes[spec.reviewer] = probeDir(ctx);
        // CROSS_REVIEW_REVIEWER in the run environment must not reach the orchestrator (F19)
        return runTrackC(spec, counters, { decisionFor: r => decide(r, counters, QUICK), extraEnv: { CRB_PROBE: probes[spec.reviewer], CROSS_REVIEW_REVIEWER: "codex" } });
      },
    });
    assert.deepEqual([s.planned, s.done, s.infra_failures, s.flagged], [4, 4, 0, 0]);

    const runs = Object.fromEntries(listRuns("smoke").map(r => [r.reviewer, r]));
    for (const [key, r] of Object.entries(runs)) {
      const review = key.endsWith("-codex");
      assert.deepEqual([r.track, r.class, r.final, r.turn_completed], ["C", "ok", true, true], key);
      assert.deepEqual([r.bugs_fixed, r.bugs_testable, r.visible_ok], [["B1"], 2, true], key);
      assert.deepEqual([r.sessions, r.review_rounds, r.reviewers_used], review ? [1, 1, ["codex"]] : [0, 0, []], key);
      assert.ok(Number.isInteger(r.wall_s) && r.wall_s >= 0);
      // the fake CLIs do not record MCP servers; the real smoke shows both registered
      assert.deepEqual(r.install, { skills: true, claude_mcp: false, codex_mcp: false }, key);
      for (const f of ["run.json", "audit.json", "tests.json", "sessions.json", "prompt.md", "orchestrator.jsonl", "workspace.diff"]) assert.ok(fs.existsSync(path.join(r.archive, f)), `${key} ${f}`);
      assert.ok(r.cli_version && r.orchestrator in r.cli_version, `${key} cli_version ${JSON.stringify(r.cli_version)}`);
      if (r.cell === "agy") assert.equal(r.cli_version.agy, "9.9.9", key);
      assert.match(fs.readFileSync(path.join(r.archive, "workspace.diff"), "utf8"), /page < 1\)/);
      assert.equal(fs.existsSync(path.join(r.archive, "sessions")), review, key);
      // visible tests first, with no hidden file; each bug's hidden test only during its own check
      assert.deepEqual(readProbe(probes[key], "visible"), [], key);
      assert.deepEqual(readProbe(probes[key], "B1"), ["page-zero.test.js"], key);
      assert.deepEqual(readProbe(probes[key], "B2"), ["page-count.test.js"], key);
    }

    const calls = orchLog();
    assert.equal(calls.length, 4);
    for (const c of calls) {
      assert.equal(c.reviewerEnv, null, "the orchestrator never inherits CROSS_REVIEW_REVIEWER");
      const cell = /review-impl/.test(c.prompt) ? "codex" : "none";
      assert.deepEqual(c.config, cellConfig(cell), `${c.name} ${cell}`);
      assert.match(c.cwd, /\/pager-js$/);
    }
    const claudeCalls = calls.filter(c => c.name === "claude");
    assert.ok(claudeCalls.every(c => ["--dangerously-skip-permissions", "--model", "claude-opus-5-5", "--effort", "high"].every(a => c.args.includes(a))), JSON.stringify(claudeCalls[0].args));
    assert.ok(claudeCalls.some(c => c.prompt.includes("/review-impl")));
    const codexCalls = calls.filter(c => c.name === "codex");
    assert.ok(codexCalls.every(c => c.args[0] === "exec" && c.args.join(" ").includes("--sandbox danger-full-access") && c.args.includes("gpt-6-astra")), JSON.stringify(codexCalls[0].args));
    assert.ok(codexCalls.some(c => c.prompt.includes("$review-impl")));
    // the cell's reviewer ran with its F5 settings, as a reviewer
    const reviews = ctx.log("codex").filter(c => c.reviewerEnv === "codex");
    assert.equal(reviews.length, 2);
    assert.ok(reviews.every(c => c.args.includes("gpt-6-astra") && c.args.join(" ").includes("model_reasoning_effort=high")));
    assert.deepEqual(fs.readdirSync(ctx.env.CRB_RUN_ROOT), []);
  } finally {
    delete process.env.FAKE_ORCH_PATCH;
    delete process.env.FAKE_ORCH_LOG;
    ctx.restore();
  }
});

test("a loop past its deadline is a reviewer_timeout; its workspace is still tested", { timeout: 300_000 }, async () => {
  const ctx = e2eSetup();
  wrapOrchestrators(ctx);
  try {
    process.env.FAKE_ORCH_SLEEP_MS = "30000";
    const [spec] = planLoops({ set: "smoke", tasks: [ctx.task("pager-js-T01")], orchestrators: ["claude"], cells: ["none"] });
    const t0 = Date.now();
    const out = await runTrackC(spec, { flags: 0, infra: 0, reviewer: 0, usage: 0 }, { timeoutS: 2, decisionFor: () => "final" });
    assert.ok(Date.now() - t0 < 25_000, "the orchestrator's process group was killed at the deadline");
    assert.deepEqual([out.result.class, out.result.reason, out.record.timed_out], ["reviewer_timeout", "loop_deadline", true]);
    assert.deepEqual([out.record.visible_ok, out.record.bugs_fixed], [true, []]);
  } finally {
    delete process.env.FAKE_ORCH_SLEEP_MS;
    delete process.env.FAKE_ORCH_LOG;
    ctx.restore();
  }
});

test("a review the orchestrator leaves running is stopped when the loop ends: no reviewer outlives it", { timeout: 300_000 }, async () => {
  const ctx = e2eSetup();
  const orchLog = wrapOrchestrators(ctx);
  try {
    process.env.FAKE_ORCH_NOWAIT = "1";
    process.env.FAKE_ORCH_REVIEW_SLOW_MS = "120000";
    const [spec] = planLoops({ set: "smoke", tasks: [ctx.task("pager-js-T01")], orchestrators: ["claude"], cells: ["codex"] });
    const out = await runTrackC(spec, { flags: 0, infra: 0, reviewer: 0, usage: 0 }, { decisionFor: () => "final" });
    const left = orchLog().find(l => l.left);
    assert.ok(left?.pid, "the fake orchestrator left a running review");
    assert.deepEqual([out.result.class, out.record.sessions], ["ok", 1], "a review left running is not an infra fault");
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && (alive(left.pid) || alive(left.watchdog)); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(!alive(left.pid), "reviewer stopped");
    assert.ok(!left.watchdog || !alive(left.watchdog), "watchdog stopped");
    const [sess] = JSON.parse(fs.readFileSync(path.join(listRuns("smoke")[0].archive, "sessions.json"), "utf8"));
    assert.deepEqual(sess.statuses, ["running"], "the statuses as the orchestrator left them");
  } finally {
    delete process.env.FAKE_ORCH_NOWAIT;
    delete process.env.FAKE_ORCH_REVIEW_SLOW_MS;
    delete process.env.FAKE_ORCH_LOG;
    ctx.restore();
  }
});

test("crb trackc and crb status --track C from the command line; status counts infra_exhausted runs", { timeout: 300_000 }, async () => {
  const ctx = e2eSetup();
  wrapOrchestrators(ctx);
  try {
    const crb = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "crb.js");
    const { NODE_TEST_CONTEXT, ...rest } = process.env;
    const call = args => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [crb, ...args], { env: { ...rest, CRB_MIN_FREE_BYTES: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e) {
        return { code: e.status, out: e.stdout, err: e.stderr };
      }
    };
    const mixed = call(["trackc", "--set", "smoke", "--tasks", "pager-js/*", "--orchestrators", "claude", "--cells", "none", "--dry-run"]);
    assert.equal(mixed.code, 2, "pager-js/* includes clean and decoy tasks: refused");
    assert.match(mixed.err, /buggy tasks only/);
    const dry = JSON.parse(call(["trackc", "--set", "smoke", "--tasks", "pager-js/pager-js-T01", "--dry-run"]).out);
    assert.equal(dry.planned, 8, "both orchestrators × four cells by default");
    const r = call(["trackc", "--set", "smoke", "--tasks", "pager-js/pager-js-T01", "--orchestrators", "codex", "--cells", "none"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([JSON.parse(r.out).planned, JSON.parse(r.out).done], [1, 1]);
    const st = call(["status", "--set", "smoke", "--track", "C", "--complete"]);
    assert.equal(st.code, 0, st.out);
    assert.deepEqual(JSON.parse(st.out).counts, { "C/high/codex-none": { ok: 1 } });
    assert.equal(call(["status", "--set", "smoke", "--track", "A", "--complete"]).code, 1);

    // crb audit re-reads a loop's archive: the orchestrator's own log in its format
    const au = call(["audit", "--set", "smoke", "--all"]);
    assert.equal(au.code, 0, au.out);
    const [loop] = listRuns("smoke");
    fs.appendFileSync(path.join(loop.archive, "orchestrator.jsonl"), JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "cat /Users/someone-else/notes.txt" } }) + "\n");
    const au2 = call(["audit", "--set", "smoke", "--all"]);
    assert.equal(au2.code, 1);
    assert.deepEqual(JSON.parse(au2.out).runs.map(x => [x.id, x.hits[0].reason]), [[loop.id, "user_data"]]);

    // a run given up after its infra retries is listed, and the set is not complete
    const id = "smoke/C/high/claude-none/pager-js-T01/1";
    addPlanned("smoke", [id]);
    archive(runPath(id), { files: { "run.json": JSON.stringify({ id, track: "C", config: "high", reviewer: "claude-none", class: "infra", decision: "infra_exhausted", final: false }) } });
    const ex = call(["status", "--set", "smoke", "--track", "C", "--complete"]);
    assert.equal(ex.code, 1);
    assert.deepEqual([JSON.parse(ex.out).infra_exhausted, JSON.parse(ex.out).infra_exhausted_ids], [1, [id]]);
  } finally {
    delete process.env.FAKE_ORCH_LOG;
    ctx.restore();
  }
});

test("the orchestrator's whole process group is gone before spawnOrchestrator returns: on a timeout and after a normal exit", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crb-teardown-"));
  const saved = process.env.CRB_PINNED;
  try {
    const pinned = path.join(root, "pinned");
    const lib = path.join(pinned, "skill-packs/cross-review/scripts/lib/reviewers");
    fs.mkdirSync(lib, { recursive: true });
    // a child that ignores SIGTERM and keeps writing: a tool the orchestrator left behind
    fs.writeFileSync(path.join(root, "child.cjs"), `const fs = require("fs");
process.on("SIGTERM", () => {});
setInterval(() => fs.appendFileSync(process.env.PROBE, "x"), 50);`);
    fs.writeFileSync(path.join(root, "parent.cjs"), `const cp = require("child_process");
cp.spawn(process.execPath, [process.env.CHILD], { stdio: "ignore" });
if (process.env.STAY) setInterval(() => {}, 1000); else setTimeout(() => process.exit(0), 200);`);
    fs.writeFileSync(path.join(lib, "codex.js"), `export const fullAccessSandbox = "fake";
export const buildCommand = () => ({ cmd: process.execPath, args: [${JSON.stringify(path.join(root, "parent.cjs"))}] });`);
    process.env.CRB_PINNED = pinned;
    for (const stay of [true, false]) {
      const probe = path.join(root, `probe-${stay}`);
      const env = { ...process.env, CHILD: path.join(root, "child.cjs"), PROBE: probe, ...(stay ? { STAY: "1" } : {}) };
      const res = await spawnOrchestrator("codex", root, "", { env, timeoutMs: stay ? 600 : 30_000, killGraceMs: 300, logFile: path.join(root, "out"), errFile: path.join(root, "err") });
      assert.equal(res.timedOut, stay);
      const size = fs.existsSync(probe) ? fs.statSync(probe).size : 0;
      await new Promise(r => setTimeout(r, 400));
      assert.equal(fs.existsSync(probe) ? fs.statSync(probe).size : 0, size, `stay=${stay}: a descendant still writes after the return`);
    }
  } finally {
    if (saved === undefined) delete process.env.CRB_PINNED; else process.env.CRB_PINNED = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
