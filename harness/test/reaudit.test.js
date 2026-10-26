import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reauditSet, restoreUnflagged } from "../lib/reaudit.js";
import { archive, runPath, flaggedPath, supersededPath, flaggedAttempts, isDone, readRun } from "../lib/store.js";

// Invented runs: nothing but run.json, audit.json and the session's event log.
const codexCmd = command => JSON.stringify({ type: "item.completed", item: { id: "i", type: "command_execution", command: `/bin/zsh -lc ${JSON.stringify(command)}`, exit_code: 0, status: "completed" } });

function withBench(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-reaudit-"));
  const saved = process.env.CRB_HOME;
  process.env.CRB_HOME = path.join(dir, "crbhome");
  return Promise.resolve().then(() => fn(dir)).finally(() => {
    if (saved === undefined) delete process.env.CRB_HOME; else process.env.CRB_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function addRun(task, hex, command, extra = {}) {
  const id = `final/A/high/codex/${task}/1`;
  const runDir = `/tmp/crw-reaudit-test/${hex}`;
  const record = { id, set: "final", track: "A", config: "high", reviewer: "codex", task, repo: "pager-js", kind: "buggy", n: 1, hex,
    run_dir: runDir, run_root: "/tmp/crw-reaudit-test", real_home: "/Users/tester", workspace: `${runDir}/pager-js`, class: "ok", decision: "final", final: true, flagged: false, ...extra };
  archive(runPath(id), { files: {
    "run.json": JSON.stringify(record),
    "audit.json": JSON.stringify({ flagged: false, hits: [], checked: 1, unparsed: 0 }),
    "session/output.jsonl": codexCmd(command) + "\n",
  } });
  return id;
}

test("a re-audit reports runs the current rules flag and, asked to, sends them back to be run again", () => withBench(async (dir) => {
  const corpus = path.join(dir, "corpus");
  const host = "/var/folders/ab/cd/T";
  const clean = addRun("pager-js-T01", "aaaa1111", "git diff && npm test");
  const listed = addRun("pager-js-T02", "bbbb2222", "S=$(ls -td ${TMPDIR:-/tmp}/tmp.* | head -1) && cat $S/notes.md");
  const again = addRun("pager-js-T03", "cccc3333", "ls -la /private/tmp");
  // T03 was flagged once before: this flag is its second
  archive(flaggedPath(again, "dddd4444"), { files: { "run.json": "{}" } });
  // a run recorded with its own temp dir: $TMPDIR is the run's, so listing it is fine
  const own = addRun("pager-js-T04", "eeee5555", "ls -td $TMPDIR/tmp.*", { tmpdir: "/tmp/crw-reaudit-test/eeee5555/tmp" });

  const dry = reauditSet("final", { corpus, hostTmp: host });
  assert.deepEqual(dry.runs.map(r => r.id).sort(), [listed, again].sort());
  assert.deepEqual([dry.flagged, dry.requeued.length, dry.contaminated], [2, 0, 0]);
  assert.equal(isDone(listed), true, "a report alone moves nothing");
  assert.equal(JSON.parse(fs.readFileSync(path.join(runPath(listed), "audit.json"), "utf8")).hits[0].reason, "shared_tmp");

  const res = reauditSet("final", { corpus, hostTmp: host, requeue: true });
  assert.deepEqual(res.requeued, [listed]);
  assert.deepEqual(res.newly_contaminated, [again]);
  // the first flag: archived as a flagged attempt, so the batch runs it again with one flag spent
  assert.equal(fs.existsSync(runPath(listed)), false);
  const moved = JSON.parse(fs.readFileSync(path.join(flaggedPath(listed, "bbbb2222"), "run.json"), "utf8"));
  assert.deepEqual([moved.decision, moved.final, moved.flagged, typeof moved.reaudited_at], ["requeue_flagged", false, true, "string"]);
  assert.ok(fs.existsSync(path.join(flaggedPath(listed, "bbbb2222"), "session", "output.jsonl")));
  // the second flag: contaminated, final, and kept among the flagged attempts too
  assert.deepEqual([readRun(again).class, readRun(again).decision, readRun(again).final], ["contaminated", "contaminated", true]);
  assert.ok(fs.existsSync(path.join(flaggedPath(again, "cccc3333"), "run.json")));
  for (const id of [clean, own]) assert.equal(readRun(id).decision, "final");

  // nothing left to move; the contaminated run stays reported
  const after = reauditSet("final", { corpus, hostTmp: host, requeue: true });
  assert.deepEqual([after.requeued, after.newly_contaminated, after.contaminated], [[], [], 1]);
}));

test("a requeue that cannot move the archive leaves the run final, so its flag is never lost", () => withBench(async (dir) => {
  const id = addRun("pager-js-T02", "bbbb2222", "ls -la /tmp");
  const rename = fs.renameSync;
  fs.renameSync = (src, dst) => { if (src === runPath(id)) throw Object.assign(new Error("injected"), { code: "EIO" }); return rename(src, dst); };
  try {
    assert.throws(() => reauditSet("final", { corpus: path.join(dir, "corpus"), requeue: true }), /injected/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual([readRun(id).decision, readRun(id).final, isDone(id)], ["final", true, true]);
  // run again, it completes the move
  assert.deepEqual(reauditSet("final", { corpus: path.join(dir, "corpus"), requeue: true }).requeued, [id]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(flaggedPath(id, "bbbb2222"), "run.json"), "utf8")).decision, "requeue_flagged");
}));

test("a contaminated marking interrupted after its copy is finished by the next re-audit", () => withBench(async (dir) => {
  const id = addRun("pager-js-T03", "cccc3333", "ls -la /tmp");
  archive(flaggedPath(id, "dddd4444"), { files: { "run.json": "{}" } });
  // the copy into the flagged slot happened, the record update did not
  fs.cpSync(runPath(id), flaggedPath(id, "cccc3333"), { recursive: true });
  const res = reauditSet("final", { corpus: path.join(dir, "corpus"), requeue: true });
  assert.deepEqual([res.newly_contaminated, res.requeued], [[id], []]);
  assert.equal(readRun(id).class, "contaminated");
  assert.equal(JSON.parse(fs.readFileSync(path.join(flaggedPath(id, "cccc3333"), "run.json"), "utf8")).class, "contaminated");
}));

// Real-bug attempts for restoreUnflagged: the corpus names the upstream repository.
function realbugCorpus(dir, task) {
  const corpus = path.join(dir, "corpus");
  fs.mkdirSync(path.join(corpus, "realbugs", task), { recursive: true });
  fs.writeFileSync(path.join(corpus, "realbugs", task, "source.json"), JSON.stringify({ upstream: "https://github.com/acme/widget" }));
  return corpus;
}
const goProbe = "cat > probe_test.go <<'EOF'\npackage pager\nimport \"github.com/acme/widget/pager\"\nEOF\ngo test ./...";
const fetchFix = "curl -sL https://github.com/acme/widget/pull/9.diff";
const verdict = { status: "completed", review: { verdict: { status: "REVISE" }, blocks: [{}] } };

function attempt(dest, { id, task, hex, started, command, record = {}, wait = verdict }) {
  const runDir = `/tmp/crw-reaudit-test/${hex}`;
  archive(dest, { files: {
    "run.json": JSON.stringify({ id, set: "final", track: "A", config: "high", reviewer: "codex", task, repo: "realbugs", kind: "realbug", n: 1, hex,
      run_dir: runDir, run_root: "/tmp/crw-reaudit-test", real_home: "/Users/tester", workspace: `${runDir}/${task}`, started_at: started, class: "ok", reason: "revise", ...record }),
    "audit.json": JSON.stringify({ flagged: true, hits: [{ reason: "upstream" }] }),
    "wait.json": JSON.stringify(wait),
    "session/output.jsonl": codexCmd(command) + "\n",
  } });
}
const contaminated = { class: "contaminated", decision: "contaminated", final: true, flagged: true };
const requeued = { decision: "requeue_flagged", final: false, flagged: true };

test("after a narrowed rule, a run's first clean attempt becomes its result and later attempts are set aside", () => withBench(async (dir) => {
  const T = "rb-go-widget-1";
  const corpus = realbugCorpus(dir, T);
  const id = n => `final/A/high/codex/${T}/${n}`;
  const at = (n, k, hex, command, rec) => attempt(k === "archive" ? runPath(id(n)) : flaggedPath(id(n), hex), { id: id(n), task: T, hex, started: `2026-10-2${hex[0]}T00:00:00Z`, command, record: rec });
  // 1: both flags were an import path → the first attempt is the result
  at(1, "slot", "1aaaaaaa", goProbe, requeued); at(1, "archive", "2aaaaaaa", goProbe, contaminated); at(1, "slot", "2aaaaaaa", goProbe, contaminated);
  // 2: a real flag, then an import path → the second attempt (the archive) is the result, one flag stands
  at(2, "slot", "1bbbbbbb", fetchFix, requeued); at(2, "archive", "2bbbbbbb", goProbe, contaminated); at(2, "slot", "2bbbbbbb", goProbe, contaminated);
  // 3: a final run whose earlier flag was an import path → the earlier attempt is the result
  at(3, "slot", "1ccccccc", goProbe, requeued); at(3, "archive", "2ccccccc", "git diff", { decision: "final", final: true, flagged: false });
  // 4: two real flags stay contaminated
  at(4, "slot", "1ddddddd", fetchFix, requeued); at(4, "archive", "2ddddddd", fetchFix, contaminated); at(4, "slot", "2ddddddd", fetchFix, contaminated);
  // 5: the clean attempt timed out: the scheduler would have retried it, so it is only reported
  attempt(flaggedPath(id(5), "1eeeeeee"), { id: id(5), task: T, hex: "1eeeeeee", started: "2026-10-21T00:00:00Z", command: goProbe, record: requeued, wait: { status: "timeout" } });
  at(5, "archive", "2eeeeeee", fetchFix, { decision: "final", final: true, flagged: false });

  const dry = restoreUnflagged("final", { corpus });
  assert.deepEqual(dry.restored.map(x => [x.id, x.to]), [[id(1), "1aaaaaaa"], [id(2), "2bbbbbbb"], [id(3), "1ccccccc"]]);
  assert.deepEqual(dry.needs_rerun, [id(5)]);
  assert.equal(readRun(id(1)).hex, "2aaaaaaa", "a dry run moves nothing");

  restoreUnflagged("final", { corpus, apply: true });
  const r1 = readRun(id(1));
  assert.deepEqual([r1.hex, r1.class, r1.decision, r1.final, r1.flagged], ["1aaaaaaa", "ok", "final", true, false]);
  assert.equal(flaggedAttempts(id(1)), 0);
  assert.ok(fs.existsSync(path.join(supersededPath(id(1), "2aaaaaaa"), "session", "output.jsonl")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(runPath(id(1)), "audit.json"), "utf8")).flagged, false);
  const r2 = readRun(id(2));
  assert.deepEqual([r2.hex, r2.class, r2.reason, r2.decision], ["2bbbbbbb", "ok", "revise", "final"]);
  assert.equal(flaggedAttempts(id(2)), 1, "the real flag still counts");
  assert.deepEqual([readRun(id(3)).hex, fs.existsSync(supersededPath(id(3), "2ccccccc"))], ["1ccccccc", true]);
  assert.deepEqual([readRun(id(4)).class, flaggedAttempts(id(4))], ["contaminated", 2]);
  assert.equal(readRun(id(5)).hex, "2eeeeeee");
  // nothing left to restore
  assert.deepEqual(restoreUnflagged("final", { corpus, apply: true }).restored, []);
}));

test("a run requeued but not yet rerun is restored, and an interrupted restore is finished by the next one", () => withBench(async (dir) => {
  const T = "rb-go-widget-2";
  const corpus = realbugCorpus(dir, T);
  const id = n => `final/A/high/codex/${T}/${n}`;
  // 1: its only attempt was flagged for an import path and sits in its slot, with no archive
  attempt(flaggedPath(id(1), "1fffffff"), { id: id(1), task: T, hex: "1fffffff", started: "2026-10-21T00:00:00Z", command: goProbe, record: requeued });
  // 2: a final run whose earlier flag was an import path
  attempt(flaggedPath(id(2), "1abcdef0"), { id: id(2), task: T, hex: "1abcdef0", started: "2026-10-21T00:00:00Z", command: goProbe, record: requeued });
  attempt(runPath(id(2)), { id: id(2), task: T, hex: "2abcdef0", started: "2026-10-22T00:00:00Z", command: "git diff", record: { decision: "final", final: true, flagged: false } });

  const dry = restoreUnflagged("final", { corpus });
  assert.deepEqual(dry.restored.map(x => [x.id, x.from, x.to]), [[id(1), null, "1fffffff"], [id(2), "2abcdef0", "1abcdef0"]]);

  // the move into the archive fails after the later attempt left: the run has no archive for a moment
  const rename = fs.renameSync;
  fs.renameSync = (src, dst) => { if (dst === runPath(id(2))) throw Object.assign(new Error("injected"), { code: "EIO" }); return rename(src, dst); };
  try {
    assert.throws(() => restoreUnflagged("final", { corpus, apply: true }), /injected/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(runPath(id(2))), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(flaggedPath(id(2), "1abcdef0"), "run.json"), "utf8")).final, true,
    "the result's records are written before it moves");

  // the next restore picks up the slot-only run and completes
  const again = restoreUnflagged("final", { corpus, apply: true });
  assert.deepEqual(again.restored.map(x => x.id), [id(2)]);
  for (const [n, hex] of [[1, "1fffffff"], [2, "1abcdef0"]]) {
    const r = readRun(id(n));
    assert.deepEqual([r.hex, r.class, r.decision, r.final, r.flagged], [hex, "ok", "final", true, false]);
    assert.equal(flaggedAttempts(id(n)), 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runPath(id(n)), "audit.json"), "utf8")).flagged, false);
  }
  assert.ok(fs.existsSync(supersededPath(id(2), "2abcdef0")));
  assert.deepEqual(restoreUnflagged("final", { corpus, apply: true }).restored, []);
}));
