// Output tokens per run (METHODOLOGY "Cost proxies"): round 1's event log, read the way each CLI
// reports usage. Event lines are invented, in each CLI's shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { outputTokens, roundOneLog, runOutputTokens } from "../lib/grade/tokens.js";

const j = o => JSON.stringify(o);

test("claude: the result event's output tokens, summed over turns", () => {
  const lines = [
    j({ type: "system", subtype: "init", session_id: "s" }),
    j({ type: "assistant", message: { id: "m1", usage: { output_tokens: 40 } } }),
    j({ type: "result", subtype: "success", usage: { input_tokens: 6, output_tokens: 1526, output_tokens_details: { thinking_tokens: 153 } } }),
  ];
  // assistant messages carry partial usage; only the result counts, or the turn is counted twice
  assert.equal(outputTokens("claude", lines), 1526);
  assert.equal(outputTokens("claude", [...lines, ...lines]), 3052);
});

test("codex: turn.completed usage", () => {
  const lines = [
    j({ type: "thread.started", thread_id: "t" }),
    j({ type: "item.completed", item: { type: "agent_message", text: "x" } }),
    j({ type: "turn.completed", usage: { input_tokens: 67884, cached_input_tokens: 61696, output_tokens: 863, reasoning_output_tokens: 0 } }),
  ];
  assert.equal(outputTokens("codex", lines), 863);
});

test("agy: the last usage of each step, summed", () => {
  const step = (i, out, extra = {}) => j({ event: "step_update", step_update: { step_index: i, state: "DONE", step_type: "agent_response", usage: { input_tokens: 10, output_tokens: out, thinking_tokens: 1 }, ...extra } });
  const lines = [
    step(1, 179),
    j({ event: "step_update", step_update: { step_index: 2, state: "RUNNING", step_type: "tool_call" } }),
    step(3, 269),
    // a step reported again with its final usage replaces the earlier report
    step(3, 300, { text_delta: "more" }),
    j({ event: "result", result: { status: "SUCCESS", response: "### ISSUE-1" } }),
  ];
  assert.equal(outputTokens("agy", lines), 479);
});

test("no usage, broken lines, or an unknown reviewer give null, never 0", () => {
  assert.equal(outputTokens("claude", ["not json", j({ type: "assistant" })]), null);
  assert.equal(outputTokens("codex", []), null);
  assert.equal(outputTokens("agy", [j({ event: "result", result: {} })]), null);
  assert.equal(outputTokens("other", [j({ type: "result", usage: { output_tokens: 5 } })]), null);
});

test("round 1's log: round1/session when round 2 ran, else session; tokens of a run read it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-tokens-"));
  try {
    fs.mkdirSync(path.join(dir, "session"), { recursive: true });
    fs.writeFileSync(path.join(dir, "session", "output.jsonl"), j({ type: "turn.completed", usage: { output_tokens: 7 } }) + "\n");
    assert.equal(roundOneLog(dir), path.join(dir, "session", "output.jsonl"));
    assert.equal(runOutputTokens({ archive: dir, reviewer: "codex" }), 7);

    // with a second round, session/output.jsonl holds round 2: round 1 is the round1/ snapshot
    fs.mkdirSync(path.join(dir, "round1", "session"), { recursive: true });
    fs.writeFileSync(path.join(dir, "round1", "session", "output.jsonl"), j({ type: "turn.completed", usage: { output_tokens: 11 } }) + "\n");
    assert.equal(roundOneLog(dir), path.join(dir, "round1", "session", "output.jsonl"));
    assert.equal(runOutputTokens({ archive: dir, reviewer: "codex" }), 11);

    assert.equal(runOutputTokens({ archive: path.join(dir, "missing"), reviewer: "codex" }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
