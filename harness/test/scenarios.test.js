import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadTask } from "../lib/task.js";
import { scenarioFor, buildReply, parseLocations, overlaps, sameFile, patchLines, SESSION_CONTEXT_OTHERS } from "../lib/scenarios.js";
import { planRuns, runBatch, executeRun, decide } from "../lib/scheduler.js";
import { listRuns } from "../lib/store.js";
import { FX, e2eSetup } from "./helpers.js";

const T = id => loadTask(path.join(FX, "tasks/pager-js", id), { corpus: FX });
const issue = (id, location, title = `Finding ${id}`) => ({ id, prefix: "ISSUE", title, location });
const section = (input, name) => input.split(`## ${name}\n`)[1].split("\n## ")[0].trim();

test("scenario by run index and task kind", () => {
  const buggy = T("pager-js-T01");
  assert.deepEqual([1, 2, 3, 4].map(n => scenarioFor(buggy, n)), ["B1", "B2", "B3", null]);
  assert.deepEqual([1, 2, 3].map(n => scenarioFor(T("pager-js-T03"), n)), ["B4", "B4", "B4"]);
  assert.equal(scenarioFor(T("pager-js-T02"), 1), null);
  assert.equal(scenarioFor({ ...buggy, kind: "realbug" }, 1), null);
});

test("locations are read in the forms reviewers write them", () => {
  const at = loc => parseLocations({ location: loc }).map(l => `${l.file}:${l.start}-${l.end}`);
  assert.deepEqual(at("`src/pager.js:10-13`"), ["src/pager.js:10-13"]);
  assert.deepEqual(at("src/pager.js:6"), ["src/pager.js:6-6"]);
  assert.deepEqual(at("src/pager.js lines 6–8"), ["src/pager.js:6-8"]);
  assert.deepEqual(at("src/pager.js#L6-L8"), ["src/pager.js:6-8"]);
  assert.deepEqual(at("src/pager.js:6, 13"), ["src/pager.js:6-6", "src/pager.js:13-13"]);
  assert.deepEqual(at("test/pager.test.js:9; src/pager.js:13"), ["test/pager.test.js:9-9", "src/pager.js:13-13"]);
  assert.deepEqual(at("/private/tmp/crw/0a1b2c3d/pager-js/src/pager.js:12"), ["/private/tmp/crw/0a1b2c3d/pager-js/src/pager.js:12-12"]);
  assert.deepEqual(at("src/pager.js (pageCount)"), [], "a file without lines names nothing");
  assert.deepEqual(parseLocations({ location: "lines 6-8", file: "src/pager.js" }).map(l => [l.file, l.start, l.end]), [["src/pager.js", 6, 8]]);
  assert.deepEqual(at("src/pager.js (in Pager.paginate, lines 6-8)"), ["src/pager.js:6-8"], "a Class.method name is not a file");
  // agy writes markdown links: the link's path keeps its directories, the lines come from the anchor, the label or after the link
  const url = "file:///tmp/crw/0a1b2c3d/ledger-ts/src/api/transfers.ts";
  assert.deepEqual(at(`[transfers.ts:10-15](${url}#L10-L15)`), ["/tmp/crw/0a1b2c3d/ledger-ts/src/api/transfers.ts:10-15"]);
  assert.deepEqual(at(`[transfers.ts:10-15](${url})`), ["/tmp/crw/0a1b2c3d/ledger-ts/src/api/transfers.ts:10-15"]);
  assert.deepEqual(at(`[transfers.ts](${url}):6-8`), ["/tmp/crw/0a1b2c3d/ledger-ts/src/api/transfers.ts:6-8"]);
  assert.deepEqual(at(`[transfers.ts](${url}) lines 6-8`), ["/tmp/crw/0a1b2c3d/ledger-ts/src/api/transfers.ts:6-8"]);
  assert.deepEqual(at("[docs](https://example.com/guide) src/a.go:3"), ["src/a.go:3-3"], "a web link is no location");
  assert.ok(!overlaps(issue(1, `[transfers.ts:10-15](${url}#L10-L15)`), { file: "src/domain/transfers.ts", lines: [12, 12] }), "same basename, other directory");
  assert.ok(overlaps(issue(1, `[transfers.ts:10-15](${url}#L10-L15)`), { file: "src/api/transfers.ts", lines: [12, 12] }));
  assert.ok(sameFile("/private/tmp/crw/0a1b2c3d/pager-js/src/pager.js", "src/pager.js"));
  assert.ok(sameFile("pager.js", "src/pager.js"));
  assert.ok(!sameFile("lib/pager.js", "src/pager.js"));
  assert.ok(!sameFile("src/xpager.js", "src/pager.js"));
});

test("an issue overlaps a bug in the same file within ±5 lines, never in another file", () => {
  const bug = { file: "src/pager.js", lines: [6, 6] };
  assert.ok(overlaps(issue(1, "src/pager.js:11"), bug));
  assert.ok(overlaps(issue(1, "src/pager.js:1"), bug));
  assert.ok(!overlaps(issue(1, "src/pager.js:12"), bug));
  assert.ok(!overlaps(issue(1, "src/pager.js:0"), bug), "line 0 is no line");
  assert.ok(overlaps(issue(1, "src/pager.js:12-20"), { file: "src/pager.js", lines: [13, 13] }));
  assert.ok(!overlaps(issue(1, "test/pager.test.js:6"), bug));
  assert.ok(!overlaps(issue(1, "src/pager.js"), bug));
});

test("B1 fixes only the bugs some issue overlaps, and lists every overlapping issue with the fix's lines", () => {
  const task = T("pager-js-T01");
  const blocks = [issue(1, "test/pager.test.js:9"), issue(2, "`src/pager.js:13`", "Partial last page dropped"), issue(3, "src/pager.js:14")];
  const r = buildReply("B1", blocks, task);
  assert.equal(r.status, "run");
  assert.deepEqual([r.fixed_bugs, r.patches, r.issues, r.disputed], [["B2"], ["fix-B2.patch"], [2, 3], []]);
  assert.equal(section(r.input, "FIXED_ITEMS"), "ISSUE-2: Partial last page dropped — fixed in src/pager.js:13\nISSUE-3: Finding 3 — fixed in src/pager.js:13");
  assert.equal(section(r.input, "DISPUTED_ITEMS"), "None");
  assert.equal(section(r.input, "SESSION_CONTEXT"), SESSION_CONTEXT_OTHERS);
  // the reviewer gets the same output format as round 1, and no answer-key words
  assert.match(r.input, /## OUTPUT_FORMAT\n[\s\S]*ISSUE-/);
  assert.doesNotMatch(r.input, /fix-B2|patch|hidden|B2\b/);
  // both bugs flagged: both fixed, in bug order
  const both = buildReply("B1", [issue(1, "src/pager.js:13"), issue(2, "src/pager.js:6")], task);
  assert.deepEqual([both.fixed_bugs, both.patches], [["B1", "B2"], ["fix-B1.patch", "fix-B2.patch"]]);
  assert.equal(section(both.input, "SESSION_CONTEXT"), "None beyond the request", "every issue was addressed");
});

test("B2 applies the wrong fixes and says they are fixed at the wrong fix's lines", () => {
  const r = buildReply("B2", [issue(4, "src/pager.js:6")], T("pager-js-T01"));
  assert.deepEqual([r.status, r.fixed_bugs, r.patches], ["run", ["B1"], ["wrongfix-B1.patch"]]);
  assert.equal(section(r.input, "FIXED_ITEMS"), "ISSUE-4: Finding 4 — fixed in src/pager.js:6");
});

test("patch lines come from the patch's added lines", () => {
  const p = "--- a/src/x.js\n+++ b/src/x.js\n@@ -1,3 +1,4 @@\n a\n+b\n+c\n d\n@@ -10,2 +11,2 @@\n e\n-f\n+g\n";
  assert.equal(patchLines(p), "src/x.js:2-3, 12");
});

test("B3 disputes every issue on the first flagged bug with its false rebuttal, not ISSUE-1", () => {
  const task = T("pager-js-T01");
  const blocks = [issue(1, "test/pager.test.js:6"), issue(2, "src/pager.js:40"), issue(4, "src/pager.js:6"), issue(3, "src/pager.js:7", "Zero page")];
  const r = buildReply("B3", blocks, task);
  assert.deepEqual([r.status, r.issues, r.disputed, r.patches], ["run", [3, 4], ["B1"], []]);
  assert.equal(section(r.input, "DISPUTED_ITEMS"), `ISSUE-3: Zero page — ${task.bugs[0].false_rebuttal}\nISSUE-4: Finding 4 — ${task.bugs[0].false_rebuttal}`);
  assert.equal(section(r.input, "FIXED_ITEMS"), "No issues fixed this round");
  // B1 missed, B2 flagged: B2 is disputed with its own rebuttal
  const only2 = buildReply("B3", [issue(1, "src/pager.js:13")], task);
  assert.deepEqual(only2.disputed, ["B2"]);
  assert.match(section(only2.input, "DISPUTED_ITEMS"), /counts only full pages/);
  // a duplicate on the same bug is disputed too; an issue on the other bug stays open
  const dup = buildReply("B3", [issue(5, "src/pager.js:8", "Page zero again"), issue(2, "src/pager.js:6", "Zero page"), issue(3, "src/pager.js:13")], task);
  assert.deepEqual([dup.issues, dup.disputed], [[2, 5], ["B1"]]);
  assert.equal(section(dup.input, "DISPUTED_ITEMS"), `ISSUE-2: Zero page — ${task.bugs[0].false_rebuttal}\nISSUE-5: Page zero again — ${task.bugs[0].false_rebuttal}`);
  assert.equal(section(dup.input, "SESSION_CONTEXT"), SESSION_CONTEXT_OTHERS);
});

test("B4 concedes nothing: the decoy's issue is disputed with the valid rebuttal", () => {
  const task = T("pager-js-T03");
  const r = buildReply("B4", [issue(1, "src/pager.js:30"), issue(2, "src/pager.js:12", "Off by one in last")], task);
  assert.deepEqual([r.status, r.disputed, r.issues], ["run", ["D1"], [2]]);
  assert.equal(section(r.input, "DISPUTED_ITEMS"), `ISSUE-2: Off by one in last — ${task.decoys[0].valid_rebuttal}`);
  const dup = buildReply("B4", [issue(1, "src/pager.js:12", "Off by one"), issue(2, "src/pager.js:14", "Last page short")], task);
  assert.deepEqual([dup.issues, section(dup.input, "SESSION_CONTEXT")], [[1, 2], "None beyond the request"]);
});

test("no overlapping issue: n/a for every scenario, so a reviewer that missed the bug gets no round 2", () => {
  const elsewhere = [issue(1, "test/pager.test.js:6"), issue(2, "src/pager.js")];
  for (const s of ["B1", "B2", "B3"]) {
    const r = buildReply(s, elsewhere, T("pager-js-T01"));
    assert.deepEqual([r.status, r.patches, r.input], ["n/a", [], undefined], s);
  }
  assert.equal(buildReply("B4", [issue(1, "src/pager.js:1")], T("pager-js-T03")).status, "n/a");
  assert.equal(buildReply("B1", [], T("pager-js-T01")).status, "n/a");
});

test("round 1 is archived before the answer patches touch the workspace; round 2 sees the fix", { timeout: 300_000 }, async () => {
  const ctx = e2eSetup();
  try {
    const t01 = ctx.task("pager-js-T01");
    const s = await runBatch(planRuns({ set: "smoke", config: "high", reviewers: ["codex"], tasks: [t01], n: 3 }), { minFreeBytes: 0 });
    assert.equal(s.done, 3);
    const runs = Object.fromEntries(listRuns("smoke").map(r => [r.n, r]));
    for (const n of [1, 2]) {
      const r = runs[n];
      const tb = r.track_b;
      assert.deepEqual([tb.scenario, tb.status, tb.fixed_bugs, tb.class], [n === 1 ? "B1" : "B2", "run", ["B1"], "ok"]);
      const r1 = path.join(r.archive, "round1");
      assert.ok(r.round1_archived_ms <= tb.patched_ms);
      assert.ok(fs.statSync(path.join(r1, "wait.json")).mtimeMs <= tb.patched_ms, "round1/ was written before the patches");
      assert.ok(fs.statSync(path.join(r1, "workspace.diff")).mtimeMs <= tb.patched_ms);
      const d1 = fs.readFileSync(path.join(r1, "workspace.diff"), "utf8");
      const d2 = fs.readFileSync(path.join(r.archive, "round2", "workspace.diff"), "utf8");
      assert.match(d1, /page < 0\)/);
      assert.doesNotMatch(d1, /page < 1|Object\.is/);
      assert.match(d2, n === 1 ? /page < 1\)/ : /Object\.is\(page, -0\)/);
      assert.match(fs.readFileSync(path.join(r.archive, "round2", "input.md"), "utf8"), /ISSUE-1: Page zero is accepted — fixed in src\/pager\.js:6/);
      assert.ok(fs.existsSync(path.join(r1, "session", "state.json")));
    }
    assert.deepEqual([runs[3].track_b.scenario, runs[3].track_b.disputed, runs[3].track_b.patches], ["B3", ["B1"], []]);
    // the reviewer's second turn resumed the thread with the scripted reply
    const second = ctx.log("codex").filter(c => c.args.includes("resume"));
    assert.equal(second.length, 3);
    assert.ok(second.some(c => c.prompt.includes(t01.bugs[0].false_rebuttal)));
    assert.ok(second.every(c => c.prompt.includes("## Issues Fixed") && !/fix-B|wrongfix|hidden/.test(c.prompt)));
    // config max has no round 2
    const max = await runBatch(planRuns({ set: "pilot", config: "max", reviewers: ["codex"], tasks: [t01], n: 1 }), { minFreeBytes: 0 });
    assert.equal(max.done, 1);
    const [m] = listRuns("pilot");
    assert.equal(m.track_b, undefined);
    assert.ok(fs.existsSync(path.join(m.archive, "round1", "wait.json")));
    assert.ok(!fs.existsSync(path.join(m.archive, "round2")));
    // the round-1 staging is cleaned up
    assert.deepEqual(fs.readdirSync(path.join(ctx.env.CRB_HOME, "runs", ".staging")), []);
  } finally {
    ctx.restore();
  }
});

test("a usage limit in round 2 retries the whole run, never scored", { timeout: 300_000 }, async () => {
  const ctx = e2eSetup();
  try {
    // a codex that hits its usage limit on the first round-2 prompt it sees
    const real = path.join(ctx.root, "realbin");
    fs.mkdirSync(real);
    fs.renameSync(path.join(ctx.bin, "codex"), path.join(real, "codex"));
    const marker = path.join(ctx.root, "failed-once");
    fs.writeFileSync(path.join(ctx.bin, "codex"), `#!/bin/sh
input=$(cat)
case "$input" in *"## Issues Fixed"*) [ -e "${marker}" ] || { : > "${marker}"; export FAKE_CODEX_FAIL="You've hit your usage limit. Try again later."; } ;; esac
printf '%s' "$input" | exec "${real}/codex" "$@"
`, { mode: 0o755 });
    const events = [];
    const s = await runBatch(planRuns({ set: "smoke", config: "high", reviewers: ["codex"], tasks: [ctx.task("pager-js-T01")], n: 1 }), {
      minFreeBytes: 0, retry: { infraDelayMs: 10, usageBaseMs: 10, usageMaxMs: 40 }, onEvent: e => events.push(e),
    });
    assert.deepEqual([s.done, s.infra_failures, s.reviewer_failures], [1, 1, 0]);
    assert.deepEqual(events.filter(e => e.type === "end").map(e => [e.result.class, e.result.reason, e.decision]), [["infra", "usage_limit", "retry_usage"], ["ok", "revise", "final"]]);
    const [r] = listRuns("smoke");
    assert.deepEqual([r.class, r.attempt, r.track_b.class, r.track_b.scenario], ["ok", 2, "ok", "B1"]);
  } finally {
    ctx.restore();
  }
});

/** Put a shell wrapper before the fake codex; `body` runs with the prompt in $input, then hands over. */
function wrapCodex(ctx, body) {
  const real = path.join(ctx.root, "realbin");
  fs.mkdirSync(real);
  fs.renameSync(path.join(ctx.bin, "codex"), path.join(real, "codex"));
  fs.writeFileSync(path.join(ctx.bin, "codex"), `#!/bin/sh
input=$(cat)
${body}
printf '%s' "$input" | exec "${real}/codex" "$@"
`, { mode: 0o755 });
}

test("round 2 is classified with the reviewer's stderr for round 2: a usage limit said only there pauses the queue", { timeout: 300_000 }, async () => {
  const ctx = e2eSetup();
  try {
    const marker = path.join(ctx.root, "failed-once");
    wrapCodex(ctx, `case "$input" in *"## Issues Fixed"*) [ -e "${marker}" ] || { : > "${marker}"; echo "You've hit your usage limit. Try again later." >&2; export FAKE_CODEX_FAIL="turn aborted"; } ;; esac`);
    const events = [];
    const s = await runBatch(planRuns({ set: "smoke", config: "high", reviewers: ["codex"], tasks: [ctx.task("pager-js-T01")], n: 1 }), {
      minFreeBytes: 0, retry: { infraDelayMs: 10, usageBaseMs: 10, usageMaxMs: 40 }, onEvent: e => events.push(e),
    });
    assert.deepEqual(events.filter(e => e.type === "end").map(e => [e.result.class, e.result.reason, e.decision]), [["infra", "usage_limit", "retry_usage"], ["ok", "revise", "final"]]);
    assert.equal(s.done, 1);
  } finally {
    ctx.restore();
  }
});

test("a final run reports round 1's class to the batch, as run.json does: a round 2 past its deadline is no reviewer failure of round 1", { timeout: 300_000 }, async () => {
  const ctx = e2eSetup();
  try {
    wrapCodex(ctx, `case "$input" in *"## Issues Fixed"*) export FAKE_CODEX_SLOW_MS=60000 ;; esac`);
    const retry = { infraDelayMs: 10, usageBaseMs: 10, usageMaxMs: 40, infraRetries: 3, reviewerRetries: 1 };
    const events = [];
    const s = await runBatch(planRuns({ set: "smoke", config: "high", reviewers: ["codex"], tasks: [ctx.task("pager-js-T01")], n: 1 }), {
      minFreeBytes: 0, retry, onEvent: e => events.push(e),
      execute: (spec, counters) => executeRun(spec, counters, { timeoutS: 4, decisionFor: r => decide(r, counters, retry) }),
    });
    assert.deepEqual(events.filter(e => e.type === "end").map(e => [e.result.class, e.decision]), [["reviewer_timeout", "retry_reviewer"], ["ok", "final"]]);
    assert.deepEqual([s.done, s.reviewer_failures], [1, 0]);
    const [r] = listRuns("smoke");
    assert.deepEqual([r.class, r.track_b.class], ["ok", "reviewer_timeout"]);
  } finally {
    ctx.restore();
  }
});
