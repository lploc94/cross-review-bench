// How judge, pool, audit queue and score fit together across passes: unjudged tasks, lapsed panel
// reasons, sampled findings that are pool candidates, audit precedence, and the final set's guards.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { e2eSetup, fakeRun } from "./helpers.js";
import { ruleInvoke } from "./grading-helpers.js";
import { judgeSet, panelFile } from "../lib/grade/judge.js";
import { poolSet } from "../lib/grade/pool.js";
import { syncAuditQueue, readQueue, queueStatus, recordVerdict, enqueue } from "../lib/grade/auditq.js";
import { resolveFindings } from "../lib/grade/verdicts.js";
import { scoreSet } from "../lib/grade/score.js";

const T01 = "pager-js-T01", T02 = "pager-js-T02";
const three = ["a", "b", "c"].map(name => ({ name, reviewer: "claude", model: "m", effort: "high" }));
const mappingOf = () => JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "mapping.json"), "utf8"));
const evidenceFile = ctx => { const f = path.join(ctx.root, "e.md"); fs.writeFileSync(f, "invented argument"); return f; };
const real = ruleInvoke(f => ({ valid: "real", matches: f.title === "g" ? [] : ["B1"] })); // T02 ("g") is clean: no B1

test("tasks not judged yet are not judge failures; a later panel withdraws lapsed audit reasons", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: `f${i}`, location: `src/pager.js:${6 + i}` })) });
    fakeRun({ reviewer: "claude", task: T02, kind: "clean", blocks: [{ id: 1, title: "g", location: "src/pager.js:3" }] });
    // pass 1: only T01, and two of three judges fail on it
    const failing = async (j, a) => (j.name === "a" ? real(j, a) : { status: "completed", text: "nonsense" });
    await judgeSet("smoke", { judges: three, tasks: [T01], invoke: failing, minFreeBytes: 0 });
    const panel = JSON.parse(fs.readFileSync(panelFile("smoke"), "utf8"));
    assert.ok(Object.values(panel[T01]).every(v => v.audit === "judge_failure"));
    assert.ok(Object.values(panel[T02]).every(v => v.audit === "not_judged"));
    syncAuditQueue("smoke");
    let q = readQueue("smoke");
    assert.ok(q.items.filter(i => i.task === T02).every(i => i.reasons.join() === "sample"), "an unjudged task is queued for its sample only");
    assert.equal(q.items.filter(i => i.reasons.includes("judge_failure")).length, 6);

    // pass 2: every judge answers; the failures lapse
    await judgeSet("smoke", { judges: three, invoke: real, minFreeBytes: 0 });
    syncAuditQueue("smoke");
    q = readQueue("smoke");
    assert.equal(q.items.filter(i => i.status === "open" && i.reasons.includes("judge_failure")).length, 0);
    const sampled = q.items.filter(i => i.reasons.includes("sample")).length;
    assert.equal(q.items.filter(i => i.status === "withdrawn").length, 6 - 2); // codex: ceil(20% of 6) sampled
    assert.equal(queueStatus("smoke").open, sampled);
    // a withdrawn item comes back if the panel splits again
    const withdrawn = q.items.find(i => i.status === "withdrawn");
    enqueue("smoke", [{ kind: "finding", task: T01, keys: withdrawn.keys, reasons: ["tie"] }]);
    assert.deepEqual(readQueue("smoke").items.find(i => i.id === withdrawn.id).reasons, ["tie"]);
    assert.equal(readQueue("smoke").items.find(i => i.id === withdrawn.id).status, "open");
  } finally {
    ctx.restore();
  }
});

test("a sampled real finding is still a pool candidate, and its pool audit settles the sample item", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: [{ id: 1, title: "extra", location: "src/pager.js:30" }] });
    await judgeSet("smoke", { invoke: ruleInvoke(() => ({ valid: "real", matches: [] })), minFreeBytes: 0 });
    syncAuditQueue("smoke");
    const sample = readQueue("smoke").items.find(i => i.reasons.includes("sample"));
    assert.ok(sample, "a reviewer with one finding has it sampled");
    const out = await poolSet("smoke", { invoke: async () => assert.fail("one candidate needs no helper") });
    assert.equal(out.groups_queued, 1);
    const poolItem = readQueue("smoke").items.find(i => i.kind === "pool");
    const evidence = evidenceFile(ctx);
    assert.throws(() => recordVerdict("smoke", poolItem.id, { verdict: "not_real", match: ["B1"], evidence }), /contradicts --match B1/);
    recordVerdict("smoke", poolItem.id, { verdict: "real", evidence });
    const q = readQueue("smoke");
    assert.equal(q.items.find(i => i.id === sample.id).status, "done");
    assert.equal(queueStatus("smoke").open, 0);
    const v = resolveFindings("smoke").verdicts[sample.keys[0]];
    assert.deepEqual({ valid: v.valid, matches: v.matches, provisional: v.provisional }, { valid: "real", matches: ["P1"], provisional: false });
  } finally {
    ctx.restore();
  }
});

test("an audit's verdict stands against the panel's re-check; an inconsistent re-check goes to the audit", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: [{ id: 1, title: "extra", location: "src/pager.js:30" }] });
    fakeRun({ reviewer: "claude", task: T01, kind: "buggy", blocks: [{ id: 1, title: "near extra", location: "src/pager.js:31" }] });
    fakeRun({ reviewer: "agy", task: T01, kind: "buggy", blocks: [{ id: 1, title: "other", location: "src/pager.js:33" }] });
    await judgeSet("smoke", { judges: three, invoke: ruleInvoke(f => (f.title === "extra" ? { valid: "real", matches: [] } : { valid: "real", matches: ["B1"] })), minFreeBytes: 0 });
    const mapping = mappingOf();
    const keyOf = rev => Object.keys(mapping).find(k => mapping[k].reviewer === rev);
    const evidence = evidenceFile(ctx);
    // the auditor finds claude's finding not real
    enqueue("smoke", [{ kind: "finding", task: T01, keys: [keyOf("claude")], reasons: ["sample"] }]);
    recordVerdict("smoke", readQueue("smoke").items[0].id, { verdict: "not_real", evidence });
    await poolSet("smoke", { judges: three, invoke: async () => assert.fail("one candidate needs no helper") });
    recordVerdict("smoke", readQueue("smoke").items.find(i => i.kind === "pool").id, { verdict: "real", evidence });
    // re-check: every judge matches claude's finding to P1; on agy's, two say "not real" yet name P1
    const out = await poolSet("smoke", { judges: three, invoke: ruleInvoke((f, j) => (f.title === "other" && j.name !== "a" ? { valid: "not_real", matches: ["P1"] } : { valid: "real", matches: ["P1"] })) });
    assert.deepEqual(out.rechecked.map(r => [r.checked, r.matched, r.audit]), [[2, 1, 1]]);
    const { verdicts } = resolveFindings("smoke");
    assert.deepEqual({ valid: verdicts[keyOf("claude")].valid, matches: verdicts[keyOf("claude")].matches }, { valid: "not_real", matches: [] });
    const pm = readQueue("smoke").items.find(i => i.kind === "pool_match");
    assert.deepEqual([pm.keys[0], pm.target, pm.reasons], [keyOf("agy"), "P1", ["inconsistent"]]);
    assert.equal(verdicts[keyOf("agy")].provisional, true);
    // the audit of the re-check: not real, and naming P1 with it is refused
    assert.throws(() => recordVerdict("smoke", pm.id, { verdict: "not_real", match: ["P1"], evidence }), /contradicts/);
    recordVerdict("smoke", pm.id, { verdict: "not_real", match: ["none"], evidence });
    assert.deepEqual({ valid: resolveFindings("smoke").verdicts[keyOf("agy")].valid, matches: resolveFindings("smoke").verdicts[keyOf("agy")].matches }, { valid: "not_real", matches: ["B1"] });
  } finally {
    ctx.restore();
  }
});

test("the final set is scored only once pooling and judging are finished", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    const results = path.join(ctx.root, "results");
    fakeRun({ set: "final", reviewer: "codex", task: T01, kind: "buggy", blocks: [{ id: 1, title: "extra", location: "src/pager.js:30" }] });
    fakeRun({ set: "final", reviewer: "claude", task: T02, kind: "clean", blocks: [{ id: 1, title: "g", location: "src/pager.js:3" }] });
    const judges = ["codex", "claude", "agy"].map(name => ({ name, reviewer: name, model: "m", effort: "high" }));
    const invoke = ruleInvoke(f => (f.title === "extra" ? { valid: "real", matches: [] } : { valid: "not_real", matches: [] }));
    await judgeSet("final", { judges, tasks: [T01], invoke, minFreeBytes: 0 });
    assert.throws(() => scoreSet("final", { resultsDir: results }), /pool candidate\(s\) are not queued/);
    await poolSet("final", { judges, invoke: async () => assert.fail("no helper call") });
    const evidence = evidenceFile(ctx);
    recordVerdict("final", readQueue("final").items.find(i => i.kind === "pool").id, { verdict: "real", evidence });
    assert.throws(() => scoreSet("final", { resultsDir: results }), /P1 are not re-checked/);
    await poolSet("final", { judges, invoke: async () => assert.fail("nothing to re-check against") });
    assert.throws(() => scoreSet("final", { resultsDir: results }), /provisional/); // T02 not judged
    await judgeSet("final", { judges, invoke, minFreeBytes: 0 });
    const out = scoreSet("final", { resultsDir: results });
    assert.equal(out.provisional, 0);
    assert.ok(fs.existsSync(path.join(results, "scores.jsonl")));
    // pooled bugs leave the grading dir without their answer text (file, lines, summary)
    const pooled = JSON.parse(fs.readFileSync(path.join(results, "pool.json"), "utf8"));
    assert.deepEqual(pooled.bugs.map(b => Object.keys(b).sort()), [["id", "severity", "task"]]);
    assert.deepEqual(pooled.bugs.map(b => [b.id, b.task]), [["P1", T01]]);
    assert.equal(pooled.set, "final");
  } finally {
    ctx.restore();
  }
});

test("a replaced attempt keeps its keys but not its grading: judged and audited again, never credited from the old findings", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    const block = title => [{ id: 1, title, location: "src/pager.js:6" }];
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("valid first attempt") });
    const rule = ruleInvoke(f => (f.title === "valid first attempt" ? { valid: "real", matches: ["B1"] } : { valid: "not_real", matches: [] }));
    await judgeSet("smoke", { judges: three, invoke: rule, minFreeBytes: 0 });
    const key = Object.keys(mappingOf())[0];
    enqueue("smoke", [{ kind: "finding", task: T01, keys: [key], reasons: ["sample"] }]);
    const item = readQueue("smoke").items[0];
    recordVerdict("smoke", item.id, { verdict: "real", match: ["B1"], evidence: evidenceFile(ctx) });
    assert.deepEqual(resolveFindings("smoke").verdicts[key].matches, ["B1"]);

    // the attempt is replaced (requeued or restored): same run id and issue number, another finding
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("false alarm replacement") });
    // until it is judged again, neither the panel nor the audit of the old finding counts
    await judgeSet("smoke", { judges: three, tasks: [T02], invoke: rule, minFreeBytes: 0 });
    let v = resolveFindings("smoke").verdicts[key];
    assert.deepEqual({ valid: v.valid, matches: v.matches, provisional: v.provisional }, { valid: null, matches: [], provisional: true });
    assert.equal(scoreSet("smoke", { resultsDir: path.join(ctx.root, "results") }) && JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "scores.jsonl"), "utf8").trim()).provisional, true);

    // judging again asks every judge, and the old audit record no longer settles the item
    const calls = [];
    await judgeSet("smoke", { judges: three, invoke: ruleInvoke(f => (f.title === "valid first attempt" ? { valid: "real", matches: ["B1"] } : { valid: "not_real", matches: [] }), calls), minFreeBytes: 0 });
    assert.equal(calls.length, 3);
    syncAuditQueue("smoke");
    assert.equal(readQueue("smoke").items.find(i => i.id === item.id).status, "open");
    v = resolveFindings("smoke").verdicts[key];
    assert.deepEqual({ valid: v.valid, matches: v.matches, provisional: v.provisional }, { valid: "not_real", matches: [], provisional: true });
    recordVerdict("smoke", item.id, { verdict: "not_real", evidence: evidenceFile(ctx) });
    const row = JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "scores.jsonl"), "utf8").trim());
    scoreSet("smoke", { resultsDir: path.join(ctx.root, "results") });
    const fresh = JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "scores.jsonl"), "utf8").trim());
    assert.ok(row.provisional);
    assert.deepEqual({ valid: fresh.valid, bugs_found: fresh.bugs_found, provisional: fresh.provisional }, { valid: 0, bugs_found: [], provisional: false });
  } finally {
    ctx.restore();
  }
});

test("an interrupted refresh reopens a finding item whose record it had already set aside", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  const rename = fs.renameSync;
  try {
    const block = title => [{ id: 1, title, location: "src/pager.js:30" }];
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("real one") });
    await judgeSet("smoke", { judges: three, invoke: real, minFreeBytes: 0 });
    const [key] = Object.keys(mappingOf());
    enqueue("smoke", [{ kind: "finding", task: T01, keys: [key], reasons: ["sample"] }]);
    const { id } = readQueue("smoke").items.find(i => i.kind === "finding" && i.keys.includes(key));
    recordVerdict("smoke", id, { verdict: "real", match: ["B1"], evidence: evidenceFile(ctx) });
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("replaced") });
    await judgeSet("smoke", { judges: three, invoke: real, minFreeBytes: 0 });
    fs.renameSync = (from, to) => {
      if (path.basename(to) === "queue.json") throw Object.assign(new Error("invented EIO"), { code: "EIO" });
      return rename(from, to);
    };
    assert.throws(() => syncAuditQueue("smoke"), /invented EIO/);
    fs.renameSync = rename;
    syncAuditQueue("smoke");
    assert.equal(readQueue("smoke").items.find(i => i.id === id).status, "open");
  } finally {
    fs.renameSync = rename;
    ctx.restore();
  }
});

test("a replaced attempt's pooled-bug credit and re-checks are redone: the pooled bug is re-checked again", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    const block = title => [{ id: 1, title, location: "src/pager.js:30" }];
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("extra") });
    fakeRun({ reviewer: "claude", task: T01, kind: "buggy", blocks: block("same extra") });
    const rule = (f => (["extra", "same extra"].includes(f.title) ? { valid: "real", matches: [] } : { valid: "not_real", matches: [] }));
    await judgeSet("smoke", { judges: three, invoke: ruleInvoke(rule), minFreeBytes: 0 });
    const mapping = mappingOf();
    const keyOf = rev => Object.keys(mapping).find(k => mapping[k].reviewer === rev);
    // both are candidates; one group, audited real: P1, credited to both
    await poolSet("smoke", { judges: three, invoke: async () => ({ status: "completed", text: JSON.stringify({ groups: [{ findings: ["F1", "F2"], file: "src/pager.js", lines: [30, 31], severity: "medium", summary: "invented" }] }) }) });
    recordVerdict("smoke", readQueue("smoke").items.find(i => i.kind === "pool").id, { verdict: "real", evidence: evidenceFile(ctx) });
    await poolSet("smoke", { judges: three, invoke: async () => assert.fail("no other finding to re-check") });
    let vs = resolveFindings("smoke").verdicts;
    assert.deepEqual([vs[keyOf("codex")].matches, vs[keyOf("claude")].matches], [["P1"], ["P1"]]);

    // claude's attempt is replaced by a false alarm under the same key
    fakeRun({ reviewer: "claude", task: T01, kind: "buggy", blocks: block("unrelated") });
    await judgeSet("smoke", { judges: three, invoke: ruleInvoke(rule), minFreeBytes: 0 });
    syncAuditQueue("smoke");
    const pool = JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "pool.json"), "utf8"));
    assert.deepEqual([pool.bugs[0].rechecked, pool.bugs[0].keys], [false, [keyOf("codex")]]);
    vs = resolveFindings("smoke").verdicts;
    assert.deepEqual([vs[keyOf("codex")].matches, vs[keyOf("claude")].matches, vs[keyOf("claude")].valid], [["P1"], [], "not_real"]);
    // the re-check now covers the replaced finding
    const out = await poolSet("smoke", { judges: three, invoke: ruleInvoke(f => (f.title === "unrelated" ? { valid: "not_real", matches: [] } : { valid: "real", matches: ["P1"] })) });
    assert.deepEqual(out.rechecked.map(r => [r.id, r.checked, r.matched]), [["P1", 1, 0]]);
    assert.deepEqual(resolveFindings("smoke").verdicts[keyOf("claude")].matches, []);
  } finally {
    ctx.restore();
  }
});

test("a pooled finding replaced by a different real defect is a pool candidate again", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    const block = title => [{ id: 1, title, location: "src/pager.js:30" }];
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("extra") });
    const allReal = ruleInvoke(() => ({ valid: "real", matches: [] }));
    await judgeSet("smoke", { judges: three, invoke: allReal, minFreeBytes: 0 });
    await poolSet("smoke", { judges: three, invoke: async () => assert.fail("one candidate needs no helper") });
    const item = readQueue("smoke").items.find(i => i.kind === "pool");
    recordVerdict("smoke", item.id, { verdict: "real", evidence: evidenceFile(ctx) });
    await poolSet("smoke", { judges: three, invoke: async () => assert.fail("no other finding to re-check") });
    const [key] = Object.keys(mappingOf());
    assert.deepEqual(resolveFindings("smoke").verdicts[key].matches, ["P1"]);

    // the attempt is replaced: same key, another real defect that matches nothing known
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("another defect") });
    await judgeSet("smoke", { judges: three, invoke: allReal, minFreeBytes: 0 });
    syncAuditQueue("smoke");
    const old = readQueue("smoke").items.find(i => i.id === item.id);
    assert.deepEqual([old.keys, old.stale_keys], [[], [key]]);
    const out = await poolSet("smoke", { judges: three, invoke: ruleInvoke(() => ({ valid: "real", matches: [] })) });
    assert.equal(out.candidates, 1, "the new defect is pooled again");
    assert.equal(readQueue("smoke").items.filter(i => i.kind === "pool" && i.status === "open" && i.keys.includes(key)).length, 1);
  } finally {
    ctx.restore();
  }
});

test("scoring refuses findings collected before an archive was replaced", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    const block = title => [{ id: 1, title, location: "src/pager.js:30" }];
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("old real") });
    await judgeSet("smoke", { judges: three, invoke: real, minFreeBytes: 0 });
    scoreSet("smoke");
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("new false alarm") });
    assert.throws(() => scoreSet("smoke"), /changed since they were collected.*crb judge --set smoke/);
    await judgeSet("smoke", { judges: three, invoke: ruleInvoke(() => ({ valid: "not_real", matches: [] })), minFreeBytes: 0 });
    const row = JSON.parse(fs.readFileSync(scoreSet("smoke").file, "utf8").trim());
    assert.deepEqual([row.valid, row.bugs_found], [0, []]);
  } finally {
    ctx.restore();
  }
});

test("an interrupted refresh finishes on the next pass: a replaced pooled finding still leaves its pool item", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  const rename = fs.renameSync;
  try {
    const block = title => [{ id: 1, title, location: "src/pager.js:30" }];
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("extra") });
    const allReal = ruleInvoke(() => ({ valid: "real", matches: [] }));
    await judgeSet("smoke", { judges: three, invoke: allReal, minFreeBytes: 0 });
    await poolSet("smoke", { judges: three, invoke: async () => assert.fail("one candidate needs no helper") });
    const item = readQueue("smoke").items.find(i => i.kind === "pool");
    recordVerdict("smoke", item.id, { verdict: "real", evidence: evidenceFile(ctx) });
    await poolSet("smoke", { judges: three, invoke: async () => assert.fail("no other finding to re-check") });
    const [key] = Object.keys(mappingOf());

    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: block("another defect") });
    await judgeSet("smoke", { judges: three, invoke: allReal, minFreeBytes: 0 });
    // the refresh writes the audit record, then fails publishing queue.json
    fs.renameSync = (from, to) => {
      if (path.basename(to) === "queue.json") throw Object.assign(new Error("invented EIO"), { code: "EIO" });
      return rename(from, to);
    };
    assert.throws(() => syncAuditQueue("smoke"), /invented EIO/);
    fs.renameSync = rename;
    syncAuditQueue("smoke");
    const old = readQueue("smoke").items.find(i => i.id === item.id);
    assert.deepEqual([old.keys, old.stale_keys], [[], [key]]);
    const pool = JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "pool.json"), "utf8"));
    assert.deepEqual([pool.bugs[0].keys, pool.bugs[0].rechecked], [[], false]);
    const out = await poolSet("smoke", { judges: three, invoke: ruleInvoke(() => ({ valid: "real", matches: [] })) });
    assert.equal(out.candidates, 1, "the new defect is pooled again");
  } finally {
    fs.renameSync = rename;
    ctx.restore();
  }
});
