// The judge panel: answer parsing, majority rules, retries, and one call through the pinned runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { e2eSetup, fakeRun } from "./helpers.js";
import { ruleInvoke } from "./grading-helpers.js";
import { parseJudgments, panelVerdict, judgeTask, judgeSet, readJudgment, panelFile, cliInvoke } from "../lib/grade/judge.js";
import { collectFindings, loadFindings } from "../lib/grade/collect.js";

test("parseJudgments: the whole text, a fenced block or the outer braces; schema errors name the finding", () => {
  const ok = { judgments: [{ id: "F1", matches: ["B1", "B1"], valid: "real", reason: "x" }, { id: "F2", valid: "not_real" }] };
  const want = { F1: { matches: ["B1"], valid: "real", reason: "x" }, F2: { matches: [], valid: "not_real", reason: "" } };
  for (const text of [JSON.stringify(ok), "Here:\n```json\n" + JSON.stringify(ok) + "\n```\n", "Answer " + JSON.stringify(ok) + " done"]) {
    assert.deepEqual(parseJudgments(text, ["F1", "F2"], ["B1", "D1"]), { ok: true, judgments: want });
  }
  assert.equal(parseJudgments("no json", ["F1"], []).ok, false);
  assert.match(parseJudgments(JSON.stringify({ judgments: [{ id: "F1", matches: ["B9"], valid: "real" }] }), ["F1"], ["B1"]).error, /F1: matches must be ids/);
  assert.match(parseJudgments(JSON.stringify({ judgments: [{ id: "F1", valid: "maybe" }] }), ["F1"], []).error, /F1: valid must be/);
  assert.match(parseJudgments(JSON.stringify({ judgments: [{ id: "F1", valid: "real" }] }), ["F1", "F2"], []).error, /F2 is missing/);
  assert.match(parseJudgments(JSON.stringify({ judgments: [{ id: "F1", valid: "real" }, { id: "F1", valid: "real" }] }), ["F1"], []).error, /F1 appears twice/);
  assert.match(parseJudgments(JSON.stringify({ judgments: [{ id: "F7", valid: "real" }] }), ["F1"], []).error, /unknown finding id "F7"/);
});

test("panelVerdict: majorities, ties, uncertain, decoys, inconsistency and quorum", () => {
  const v = (valid, matches = []) => ({ valid, matches });
  assert.deepEqual(panelVerdict([v("real", ["B1"]), v("real", ["B1"]), v("not_real")], { panelSize: 3 }), { valid: "real", matches: ["B1"], audit: null, votes: 3 });
  // two of three answered: a 1–1 split on validity is a tie
  assert.deepEqual(panelVerdict([v("real"), v("not_real")], { panelSize: 3 }), { valid: null, matches: [], audit: "tie", votes: 2 });
  // agreeing on validity but split on the match
  assert.deepEqual(panelVerdict([v("real", ["B1"]), v("real")], { panelSize: 3 }), { valid: "real", matches: [], audit: "tie", votes: 2 });
  assert.deepEqual(panelVerdict([v("uncertain"), v("uncertain"), v("real")], { panelSize: 3 }), { valid: null, matches: [], audit: "uncertain", votes: 3 });
  // a decoy match overrides "real"
  assert.deepEqual(panelVerdict([v("real", ["D1"]), v("real", ["D1"]), v("real")], { panelSize: 3, decoyIds: ["D1"] }), { valid: "not_real", matches: ["D1"], audit: null, votes: 3 });
  assert.deepEqual(panelVerdict([v("not_real", ["B1"]), v("not_real", ["B1"]), v("real", ["B1"])], { panelSize: 3 }), { valid: "not_real", matches: ["B1"], audit: "inconsistent", votes: 3 });
  assert.deepEqual(panelVerdict([v("real")], { panelSize: 3 }), { valid: null, matches: [], audit: "judge_failure", votes: 1 });
  assert.deepEqual(panelVerdict([], { panelSize: 1 }).audit, "judge_failure");
  assert.deepEqual(panelVerdict([v("real", ["B2"])], { panelSize: 1 }), { valid: "real", matches: ["B2"], audit: null, votes: 1 });
});

function oneFinding(ctx) {
  fakeRun({ reviewer: "codex", task: "pager-js-T01", kind: "buggy", blocks: [{ id: 1, title: "page zero", location: "src/pager.js:6" }] });
  collectFindings("smoke", { corpus: ctx.corpus });
  return loadFindings("smoke").tasks["pager-js-T01"].findings;
}

test("judgeTask retries malformed and flagged answers, gives up after three, and stops on an infra fault", async () => {
  const ctx = e2eSetup();
  try {
    const findings = oneFinding(ctx);
    const task = ctx.task("pager-js-T01");
    const judge = { name: "claude", reviewer: "claude", model: "m", effort: "high" };
    const good = JSON.stringify({ judgments: [{ id: findings[0].fid, matches: ["B1"], valid: "real", reason: "r" }] });
    const seq = answers => { let i = 0; const calls = []; return { calls, invoke: async (j, a) => { calls.push(a.prompt); return answers[Math.min(i++, answers.length - 1)]; } }; };

    let s = seq([{ status: "completed", text: "not json" }, { status: "completed", text: good, flagged: true }, { status: "completed", text: good }]);
    let r = await judgeTask(task, findings, judge, { invoke: s.invoke });
    assert.equal(r.status, "ok");
    assert.equal(s.calls.length, 3);
    assert.deepEqual(r.judgments[findings[0].fid].matches, ["B1"]);
    assert.match(r.attempts[0].error, /no JSON/);
    assert.match(r.attempts[1].error, /flagged/);

    s = seq([{ status: "completed", text: "{}" }]);
    r = await judgeTask(task, findings, judge, { invoke: s.invoke });
    assert.equal(r.status, "failed");
    assert.equal(s.calls.length, 3);

    // a deadline is retried like a bad answer; a usage limit is not
    s = seq([{ status: "timeout" }, { status: "completed", text: good }]);
    assert.equal((await judgeTask(task, findings, judge, { invoke: s.invoke })).status, "ok");
    s = seq([{ status: "failed", error: "You've hit your usage limit. Try again later." }]);
    r = await judgeTask(task, findings, judge, { invoke: s.invoke });
    assert.equal(r.status, "infra");
    assert.equal(s.calls.length, 1);
  } finally {
    ctx.restore();
  }
});

test("judgeSet: a failed judge leaves its findings to the panel's quorum; unchanged judgments are not asked again", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    oneFinding(ctx);
    const judges = ["a", "b", "c"].map(name => ({ name, reviewer: "claude", model: "m", effort: "high" }));
    const calls = [];
    const real = ruleInvoke(() => ({ valid: "real", matches: ["B1"] }), calls);
    const invoke = async (j, a) => (j.name === "c" ? { status: "completed", text: "nonsense" } : real(j, a));
    let out = await judgeSet("smoke", { judges, invoke, minFreeBytes: 0 });
    assert.equal(out.failed, 1);
    const key = Object.keys(JSON.parse(fs.readFileSync(panelFile("smoke"), "utf8"))["pager-js-T01"])[0];
    const panel = JSON.parse(fs.readFileSync(panelFile("smoke"), "utf8"))["pager-js-T01"][key];
    assert.deepEqual({ valid: panel.valid, matches: panel.matches, audit: panel.audit, votes: panel.votes }, { valid: "real", matches: ["B1"], audit: null, votes: 2 });
    assert.equal(readJudgment("smoke", "pager-js-T01", "c").status, "failed");
    // the second pass asks only the judge that failed
    calls.length = 0;
    out = await judgeSet("smoke", { judges, invoke: real, minFreeBytes: 0 });
    assert.equal(out.calls, 1);
    assert.deepEqual(calls.map(c => c.judge), ["c"]);
    assert.equal(out.failed, 0);
  } finally {
    ctx.restore();
  }
});

test("judgeSet through the pinned runner: the Sonnet judge answers from a clean profile in read-only mode", { timeout: 120_000 }, async () => {
  const ctx = e2eSetup();
  try {
    const findings = oneFinding(ctx);
    fs.writeFileSync(ctx.env.FAKE_CLAUDE_OUTPUT, "```json\n" + JSON.stringify({ judgments: [{ id: findings[0].fid, matches: ["B1"], valid: "real", reason: "the guard accepts 0" }] }) + "\n```\n");
    const out = await judgeSet("smoke", { pollMs: 1000, minFreeBytes: 0 }); // the runner calls 12 polls without output a stall
    assert.equal(out.failed, 0, JSON.stringify(readJudgment("smoke", "pager-js-T01", "claude")?.attempts));
    const j = readJudgment("smoke", "pager-js-T01", "claude");
    assert.equal(j.model, "claude-sonnet-5-5");
    assert.deepEqual(Object.values(j.judgments)[0].matches, ["B1"]);
    const calls = ctx.log("claude");
    assert.equal(calls.length, 1, JSON.stringify(calls.map(c => c.args)) + JSON.stringify(j.attempts.map(a => [a.status, a.error])));
    const argv = calls[0].args.join(" ");
    assert.match(argv, /--model claude-sonnet-5-5/);
    assert.match(argv, /--permission-mode plan/);
    // the prompt the judge got names no reviewer
    assert.match(calls[0].prompt, /src\/pager\.js:6/);
    assert.ok(!calls[0].prompt.includes("codex"));
    // the temporary run dir is gone
    assert.deepEqual(fs.readdirSync(ctx.env.CRB_RUN_ROOT), []);
  } finally {
    ctx.restore();
  }
});

test("a judge that writes a long answer silently for longer than the runner's default stall window is not cut off", { timeout: 120_000 }, async () => {
  const ctx = e2eSetup();
  try {
    const findings = oneFinding(ctx);
    fs.writeFileSync(ctx.env.FAKE_CODEX_OUTPUT, JSON.stringify({ judgments: [{ id: findings[0].fid, matches: ["B1"], valid: "real", reason: "r" }] }));
    // silent for 3 s while polled every 100 ms: the runner's default (12 polls without output) would call it stalled
    process.env.FAKE_CODEX_SLOW_MS = "3000";
    const judge = { name: "codex", reviewer: "codex", effort: "high" };
    const res = await judgeTask(ctx.task("pager-js-T01"), findings, judge, { invoke: (j, a) => cliInvoke(j, { ...a, pollMs: 100 }), attempts: 1 });
    assert.equal(res.status, "ok", JSON.stringify(res.attempts.map(a => [a.status, a.error])));
  } finally {
    delete process.env.FAKE_CODEX_SLOW_MS;
    ctx.restore();
  }
});
