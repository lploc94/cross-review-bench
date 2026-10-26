import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBatch, decide, planRuns, selectTaskDirs, upstreamFragments, defaultHold } from "../lib/scheduler.js";
import { archive, runPath, flaggedPath } from "../lib/store.js";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "corpus");
const RETRY = { infraRetries: 3, reviewerRetries: 1, infraDelayMs: 1000, usageBaseMs: 30 * 60_000, usageMaxMs: 4 * 3_600_000 };

function withCrbHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-home-"));
  const saved = process.env.CRB_HOME;
  process.env.CRB_HOME = dir;
  return Promise.resolve().then(fn).finally(() => {
    if (saved === undefined) delete process.env.CRB_HOME; else process.env.CRB_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

/** A fake clock: sleep advances it without waiting. */
function clock() {
  let t = 1_000_000;
  const sleeps = [];
  return { now: () => t, sleep: async ms => { sleeps.push(ms); t += ms; await new Promise(r => setImmediate(r)); }, sleeps };
}

const tasks = n => Array.from({ length: n }, (_, i) => ({ id: `toy-T0${i + 1}`, repo: "toy", kind: "buggy" }));

/** Executor that records itself and records the final result like executeRun does. */
function fakeExecutor(script = () => ({ class: "ok", reason: "revise" }), { delayMs = 5 } = {}) {
  const calls = [];
  const active = {};
  const peak = {};
  const execute = async (spec, counters) => {
    calls.push({ id: spec.id, counters });
    active[spec.reviewer] = (active[spec.reviewer] ?? 0) + 1;
    peak[spec.reviewer] = Math.max(peak[spec.reviewer] ?? 0, active[spec.reviewer]);
    await new Promise(r => setTimeout(r, delayMs + Math.random() * delayMs));
    active[spec.reviewer]--;
    const result = { flagged: false, ...script(spec, counters) };
    const decision = decide(result, counters, RETRY);
    if (decision === "final" || decision === "contaminated") {
      archive(runPath(spec.id), { files: { "run.json": JSON.stringify({ id: spec.id, final: true, class: result.class }) } });
    }
    return { result, decision };
  };
  return { execute, calls, peak };
}

test("the run list covers tasks × reviewers × n with F5 settings; max has no agy row", () => {
  const high = planRuns({ set: "smoke", config: "high", reviewers: ["codex", "claude", "agy"], tasks: tasks(2), n: 3 });
  assert.equal(high.length, 18);
  assert.equal(high[0].id, "smoke/A/high/codex/toy-T01/1");
  assert.deepEqual([...new Set(high.map(r => `${r.reviewer}:${r.model}:${r.effort}`))].sort(), ["agy:gemini-4-argon:high", "claude:claude-opus-5-5:high", "codex:gpt-6-astra:high"]);
  const max = planRuns({ set: "smoke", config: "max", reviewers: ["codex", "claude", "agy"], tasks: tasks(1), n: 1 });
  assert.deepEqual(max.map(r => `${r.reviewer}:${r.effort}`), ["codex:max", "claude:max"]);
  const cal = planRuns({ set: "calibration", config: "high", reviewers: ["claude"], tasks: tasks(1), n: 1, models: { claude: "claude-sonnet-5-5" } });
  assert.equal(cal[0].model, "claude-sonnet-5-5");
  assert.throws(() => planRuns({ set: "nope", config: "high", reviewers: ["codex"], tasks: tasks(1), n: 1 }), /set/);
});

test("decide follows the retry rules", () => {
  const c = (o = {}) => ({ flags: 0, infra: 0, reviewer: 0, usage: 0, ...o });
  assert.equal(decide({ class: "ok" }, c(), RETRY), "final");
  assert.equal(decide({ class: "reviewer_malformed" }, c(), RETRY), "final");
  assert.equal(decide({ class: "reviewer_timeout" }, c(), RETRY), "retry_reviewer");
  assert.equal(decide({ class: "reviewer_stall" }, c({ reviewer: 1 }), RETRY), "final");
  assert.equal(decide({ class: "infra", reason: "usage_limit" }, c({ infra: 3, usage: 9 }), RETRY), "retry_usage");
  assert.equal(decide({ class: "infra", reason: "network" }, c({ infra: 2 }), RETRY), "retry_infra");
  assert.equal(decide({ class: "infra", reason: "network" }, c({ infra: 3 }), RETRY), "infra_exhausted");
  assert.equal(decide({ class: "ok", flagged: true }, c(), RETRY), "requeue_flagged");
  assert.equal(decide({ class: "ok", flagged: true }, c({ flags: 1 }), RETRY), "contaminated");
});

test("per-reviewer concurrency never exceeds its limit and every run finishes once", () => withCrbHome(async () => {
  const runs = planRuns({ set: "smoke", config: "high", reviewers: ["codex", "claude", "agy"], tasks: tasks(4), n: 3 });
  const ex = fakeExecutor();
  const s = await runBatch(runs, { execute: ex.execute, concurrency: { codex: 3, claude: 2, agy: 1 }, retry: RETRY, minFreeBytes: 0 });
  assert.equal(s.done, 36);
  assert.equal(ex.calls.length, 36);
  assert.ok(ex.peak.codex <= 3 && ex.peak.claude <= 2 && ex.peak.agy <= 1, JSON.stringify(ex.peak));
  assert.ok(ex.peak.codex >= 2, "workers run in parallel");
}));

test("finished runs of the set are skipped; another set runs again", () => withCrbHome(async () => {
  const runs = planRuns({ set: "smoke", config: "high", reviewers: ["codex"], tasks: tasks(2), n: 2 });
  await runBatch(runs, { execute: fakeExecutor().execute, retry: RETRY, minFreeBytes: 0 });
  const again = fakeExecutor();
  const s = await runBatch(runs, { execute: again.execute, retry: RETRY, minFreeBytes: 0 });
  assert.deepEqual([s.skipped, s.done, again.calls.length], [4, 0, 0]);
  const other = planRuns({ set: "pilot", config: "high", reviewers: ["codex"], tasks: tasks(2), n: 2 });
  const s2 = await runBatch(other, { execute: fakeExecutor().execute, retry: RETRY, minFreeBytes: 0 });
  assert.deepEqual([s2.skipped, s2.done], [0, 4]);
}));

test("a usage limit pauses only that reviewer, retries, and is never a reviewer failure", () => withCrbHome(async () => {
  const runs = planRuns({ set: "smoke", config: "high", reviewers: ["codex", "claude"], tasks: tasks(2), n: 1 });
  let limited = 2;
  const ex = fakeExecutor(spec => (spec.reviewer === "codex" && limited-- > 0 ? { class: "infra", reason: "usage_limit" } : { class: "ok", reason: "revise" }));
  const clk = clock();
  const s = await runBatch(runs, { execute: ex.execute, retry: RETRY, sleep: clk.sleep, now: clk.now, concurrency: { codex: 1, claude: 1 }, minFreeBytes: 0 });
  assert.equal(s.done, 4);
  assert.equal(s.reviewer_failures, 0);
  assert.equal(s.infra_exhausted, 0);
  assert.equal(s.infra_failures, 2);
  // 30 min, then doubled to 60 min
  assert.deepEqual(clk.sleeps.filter(ms => ms >= RETRY.usageBaseMs), [RETRY.usageBaseMs, 2 * RETRY.usageBaseMs]);
}));

test("a flagged attempt archived by an earlier batch counts: the run's next flag makes it contaminated", () => withCrbHome(async () => {
  const runs = planRuns({ set: "smoke", config: "high", reviewers: ["codex"], tasks: tasks(2), n: 1 });
  // a batch that stopped (or a re-audit) left one flagged attempt of the first run
  archive(flaggedPath(runs[0].id, "deadbeef"), { files: { "run.json": JSON.stringify({ id: runs[0].id, decision: "requeue_flagged" }) } });
  const ex = fakeExecutor(() => ({ class: "ok", reason: "revise", flagged: true }));
  const s = await runBatch(runs, { execute: ex.execute, retry: RETRY, sleep: async () => {}, concurrency: { codex: 1 }, minFreeBytes: 0 });
  assert.deepEqual(ex.calls.map(c => [c.id, c.counters.flags]), [[runs[0].id, 1], [runs[1].id, 0], [runs[1].id, 1]]);
  assert.deepEqual([s.done, s.contaminated, s.flagged], [2, 2, 3]);
}));

test("while the batch is held no new run starts; runs in flight finish; it resumes when the hold ends", () => withCrbHome(async () => {
  const runs = planRuns({ set: "smoke", config: "high", reviewers: ["codex", "claude"], tasks: tasks(2), n: 2 });
  const clk = clock();
  let held = true;
  const started = [];
  const ex = fakeExecutor();
  const execute = async (spec, counters) => {
    started.push({ id: spec.id, held });
    return ex.execute(spec, counters);
  };
  const events = [];
  let checks = 0;
  // held for the first 3 checks, free for 2, then held again for 2 more
  const hold = () => {
    checks++;
    held = checks <= 3 || (checks > 5 && checks <= 7);
    return held ? "pause file" : null;
  };
  const s = await runBatch(runs, { execute, hold, holdPollMs: 60_000, retry: RETRY, sleep: clk.sleep, now: clk.now, concurrency: { codex: 1, claude: 1 }, minFreeBytes: 0, onEvent: e => events.push(e) });
  assert.equal(s.done, 8);
  assert.ok(started.every(x => x.held === false), JSON.stringify(started));
  assert.ok(clk.sleeps.filter(ms => ms === 60_000).length >= 3, JSON.stringify(clk.sleeps));
  // one hold event per hold, naming the reason, and one resume
  assert.deepEqual(events.filter(e => e.type === "hold" || e.type === "resume").map(e => `${e.type}:${e.reason ?? ""}`).slice(0, 2), ["hold:pause file", "resume:"]);
}));

test("the default hold: a pause file in the bench home, or a running process named by CRB_YIELD_TO", () => withCrbHome(async () => {
  const saved = process.env.CRB_YIELD_TO;
  try {
    delete process.env.CRB_YIELD_TO;
    assert.equal(defaultHold(), null);
    fs.writeFileSync(path.join(process.env.CRB_HOME, "pause"), "");
    assert.match(defaultHold(), /pause/);
    fs.rmSync(path.join(process.env.CRB_HOME, "pause"));
    process.env.CRB_YIELD_TO = "no-such-process-crb-test-7f3a";
    assert.equal(defaultHold(), null);
    // another process whose command line carries the pattern
    const marker = `crb-hold-probe-${process.pid}`;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", marker], { stdio: "ignore" });
    try {
      process.env.CRB_YIELD_TO = marker;
      assert.match(defaultHold(), new RegExp(`${marker} is running \\(pid ${child.pid}\\)`));
    } finally {
      child.kill();
    }
  } finally {
    if (saved === undefined) delete process.env.CRB_YIELD_TO; else process.env.CRB_YIELD_TO = saved;
  }
}));

test("timeouts retry once, infra retries three times, flags re-run once then contaminate", () => withCrbHome(async () => {
  const runs = planRuns({ set: "smoke", config: "high", reviewers: ["codex"], tasks: tasks(3), n: 1 });
  const ex = fakeExecutor(spec => {
    if (spec.task.id === "toy-T01") return { class: "reviewer_timeout", reason: "runner_deadline" };
    if (spec.task.id === "toy-T02") return { class: "infra", reason: "network" };
    return { class: "ok", reason: "revise", flagged: true };
  });
  const clk = clock();
  const s = await runBatch(runs, { execute: ex.execute, retry: RETRY, sleep: clk.sleep, now: clk.now, minFreeBytes: 0 });
  const count = id => ex.calls.filter(c => c.id.includes(id)).length;
  assert.deepEqual([count("toy-T01"), count("toy-T02"), count("toy-T03")], [2, 4, 2]);
  assert.deepEqual([s.done, s.reviewer_failures, s.infra_exhausted, s.contaminated, s.flagged], [2, 1, 1, 1, 2]);
}));

test("a batch refuses to start without enough free disk", () => withCrbHome(async () => {
  const ex = fakeExecutor();
  await assert.rejects(runBatch(planRuns({ set: "smoke", config: "high", reviewers: ["codex"], tasks: tasks(1), n: 1 }), { execute: ex.execute, minFreeBytes: 1e18 }), /free/);
  assert.equal(ex.calls.length, 0);
}));

test("--tasks takes a glob over <repo>/<task> or a file of them", () => {
  assert.deepEqual(selectTaskDirs("pager-js/*", FX).map(d => path.basename(d)), ["pager-js-T01", "pager-js-T02", "pager-js-T03"]);
  assert.deepEqual(selectTaskDirs("pager-js/pager-js-T0[2]", FX), []);
  assert.deepEqual(selectTaskDirs("pager-js/*-T02", FX).map(d => path.basename(d)), ["pager-js-T02"]);
  // several globs, comma-separated (Phase 9: --tasks 'ledger-ts/*,jobqueue-go/*')
  assert.deepEqual(selectTaskDirs("pager-js/*-T03, pager-js/*-T01", FX).map(d => path.basename(d)), ["pager-js-T01", "pager-js-T03"]);
  const list = path.join(os.tmpdir(), `crb-tasks-${process.pid}.txt`);
  fs.writeFileSync(list, "# comment\npager-js/pager-js-T03\npager-js/pager-js-T01,pager-js/*-T02\n");
  try {
    assert.deepEqual(selectTaskDirs(list, FX).map(d => path.basename(d)), ["pager-js-T01", "pager-js-T02", "pager-js-T03"]);
  } finally {
    fs.rmSync(list, { force: true });
  }
});

test("upstream fragments come from source.json URLs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-rb-"));
  try {
    fs.writeFileSync(path.join(dir, "source.json"), JSON.stringify({ repo: "https://github.com/Acme/Widget.git", fix_pr: "https://github.com/acme/widget/pull/9", other: "https://example.com/x" }));
    assert.deepEqual(upstreamFragments({ dir }), ["github.com/acme/widget"]);
    assert.deepEqual(upstreamFragments({ dir: path.join(dir, "none") }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cliVersion reads the first line of `<cli> --version`, and is null when the CLI is missing or fails", async () => {
  const { cliVersion } = await import("../lib/review.js");
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "crb-ver-"));
  try {
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n[ \"$1\" = --version ] && { echo 'codex-cli 9.1.0'; echo 'extra'; exit 0; }\nexit 3\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho 'boom' >&2; exit 1\n", { mode: 0o755 });
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    assert.equal(await cliVersion("codex", { env }), "codex-cli 9.1.0");
    assert.equal(await cliVersion("claude", { env }), null);
    assert.equal(await cliVersion("agy", { env }), null);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
