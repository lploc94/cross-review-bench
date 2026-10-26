// Pilot blinding (I8): reviewer names never reach the pilot measurements or the blinded scores.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { labelMap, parseLog, blindScores, quantile } from "../../pilot/blind.mjs";

test("the label map is drawn once, a permutation of X/Y/Z, and kept", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-blind-"));
  try {
    const file = path.join(dir, "pilot-map.json");
    const a = labelMap(file);
    assert.deepEqual(Object.keys(a).sort(), ["agy", "claude", "codex"]);
    assert.deepEqual(Object.values(a).sort(), ["X", "Y", "Z"]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, JSON.stringify({ codex: "Z", claude: "X", agy: "Y" }));
    assert.deepEqual(labelMap(file), { codex: "Z", claude: "X", agy: "Y" }, "an existing map is never redrawn");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("log attempts and pauses are counted per label; scores lose every reviewer name", () => {
  const map = { codex: "Z", claude: "X", agy: "Y" };
  const log = [
    "2026-10-18T10:00:00.000Z pilot/A/high/codex/alpha-ts-T01/1 ok/revise -> final",
    "2026-10-18T10:00:01.000Z pilot/A/high/agy/alpha-ts-T01/1 infra/usage_limit -> retry_usage",
    "2026-10-18T10:00:02.000Z agy paused until 2026-10-18T10:30:01.000Z (usage limit)",
    "2026-10-18T10:00:03.000Z pilot/A/high/claude/alpha-ts-T02/2 ok/approve FLAGGED -> retry_flag",
    "2026-10-18T10:00:04.000Z pilot/A/high/agy/alpha-ts-T01/1 ok/revise -> final",
  ].join("\n");
  const { attempts, pauses } = parseLog(log, map);
  assert.deepEqual(attempts, { X: { "ok/approve flagged": 1 }, Y: { "infra/usage_limit": 1, "ok/revise": 1 }, Z: { "ok/revise": 1 } });
  assert.deepEqual(pauses, { X: 0, Y: 1, Z: 0 });

  const rows = [
    { track: "A", run_id: "pilot/A/high/codex/alpha-ts-T01/1", reviewer: "codex", model: "gpt-6-astra", config: "high", loo_judge: { codex: { tp_weight: 1 }, claude: { tp_weight: 0 }, agy: { tp_weight: 1 } } },
    { track: "B", run_id: "pilot/A/high/agy/alpha-ts-T01/1", reviewer: "agy", scenario: "B1" },
  ];
  const out = blindScores(rows.map(r => JSON.stringify(r)).join("\n") + "\n", map);
  assert.doesNotMatch(out, /codex|claude|agy|gpt-6|opus|gemini/);
  const [a, b] = out.trim().split("\n").map(l => JSON.parse(l));
  assert.equal(a.reviewer, "Z");
  assert.equal(a.run_id, "pilot/A/high/Z/alpha-ts-T01/1");
  assert.deepEqual(Object.keys(a.loo_judge).sort(), ["X", "Y", "Z"]);
  assert.equal(b.reviewer, "Y");
});

test("quantile interpolates between order statistics", () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(quantile([0, 10], 0.95), 9.5);
});
