// Scores against hand-computed values (Metrics), on fake archives of the toy corpus.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { e2eSetup, fakeRun } from "./helpers.js";
import { ruleInvoke } from "./grading-helpers.js";
import { judgeSet } from "../lib/grade/judge.js";
import { syncAuditQueue } from "../lib/grade/auditq.js";
import { scoreSet } from "../lib/grade/score.js";

const T01 = "pager-js-T01", T02 = "pager-js-T02", T03 = "pager-js-T03";
// what the (single, smoke) judge says about each finding, by title
const KEY = {
  "page zero": { valid: "real", matches: ["B1"] },
  "page zero again": { valid: "real", matches: ["B1"] },
  "style nit": { valid: "not_real", matches: [] },
  "still zero": { valid: "real", matches: ["B1"] },
  "count floors": { valid: "real", matches: ["B2"] },
  "wrong fix still floors": { valid: "real", matches: ["B2"] },
  "new thing": { valid: "real", matches: [] },
  imagined: { valid: "not_real", matches: [] },
  // the judge calls it real, but it matches the decoy: not valid
  "off by one": { valid: "real", matches: ["D1"] },
  "still off by one": { valid: "real", matches: ["D1"] },
};

function fixture() {
  fakeRun({ reviewer: "codex", task: T01, kind: "buggy", n: 1, log: [{ type: "turn.completed", usage: { output_tokens: 863 } }], blocks: [
    { id: 1, title: "page zero", location: "src/pager.js:6" },
    { id: 2, title: "page zero again", location: "`src/pager.js:7`" },
    { id: 3, title: "style nit", location: "src/pager.js:2" },
  ], trackB: { scenario: "B1", status: "run", class: "ok", fixed_bugs: ["B1"], disputed: [], patches: ["fix-B1.patch"] },
  round2: [{ id: 1, title: "still zero", location: "src/pager.js:6" }] });
  fakeRun({ reviewer: "claude", task: T01, kind: "buggy", n: 1, log: [{ type: "assistant", message: { usage: { output_tokens: 9 } } }, { type: "result", usage: { output_tokens: 1526 } }],
    blocks: [{ id: 1, title: "count floors", location: "src/pager.js:20" }],
    trackB: { scenario: "B2", status: "run", class: "ok", fixed_bugs: ["B2"], disputed: [], patches: ["wrongfix-B2.patch"] },
    round2: [{ id: 1, title: "wrong fix still floors", location: "src/pager.js:13" }, { id: 2, title: "new thing", location: "src/other.js:3" }] });
  fakeRun({ reviewer: "agy", task: T01, kind: "buggy", n: 1, cls: "reviewer_timeout", blocks: [] });
  fakeRun({ reviewer: "codex", task: T01, kind: "buggy", n: 3, blocks: [{ id: 1, title: "page zero", location: "src/pager.js:6" }],
    trackB: { scenario: "B3", status: "run", class: "ok", fixed_bugs: [], disputed: ["B1"], patches: [] }, round2: [] });
  fakeRun({ reviewer: "claude", task: T01, kind: "buggy", n: 2, blocks: [], verdict: "APPROVE", trackB: { scenario: "B2", status: "n/a", reason: "no round-1 issue overlaps a bug" } });
  fakeRun({ reviewer: "codex", task: T02, kind: "clean", n: 1, blocks: [], verdict: "APPROVE" });
  fakeRun({ reviewer: "claude", task: T02, kind: "clean", n: 1, blocks: [{ id: 1, title: "imagined", location: "src/pager.js:3" }] });
  fakeRun({ reviewer: "agy", task: T03, kind: "decoy", n: 1, blocks: [{ id: 1, title: "off by one", location: "src/pager.js:12" }],
    trackB: { scenario: "B4", status: "run", class: "ok", fixed_bugs: [], disputed: ["D1"], patches: [] }, round2: [] });
  fakeRun({ reviewer: "codex", task: T03, kind: "decoy", n: 1, blocks: [{ id: 1, title: "off by one", location: "src/pager.js:12" }],
    trackB: { scenario: "B4", status: "run", class: "ok", fixed_bugs: [], disputed: ["D1"], patches: [] }, round2: [{ id: 1, title: "still off by one", location: "src/pager.js:12" }] });
  // a Track C loop
  const loop = path.join(process.env.CRB_HOME, "runs", "smoke/C/high/claude-codex", T01, "1");
  fs.mkdirSync(loop, { recursive: true });
  fs.writeFileSync(path.join(loop, "run.json"), JSON.stringify({
    id: `smoke/C/high/claude-codex/${T01}/1`, set: "smoke", track: "C", config: "high", reviewer: "claude-codex", orchestrator: "claude", cell: "codex",
    task: T01, repo: "pager-js", kind: "buggy", n: 1, final: true, class: "ok", bugs_fixed: ["B1"], bugs_testable: 2, visible_ok: false, review_rounds: 2, sessions: 1, reviewers_used: ["codex"], wall_s: 99,
  }));
}

test("scores match hand-computed values for Tracks A, B and C", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    fixture();
    const calls = [];
    const j = await judgeSet("smoke", { invoke: ruleInvoke(f => KEY[f.title], calls), minFreeBytes: 0 });
    assert.equal(j.failed, 0);
    // one call per task with findings; the judge sees round-2 findings with their state
    assert.equal(calls.length, 3);
    const t01 = calls.find(c => c.prompt.includes("pageCount"));
    assert.match(t01.prompt, /S1: S0 plus this change/);
    for (const c of calls) for (const leak of ["codex", "agy", "smoke/A", "#r1#"]) assert.ok(!c.prompt.includes(leak), `${leak} in a judge prompt`);
    syncAuditQueue("smoke");
    const out = scoreSet("smoke");
    assert.equal(out.track_c, 1);
    const rows = fs.readFileSync(out.file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const a = (rev, task, n = 1) => rows.find(r => r.track === "A" && r.reviewer === rev && r.task === task && r.n === n);
    const b = (rev, task, n = 1) => rows.find(r => r.track === "B" && r.reviewer === rev && r.task === task && r.n === n);
    const pick = r => ({ tp_weight: r.tp_weight, pool_weight: r.pool_weight, findings: r.findings, valid: r.valid, matched: r.matched, matched_locations_ok: r.matched_locations_ok, false_alarm: r.false_alarm, bugs_found: r.bugs_found });

    // the same bug twice: once for recall, twice as valid findings; round-2 findings never count here
    assert.deepEqual(pick(a("codex", T01)), { tp_weight: 2, pool_weight: 5, findings: 3, valid: 2, matched: 2, matched_locations_ok: 2, false_alarm: null, bugs_found: ["B1"] });
    // a match far from the bug's lines is still a match, but its location is not accurate
    assert.deepEqual(pick(a("claude", T01)), { tp_weight: 3, pool_weight: 5, findings: 1, valid: 1, matched: 1, matched_locations_ok: 0, false_alarm: null, bugs_found: ["B2"] });
    // a scored reviewer failure: zero findings, no NaN
    assert.deepEqual(pick(a("agy", T01)), { tp_weight: 0, pool_weight: 5, findings: 0, valid: 0, matched: 0, matched_locations_ok: 0, false_alarm: null, bugs_found: [] });
    // clean task: approved with nothing → no false alarm; REVISE with a not-real finding → false alarm
    assert.deepEqual(pick(a("codex", T02)), { tp_weight: 0, pool_weight: 0, findings: 0, valid: 0, matched: 0, matched_locations_ok: 0, false_alarm: false, bugs_found: [] });
    assert.equal(a("claude", T02).false_alarm, true);
    // a finding matching a decoy is not valid, whatever the judge said
    assert.deepEqual(pick(a("agy", T03)), { tp_weight: 0, pool_weight: 0, findings: 1, valid: 0, matched: 0, matched_locations_ok: 0, false_alarm: true, bugs_found: [] });

    // Track B predicates
    assert.equal(b("codex", T01).outcome, false);           // B1: the fixed bug still flagged
    assert.equal(b("claude", T01).outcome, true);           // B2: the wrong fix caught
    assert.equal(b("claude", T01).new_valid_round2, 1);     // "new thing", far from every round-1 finding
    assert.equal(b("codex", T01, 3).outcome, false);        // B3: nothing still matches the disputed bug
    assert.equal(b("claude", T01, 2).outcome, "n/a");
    assert.equal(b("agy", T03).outcome, true);              // B4: conceded
    assert.equal(b("codex", T03).outcome, false);           // B4: still flags the decoy
    assert.equal(rows.filter(r => r.track === "B").length, 6);

    // round 1's output tokens as each CLI reports them; a run without a usage report has none, not 0
    assert.equal(a("codex", T01).output_tokens, 863);
    assert.equal(a("claude", T01).output_tokens, 1526);
    assert.equal(a("agy", T01).output_tokens, null);

    const c = rows.find(r => r.track === "C");
    assert.deepEqual({ fixed_weight: c.fixed_weight, testable_weight: c.testable_weight, regression: c.regression, review_rounds: c.review_rounds }, { fixed_weight: 2, testable_weight: 5, regression: true, review_rounds: 2 });

    for (const r of rows) for (const [k, v] of Object.entries(r)) if (typeof v === "number") assert.ok(Number.isFinite(v), `${r.run_id} ${k}`);
    // no ratio is stored per run
    for (const r of rows) for (const k of ["precision", "recall", "f1"]) assert.ok(!(k in r));
  } finally {
    ctx.restore();
  }
});

test("score refuses a set whose findings were never judged, and the final set while audits are open", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    fakeRun({ set: "smoke", reviewer: "codex", task: T01, kind: "buggy", blocks: [{ id: 1, title: "page zero", location: "src/pager.js:6" }] });
    assert.throws(() => scoreSet("smoke"), /not collected or judged/);
    fakeRun({ set: "final", reviewer: "codex", task: T01, kind: "buggy", blocks: [{ id: 1, title: "page zero", location: "src/pager.js:6" }] });
    const judges = [{ name: "codex", reviewer: "codex", model: "m", effort: "high" }, { name: "claude", reviewer: "claude", model: "m", effort: "high" }, { name: "agy", reviewer: "agy", model: "m", effort: "high" }];
    await judgeSet("final", { judges, invoke: ruleInvoke(() => KEY["page zero"]), minFreeBytes: 0 });
    syncAuditQueue("final"); // one finding: the 20% sample takes it
    assert.throws(() => scoreSet("final", { resultsDir: path.join(ctx.root, "results") }), /audit item\(s\) are open/);
  } finally {
    ctx.restore();
  }
});

test("rows carry the language and pool composition; leave-one-judge-out needs the remaining two judges to agree", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    fakeRun({ set: "final", reviewer: "codex", task: T01, kind: "buggy", blocks: [{ id: 1, title: "page zero", location: "src/pager.js:6" }] });
    const judges = ["codex", "claude", "agy"].map(name => ({ name, reviewer: name, model: "m", effort: "high" }));
    await judgeSet("final", { judges, invoke: ruleInvoke((f, j) => (j.name === "agy" ? { valid: "not_real", matches: [] } : { valid: "real", matches: ["B1"] })), minFreeBytes: 0 });
    const out = scoreSet("final", { resultsDir: path.join(ctx.root, "results") });
    const row = fs.readFileSync(out.file, "utf8").trim().split("\n").map(l => JSON.parse(l)).find(r => r.track === "A");
    assert.equal(row.language, "js");
    assert.equal(row.tp_weight, 2);
    assert.deepEqual(row.bugs.map(b => [b.id, b.weight, b.pooled]), [["B1", 2, false], ["B2", 3, false]]);
    assert.ok(row.bugs.every(b => b.difficulty && b.category && b.severity));
    // without agy the two agree; without codex or claude the remaining pair splits
    assert.deepEqual(row.loo_judge, { codex: { tp_weight: 0, valid: 0, matched: 0 }, claude: { tp_weight: 0, valid: 0, matched: 0 }, agy: { tp_weight: 2, valid: 1, matched: 1 } });
  } finally {
    ctx.restore();
  }
});
