// End to end through the real pinned runner, with cross-review's fake codex/claude/agy on PATH.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planRuns, runBatch } from "../lib/scheduler.js";
import { listRuns } from "../lib/store.js";
import { e2eSetup as setup } from "./helpers.js";

const QUICK = { infraDelayMs: 10, usageBaseMs: 10, usageMaxMs: 40 };

/** Highest number of runs of one reviewer that overlapped in time. */
function peakOverlap(records) {
  const ev = records.flatMap(r => [[r.started_ms, 1], [r.ended_ms, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0;
  for (const [, d] of ev) { cur += d; peak = Math.max(peak, cur); }
  return peak;
}

test("a Track A batch runs every reviewer through the pinned runner, archives and audits each run", { timeout: 600_000 }, async () => {
  const ctx = setup();
  try {
    const runs = planRuns({ set: "smoke", config: "high", reviewers: ["codex", "claude", "agy"], tasks: ctx.tasks, n: 2 });
    const concurrency = { codex: 3, claude: 3, agy: 2 };
    const s = await runBatch(runs, { concurrency, retry: QUICK, minFreeBytes: 0 });
    assert.deepEqual({ ...s }, { planned: 18, skipped: 0, done: 18, reviewer_failures: 0, infra_failures: 0, flagged: 0, contaminated: 0, infra_exhausted: 0 });

    const records = listRuns("smoke");
    assert.equal(records.length, 18);
    for (const r of records) {
      assert.equal(r.final, true, r.id);
      assert.equal(r.class, "ok", JSON.stringify(r));
      assert.equal(r.verdict, "REVISE");
      assert.equal(r.issues, 1);
      const wait = JSON.parse(fs.readFileSync(path.join(r.archive, "wait.json"), "utf8"));
      assert.equal(wait.review.verdict.status, "REVISE");
      assert.equal(JSON.parse(fs.readFileSync(path.join(r.archive, "audit.json"), "utf8")).flagged, false);
      assert.ok(fs.existsSync(path.join(r.archive, "session", "output.jsonl")), r.archive);
      assert.match(fs.readFileSync(path.join(r.archive, "workspace.diff"), "utf8"), /src\/pager\.js/);
      // round 1 as it was, for Track A scoring, in every run
      assert.equal(JSON.parse(fs.readFileSync(path.join(r.archive, "round1", "wait.json"), "utf8")).review.verdict.status, "REVISE");
      assert.match(fs.readFileSync(path.join(r.archive, "round1", "workspace.diff"), "utf8"), r.task === "pager-js-T01" ? /page < 0\)/ : /src\/pager\.js/);
      // Track B (F10): T01 runs 1 and 2 are B1 and B2; the decoy's D1 (line 12) is not within ±5 of line 6
      const tb = { "pager-js-T01/1": ["B1", "run"], "pager-js-T01/2": ["B2", "run"], "pager-js-T03/1": ["B4", "n/a"], "pager-js-T03/2": ["B4", "n/a"] }[`${r.task}/${r.n}`];
      assert.deepEqual(tb ? [r.track_b.scenario, r.track_b.status] : r.track_b, tb ?? undefined, r.id);
      assert.equal(fs.existsSync(path.join(r.archive, "round2")), tb?.[1] === "run", r.id);
      if (tb?.[1] === "run") assert.deepEqual([r.track_b.class, r.track_b.verdict], ["ok", "REVISE"], r.id);
      // the write-back outcome is in the archived record, not only in memory
      assert.equal(r.codex_write_back, false, r.id);
      // the CLI version is recorded per run (fake agy prints one; the other fakes have none)
      assert.ok("cli_version" in r, r.id);
      // the reviewer's own TMPDIR, inside the run dir and deleted with it
      assert.equal(r.tmpdir, path.join(r.run_dir, "tmp"), r.id);
      assert.equal(fs.existsSync(r.run_dir), false, r.id);
      if (r.reviewer === "agy") assert.equal(r.cli_version, "9.9.9", r.id);
    }
    for (const reviewer of Object.keys(concurrency)) {
      const peak = peakOverlap(records.filter(r => r.reviewer === reviewer));
      assert.ok(peak <= concurrency[reviewer], `${reviewer} peak ${peak}`);
    }
    // nothing live is left behind
    assert.deepEqual(fs.readdirSync(ctx.env.CRB_RUN_ROOT), []);

    // the CLIs got the F5 model and effort, the PR description, the output format, and a clean HOME
    // 6 round-1 turns and 2 round-2 turns (T01 B1, B2) per reviewer
    const codex = ctx.log("codex");
    assert.equal(codex.length, 8);
    assert.ok(codex.every(c => c.args.includes("gpt-6-astra") && c.args.join(" ").includes("high")), JSON.stringify(codex[0].args));
    assert.ok(codex.every(c => c.prompt.includes("ISSUE-") && c.reviewerEnv === "codex"));
    assert.equal(codex.filter(c => c.args.includes("resume")).length, 2);
    const desc = ctx.tasks[0].description;
    assert.ok(codex.some(c => c.prompt.includes(desc)));
    const claude = ctx.log("claude");
    assert.ok(claude.every(c => c.args.join(" ").includes("--effort high") && c.args.join(" ").includes("--model claude-opus-5-5")));
    const agy = ctx.log("agy");
    assert.equal(agy.length, 8);
    assert.ok(agy.every(c => c.args.join(" ").includes("gemini-4-argon")), JSON.stringify(agy[0].args));
    for (const c of [...codex, ...claude, ...agy]) assert.doesNotMatch(c.prompt ?? "", /false_rebuttal|wrongfix|hidden_test/);

    // the same set again: everything is skipped
    const again = await runBatch(runs, { concurrency, retry: QUICK, minFreeBytes: 0 });
    assert.deepEqual([again.skipped, again.done], [18, 0]);
    assert.equal(ctx.log("codex").length, 8);

    // another set does not share archives
    const pilot = await runBatch(planRuns({ set: "pilot", config: "high", reviewers: ["codex"], tasks: ctx.tasks, n: 1 }), { retry: QUICK, minFreeBytes: 0 });
    assert.deepEqual([pilot.skipped, pilot.done], [0, 3]);
  } finally {
    ctx.restore();
  }
});

test("an injected usage limit is retried and never counted as a reviewer failure", { timeout: 300_000 }, async () => {
  const ctx = setup();
  try {
    process.env.FAKE_CODEX_FAIL = "You've hit your usage limit. Upgrade or try again later.";
    const events = [];
    const s = await runBatch(planRuns({ set: "calibration", config: "high", reviewers: ["codex"], tasks: ctx.tasks.slice(0, 1), n: 1 }), {
      retry: QUICK, minFreeBytes: 0,
      onEvent: e => {
        events.push(e);
        if (e.type === "end" && e.result.reason === "usage_limit") delete process.env.FAKE_CODEX_FAIL;
      },
    });
    assert.deepEqual([s.done, s.reviewer_failures, s.infra_failures, s.infra_exhausted], [1, 0, 1, 0]);
    assert.deepEqual(events.filter(e => e.type === "end").map(e => e.decision), ["retry_usage", "final"]);
    assert.ok(events.some(e => e.type === "pause" && e.reviewer === "codex"));
    const [r] = listRuns("calibration");
    assert.deepEqual([r.class, r.verdict, r.attempt], ["ok", "REVISE", 2]);
  } finally {
    delete process.env.FAKE_CODEX_FAIL;
    ctx.restore();
  }
});

test("crb run, status --complete and audit --all work from the command line", { timeout: 300_000 }, async () => {
  const ctx = setup();
  try {
    const crb = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "crb.js");
    const { NODE_TEST_CONTEXT, ...rest } = process.env;
    const env = { ...rest, CRB_MIN_FREE_BYTES: "0" };
    const call = (args, extra = {}) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [crb, ...args], { env: { ...env, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (e) {
        return { code: e.status, out: e.stdout, err: e.stderr };
      }
    };
    // a dry run plans nothing
    assert.equal(call(["run", "--set", "smoke", "--track", "A", "--config", "high", "--reviewers", "codex,agy", "--tasks", "pager-js/*", "--n", "1", "--dry-run"]).code, 0);
    assert.equal(JSON.parse(call(["status", "--set", "smoke"]).out).planned, 0);
    const r = call(["run", "--set", "smoke", "--track", "A", "--config", "high", "--reviewers", "codex,agy", "--tasks", "pager-js/*-T02", "--n", "1", "--concurrency", "agy=1"]);
    assert.equal(r.code, 0, r.err);
    const summary = JSON.parse(r.out);
    assert.deepEqual([summary.set, summary.planned, summary.done], ["smoke", 2, 2]);
    const st = call(["status", "--set", "smoke", "--complete"]);
    assert.equal(st.code, 0, st.out);
    const stOut = JSON.parse(st.out);
    assert.deepEqual(stOut.counts, { "A/high/codex": { ok: 1 }, "A/high/agy": { ok: 1 } });
    assert.deepEqual([stOut.missing, stOut.infra_exhausted], [0, 0]);
    // a set or track with nothing planned is not complete
    assert.equal(call(["status", "--set", "final", "--complete"]).code, 1);
    assert.equal(call(["status", "--set", "smoke", "--track", "C", "--complete"]).code, 1);
    const au = call(["audit", "--set", "smoke", "--all"]);
    assert.equal(au.code, 0, au.out);
    assert.deepEqual([JSON.parse(au.out).flagged, JSON.parse(au.out).contaminated], [0, 0]);
    assert.equal(call(["status", "--set", "nope"]).code, 2);
    // a concurrency that is not a positive integer is refused, not run with no workers
    for (const bad of ["codex=abc", "codex=0", "codex=1.5"]) {
      const c = call(["run", "--set", "pilot", "--track", "A", "--config", "high", "--reviewers", "codex", "--tasks", "pager-js/*-T02", "--n", "1", "--concurrency", bad]);
      assert.equal(c.code, 2, bad);
      assert.match(c.err, /concurrency/);
    }
    // the free-disk floor stops a batch before anything starts
    const floor = call(["run", "--set", "pilot", "--track", "A", "--config", "high", "--reviewers", "codex", "--tasks", "pager-js/*-T02", "--n", "1"], { CRB_MIN_FREE_BYTES: "1e18" });
    assert.equal(floor.code, 2);
    assert.match(floor.err, /free/);
    assert.deepEqual([JSON.parse(call(["status", "--set", "pilot"]).out).archived, JSON.parse(call(["status", "--set", "pilot"]).out).planned], [0, 0]);
  } finally {
    ctx.restore();
  }
});
