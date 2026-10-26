// Pooling: a real finding outside the answer key becomes a pooled bug once the audit confirms it,
// and every reviewer whose finding the panel matches to it is credited.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { e2eSetup, fakeRun } from "./helpers.js";
import { promptFindings, ruleInvoke } from "./grading-helpers.js";
import { judgeSet } from "../lib/grade/judge.js";
import { poolSet, parseGroups } from "../lib/grade/pool.js";
import { readQueue, readPool, recordVerdict } from "../lib/grade/auditq.js";
import { scoreSet } from "../lib/grade/score.js";
import { resolveFindings } from "../lib/grade/verdicts.js";

const T01 = "pager-js-T01";
const rows = out => fs.readFileSync(out.file, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(r => r.track === "A");

test("parseGroups: every candidate in one group, with a location, severity and summary", () => {
  const g = { findings: ["F1"], file: "./src/a.js", lines: [3, 4], severity: "high", summary: "s" };
  assert.deepEqual(parseGroups(JSON.stringify({ groups: [g, { ...g, findings: ["F2"] }] }), ["F1", "F2"]).groups[0].file, "src/a.js");
  assert.match(parseGroups(JSON.stringify({ groups: [g] }), ["F1", "F2"]).error, /missing F2/);
  assert.match(parseGroups(JSON.stringify({ groups: [g, g] }), ["F1"]).error, /F1 in two groups/);
  assert.match(parseGroups(JSON.stringify({ groups: [{ ...g, lines: [4, 3] }] }), ["F1"]).error, /lines/);
  assert.match(parseGroups(JSON.stringify({ groups: [{ ...g, severity: "huge" }] }), ["F1"]).error, /severity/);
});

test("a confirmed pooled bug credits every reviewer the panel matches to it and raises everyone's pool", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: [
      { id: 1, title: "page zero", location: "src/pager.js:6" },
      { id: 2, title: "extra defect", location: "src/pager.js:30" },
    ] });
    fakeRun({ reviewer: "claude", task: T01, kind: "buggy", blocks: [{ id: 1, title: "extra defect seen again", location: "src/pager.js:31" }] });
    fakeRun({ reviewer: "agy", task: T01, kind: "buggy", blocks: [{ id: 1, title: "page zero", location: "src/pager.js:6" }] });
    const extra = f => f.title.startsWith("extra");
    await judgeSet("smoke", { invoke: ruleInvoke(f => (extra(f) ? { valid: "real", matches: [] } : { valid: "real", matches: ["B1"] })), minFreeBytes: 0 });

    const before = rows(scoreSet("smoke"));
    assert.deepEqual(before.map(r => [r.reviewer, r.tp_weight, r.pool_weight]).sort(), [["agy", 2, 5], ["claude", 0, 5], ["codex", 2, 5]]);

    // the helper keeps the two candidates apart: two pool items
    const helperCalls = [];
    const dedupe = async (j, { prompt }) => {
      helperCalls.push(j.model);
      const fs_ = promptFindings(prompt);
      return { status: "completed", text: JSON.stringify({ groups: fs_.map(f => ({ findings: [f.id], file: "src/pager.js", lines: [30, 31], severity: "high", summary: `pooled ${f.title}` })) }) };
    };
    let out = await poolSet("smoke", { invoke: dedupe });
    assert.equal(out.candidates, 2);
    assert.equal(out.groups_queued, 2);
    assert.deepEqual(helperCalls, ["claude-sonnet-5-5"]);
    const items = readQueue("smoke").items.filter(i => i.kind === "pool");
    assert.equal(items.length, 2);

    // the audit confirms codex's candidate (identified through mapping.json, as the auditor never is)
    const mapping = JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "mapping.json"), "utf8"));
    const codexItem = items.find(i => mapping[i.keys[0]].reviewer === "codex");
    const evidence = path.join(ctx.root, "evidence.md");
    fs.writeFileSync(evidence, "invented argument citing src/pager.js:30");
    assert.throws(() => recordVerdict("smoke", codexItem.id, { verdict: "real" }), /needs evidence/);
    const rec = recordVerdict("smoke", codexItem.id, { verdict: "real", evidence, lines: [30, 30] });
    assert.equal(rec.pooled, "P1");
    assert.deepEqual(readPool("smoke").bugs.map(b => [b.id, b.lines, b.severity, b.rechecked]), [["P1", [30, 30], "high", false]]);

    // the re-check shows the panel only P1 and the task's other findings in its file; three judges,
    // agy dissenting, so the 2-1 match holds for the panel but not without codex or claude
    const recheck = [];
    const three = ["codex", "claude", "agy"].map(name => ({ name, reviewer: name, model: "m", effort: "high" }));
    out = await poolSet("smoke", { judges: three, invoke: ruleInvoke((f, j, prompt) => { recheck.push({ title: f.title, prompt }); return { valid: "real", matches: extra(f) && j.name !== "agy" ? ["P1"] : [] }; }) });
    assert.deepEqual(out.rechecked.map(r => [r.id, r.checked, r.matched, r.audit]), [["P1", 3, 1, 0]]);
    const stored = JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "recheck.json"), "utf8")).P1;
    const claudeKey = Object.keys(stored).find(k => mapping[k].reviewer === "claude");
    assert.deepEqual(stored[claudeKey].judges, { codex: { valid: "real", match: true }, claude: { valid: "real", match: true }, agy: { valid: "real", match: false } });
    const p1 = judges => resolveFindings("smoke", { judges }).verdicts[claudeKey].matches.includes("P1");
    assert.deepEqual([p1(null), p1(["claude", "agy"]), p1(["codex", "agy"]), p1(["codex", "claude"])], [true, false, false, true]);
    assert.ok(!recheck.some(r => r.title === "extra defect"), "the pooled bug's own cluster is not re-checked");
    assert.match(recheck[0].prompt, /re-check against newly confirmed defects/);
    assert.ok(!recheck[0].prompt.includes("B1 —"), "a re-check lists only the pooled bug");
    assert.equal(out.groups_queued, 0, "matched and queued findings are no longer candidates");
    assert.equal(readPool("smoke").bugs[0].rechecked, true);

    const after = rows(scoreSet("smoke"));
    assert.deepEqual(after.map(r => [r.reviewer, r.tp_weight, r.pool_weight]).sort(), [["agy", 2, 8], ["claude", 3, 8], ["codex", 5, 8]]);
    assert.deepEqual(after.find(r => r.reviewer === "claude").bugs_found, ["P1"]);

    // a third pass has nothing left to re-check
    out = await poolSet("smoke", { invoke: async () => assert.fail("no call expected") });
    assert.deepEqual(out.rechecked, []);
  } finally {
    ctx.restore();
  }
});

/**
 * Three confirmed pooled bugs on one task, then one re-check pass; returns what the pass left.
 * `names`: the judges (two make every split a tie, queued for audit); `delay`: ms per pooled bug.
 */
async function recheckThree(concurrency, { names = ["codex", "claude", "agy"], delay = {}, beforePass = () => {} } = {}) {
  const ctx = e2eSetup();
  try {
    const extras = [30, 40, 50];
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: extras.map((l, i) => ({ id: i + 1, title: `extra ${l}`, location: `src/pager.js:${l}` })) });
    fakeRun({ reviewer: "claude", task: T01, kind: "buggy", blocks: extras.map((l, i) => ({ id: i + 1, title: `extra ${l} seen again`, location: `src/pager.js:${l + 1}` })) });
    fakeRun({ reviewer: "agy", task: T01, kind: "buggy", blocks: [{ id: 1, title: "page zero", location: "src/pager.js:6" }] });
    await judgeSet("smoke", { invoke: ruleInvoke(f => (f.title.startsWith("extra") ? { valid: "real", matches: [] } : { valid: "real", matches: ["B1"] })), minFreeBytes: 0 });
    const dedupe = async (j, { prompt }) => ({ status: "completed", text: JSON.stringify({ groups: promptFindings(prompt).map(f => ({ findings: [f.id], file: "src/pager.js", lines: [Number(f.location.split(":")[1]), Number(f.location.split(":")[1])], severity: "high", summary: f.title })) }) });
    await poolSet("smoke", { invoke: dedupe });
    const mapping = JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "mapping.json"), "utf8"));
    const evidence = path.join(ctx.root, "evidence.md");
    fs.writeFileSync(evidence, "invented argument citing src/pager.js");
    // confirm codex's three candidates, in line order, so P1..P3 are the same in every pass
    const items = readQueue("smoke").items.filter(i => i.kind === "pool" && mapping[i.keys[0]].reviewer === "codex").sort((a, b) => a.proposal.lines[0] - b.proposal.lines[0]);
    for (const it of items) recordVerdict("smoke", it.id, { verdict: "real", evidence, lines: it.proposal.lines });
    assert.deepEqual(readPool("smoke").bugs.map(b => b.id), ["P1", "P2", "P3"]);

    let inFlight = 0, maxInFlight = 0;
    const started = [];
    const panel = names.map(name => ({ name, reviewer: name, model: "m", effort: "high" }));
    const target = prompt => prompt.match(/\b(P\d)\b/)[1];
    const answer = ruleInvoke((f, j, prompt) => {
      const t = target(prompt);
      const line = { P1: 30, P2: 40, P3: 50 }[t];
      return { valid: "real", matches: f.title === `extra ${line} seen again` && (j.name !== "agy" || t === "P2") ? [t] : [] };
    });
    const slow = async (j, a) => {
      const t = target(a.prompt);
      if (!started.includes(t)) started.push(t);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, delay[t] ?? 30));
      try { return await answer(j, a); } finally { inFlight--; }
    };
    beforePass();
    let out, error = null;
    try { out = await poolSet("smoke", { judges: panel, invoke: slow, concurrency }); } catch (e) { error = e; }
    const stored = JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "recheck.json"), "utf8"));
    const byReviewer = Object.fromEntries(Object.entries(stored).map(([p, r]) => [p, Object.entries(r).map(([k, v]) => [mapping[k].reviewer, v.match, v.for, v.votes]).sort()]));
    const queue = readQueue("smoke").items.filter(i => i.kind === "pool_match").map(i => [i.id, i.target, mapping[i.keys[0]].reviewer]);
    return { out, error, started, byReviewer, maxInFlight, rechecked: readPool("smoke").bugs.map(b => [b.id, b.rechecked]), queue };
  } finally {
    ctx.restore();
  }
}

test("pool re-checks pooled bugs in parallel with the same results as one at a time", { timeout: 120_000 }, async () => {
  const seq = await recheckThree(1);
  const par = await recheckThree(3);
  assert.equal(seq.maxInFlight, 1);
  assert.equal(par.maxInFlight, 3, "three pooled bugs in flight at once");
  assert.deepEqual(par.out.rechecked.map(r => r.id), ["P1", "P2", "P3"], "summary in pool order");
  assert.deepEqual(par.out.rechecked, seq.out.rechecked);
  assert.deepEqual(par.byReviewer, seq.byReviewer);
  assert.deepEqual(Object.keys(par.byReviewer).sort(), ["P1", "P2", "P3"], "no re-check lost to a concurrent write");
  assert.deepEqual(par.rechecked, [["P1", true], ["P2", true], ["P3", true]]);
  assert.deepEqual(par.queue, seq.queue);
  assert.deepEqual(par.out.errors, []);
});

test("parallel re-checks queue their audits in pool order even when they finish out of order", { timeout: 120_000 }, async () => {
  // two judges: every 1-1 split is a tie, so each pooled bug queues an audit; P1 finishes last
  const opts = { names: ["codex", "agy"], delay: { P1: 300, P2: 10, P3: 10 } };
  const seq = await recheckThree(1, opts);
  const par = await recheckThree(3, opts);
  assert.equal(par.maxInFlight, 3);
  assert.deepEqual(seq.queue.map(q => q[1]), ["P1", "P3"], "P1 and P3 split 1-1 (P2 is matched by both)");
  assert.deepEqual(par.queue, seq.queue, "same audit items, same ids, same order");
  assert.deepEqual(par.byReviewer, seq.byReviewer);
  assert.deepEqual(par.out.rechecked, seq.out.rechecked);
});

test("a failed write during parallel re-checks starts no further re-check", { timeout: 120_000 }, async () => {
  const rename = fs.renameSync;
  let broke = false;
  try {
    const res = await recheckThree(2, {
      delay: { P1: 10, P2: 200, P3: 10 },
      beforePass: () => {
        fs.renameSync = (src, dest) => {
          if (!broke && path.basename(dest) === "pool.json") { broke = true; throw Object.assign(new Error("invented EIO"), { code: "EIO" }); }
          return rename(src, dest);
        };
      },
    });
    assert.match(res.error?.message ?? "", /invented EIO/);
    assert.deepEqual(res.started, ["P1", "P2"], "P3 never started after P1's write failed");
    assert.deepEqual(res.rechecked, [["P1", false], ["P2", false], ["P3", false]]);
  } finally {
    fs.renameSync = rename;
  }
});

test("a pool candidate the audit finds to be a planted bug matches it and adds no pooled bug", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: [{ id: 1, title: "extra defect", location: "src/pager.js:30" }] });
    await judgeSet("smoke", { invoke: ruleInvoke(() => ({ valid: "real", matches: [] })), minFreeBytes: 0 });
    const dedupe = async (j, { prompt }) => ({ status: "completed", text: JSON.stringify({ groups: promptFindings(prompt).map(f => ({ findings: [f.id], file: "src/pager.js", lines: [30, 30], severity: "high", summary: "s" })) }) });
    await poolSet("smoke", { invoke: dedupe });
    const item = readQueue("smoke").items.find(i => i.kind === "pool");
    const evidence = path.join(ctx.root, "evidence.md");
    fs.writeFileSync(evidence, "invented argument: the panel missed that this is B1");
    const rec = recordVerdict("smoke", item.id, { verdict: "real", match: ["B1"], evidence });
    assert.equal(rec.pooled, undefined);
    assert.deepEqual(readPool("smoke").bugs, []);
    assert.deepEqual(resolveFindings("smoke").verdicts[item.keys[0]].matches, ["B1"]);
    assert.equal(rows(scoreSet("smoke"))[0].tp_weight, 2);
  } finally {
    ctx.restore();
  }
});
