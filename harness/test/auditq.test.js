// The audit queue: what it takes in, what the auditor sees, and how a recorded verdict counts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { e2eSetup, fakeRun } from "./helpers.js";
import { ruleInvoke } from "./grading-helpers.js";
import { judgeSet } from "../lib/grade/judge.js";
import { syncAuditQueue, readQueue, nextItem, showItem, recordVerdict, queueStatus, cohenKappa } from "../lib/grade/auditq.js";
import { scoreSet } from "../lib/grade/score.js";

const T01 = "pager-js-T01";

test("cohenKappa", () => {
  assert.equal(cohenKappa([]), null);
  assert.equal(cohenKappa([["real", "real"], ["real", "real"]]), 1);
  assert.equal(cohenKappa([["real", "real"], ["not_real", "not_real"]]), 1);
  assert.equal(cohenKappa([["real", "not_real"], ["not_real", "real"]]), -1);
  assert.ok(Math.abs(cohenKappa([["real", "real"], ["real", "not_real"], ["not_real", "not_real"], ["not_real", "not_real"]]) - 0.5) < 1e-9);
});

test("the queue takes unsettled findings and a 20% sample per reviewer; the auditor sees neither reviewer nor votes", { timeout: 60_000 }, async () => {
  const ctx = e2eSetup();
  try {
    const blocks = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `finding ${i + 1}`, location: `src/pager.js:${6 + i}` }));
    fakeRun({ reviewer: "codex", task: T01, kind: "buggy", blocks: blocks(6) });
    fakeRun({ reviewer: "claude", task: T01, kind: "buggy", blocks: blocks(2) });
    // "finding 1" is uncertain: an audit item for each reviewer that reported it
    await judgeSet("smoke", { invoke: ruleInvoke(f => (f.title === "finding 1" ? { valid: "uncertain", matches: [] } : { valid: "real", matches: ["B1"] })), minFreeBytes: 0 });
    syncAuditQueue("smoke");
    const q = readQueue("smoke");
    const mapping = JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "mapping.json"), "utf8"));
    const sampled = q.items.filter(i => i.reasons.includes("sample")).map(i => mapping[i.keys[0]].reviewer).sort();
    assert.deepEqual(sampled, ["claude", "codex", "codex"]); // ceil(20% of 2), ceil(20% of 6)
    assert.equal(q.items.filter(i => i.reasons.includes("uncertain")).length, 2);
    // syncing again adds nothing
    syncAuditQueue("smoke");
    assert.equal(readQueue("smoke").items.length, q.items.length);

    const item = await nextItem("smoke", { workspace: false });
    const shown = JSON.stringify(item);
    for (const leak of ["codex", "claude", "votes", "judges", "smoke/A", "#r1#", "uncertain\":"]) assert.ok(!shown.includes(leak), `${leak} shown to the auditor`);
    assert.equal(item.findings.length, 1);
    assert.equal(item.task.bugs[0].id, "B1");

    // any open item by id, so several auditors can work in parallel; the same blind packet as `next`
    assert.deepEqual(await showItem("smoke", item.item, { workspace: false }), item);
    const last = q.items.at(-1);
    const later = await showItem("smoke", last.id, { workspace: false });
    assert.equal(later.item, last.id);
    assert.deepEqual(later.findings.map(f => f.fid), JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "grading", "smoke", "findings.json"), "utf8")).tasks[T01].findings.filter(f => last.keys.includes(f.key)).map(f => f.fid));
    for (const leak of ["codex", "claude", "votes", "judges", "smoke/A", "#r1#"]) assert.ok(!JSON.stringify(later).includes(leak), `${leak} shown to the auditor`);
    await assert.rejects(showItem("smoke", "A999", { workspace: false }), /no audit item A999/);

    // the auditor overrides the panel; the run's score follows
    const uncertainCodex = q.items.find(i => i.reasons.includes("uncertain") && mapping[i.keys[0]].reviewer === "codex");
    const evidence = path.join(ctx.root, "e.md");
    fs.writeFileSync(evidence, "invented argument");
    assert.throws(() => recordVerdict("smoke", uncertainCodex.id, { verdict: "real", match: ["B7"], evidence }), /not a bug, decoy or pooled bug/);
    recordVerdict("smoke", uncertainCodex.id, { verdict: "not_real", evidence });
    assert.throws(() => recordVerdict("smoke", uncertainCodex.id, { verdict: "real", evidence }), /already recorded/);
    const st = queueStatus("smoke");
    assert.equal(st.done, 1);
    assert.equal(st.open, q.items.length - 1);
    const row = fs.readFileSync(scoreSet("smoke").file, "utf8").trim().split("\n").map(l => JSON.parse(l)).find(r => r.reviewer === "codex");
    assert.equal(row.findings, 6);
    assert.equal(row.valid, 5);
    assert.equal(row.provisional, true); // codex's sampled findings are still open
  } finally {
    ctx.restore();
  }
});
