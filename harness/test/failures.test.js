import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../lib/failures.js";

const verdict = status => ({ status: "completed", review: { format: "review", blocks: [], verdict: { status }, raw_markdown: `### VERDICT\n- Status: ${status}` }, next: status === "APPROVE" ? "done" : "respond" });

test("a completed round with a verdict is ok", () => {
  assert.equal(classify({ beginCode: 0, waitJson: verdict("REVISE") }).class, "ok");
  assert.equal(classify({ beginCode: 0, waitJson: verdict("APPROVE") }).class, "ok");
});

test("a missing reviewer CLI (exit 5) is infra", () => {
  const c = classify({ beginCode: 5, beginJson: { status: "error", code: "REVIEWER_NOT_FOUND", error: "agy CLI not found in PATH" } });
  assert.deepEqual([c.class, c.reason], ["infra", "reviewer_not_found"]);
});

test("any runner error before the reviewer starts is infra", () => {
  const c = classify({ beginCode: 1, beginJson: { status: "error", code: "START_FAILED", error: "spawn failed" } });
  assert.deepEqual([c.class, c.reason], ["infra", "begin_failed"]);
  assert.equal(classify({ beginCode: 1, beginJson: null, errorLog: "SyntaxError" }).class, "infra");
});

test("usage limits are infra with their own reason, from the error or the reviewer's text", () => {
  const failed = { status: "failed", failure_reason: "turn_failed", error: "Codex turn failed: You've hit your usage limit. Try again at 3:00 PM.", next: "stopped" };
  assert.deepEqual([classify({ beginCode: 0, waitJson: failed }).class, classify({ beginCode: 0, waitJson: failed }).reason], ["infra", "usage_limit"]);
  const said = { status: "completed", review: { format: "review", blocks: [], verdict: null, raw_markdown: "Claude AI usage limit reached|1760000000" }, next: "ask_user" };
  assert.deepEqual([classify({ beginCode: 0, waitJson: said }).class, classify({ beginCode: 0, waitJson: said }).reason], ["infra", "usage_limit"]);
  const quota = { status: "failed", failure_reason: "reviewer_process_exit", error: "agy process exited unexpectedly", next: "stopped" };
  assert.equal(classify({ beginCode: 0, waitJson: quota, errorLog: "RESOURCE_EXHAUSTED: quota exceeded for model" }).reason, "usage_limit");
});

test("HTTP 429 is a usage limit; 401/403 and login prompts are auth", () => {
  const f = error => classify({ beginCode: 0, waitJson: { status: "failed", failure_reason: "turn_failed", error, next: "stopped" } });
  assert.deepEqual([f("stream error: 429 Too Many Requests").class, f("stream error: 429 Too Many Requests").reason], ["infra", "usage_limit"]);
  assert.equal(f("unexpected status 401 Unauthorized").reason, "auth");
  assert.equal(f("turn failed: the network module is wrong").reason, "turn_failed", "a bare word is not an infra sign");
  assert.equal(f("403 Forbidden").reason, "auth");
  assert.equal(f("Not logged in · Please run /login").reason, "auth");
  assert.equal(f("request failed: ECONNRESET").reason, "network");
  assert.equal(f("getaddrinfo ENOTFOUND api.example.com").reason, "network");
});

test("a reviewer process that dies without any infra sign is infra (crash)", () => {
  const c = classify({ beginCode: 0, waitJson: { status: "failed", failure_reason: "reviewer_process_exit", error: "Claude Code process exited unexpectedly", next: "stopped" } });
  assert.deepEqual([c.class, c.reason], ["infra", "reviewer_process_exit"]);
});

test("the runner deadline is a reviewer timeout and a stall is a reviewer stall", () => {
  const t = classify({ beginCode: 0, waitJson: { status: "timeout", timeout_reason: "runner_deadline", error: "Timeout after 7200s", next: "stopped", next_reason: "recoverable_timeout" } });
  assert.deepEqual([t.class, t.reason], ["reviewer_timeout", "runner_deadline"]);
  const s = classify({ beginCode: 0, waitJson: { status: "stalled", failure_reason: "stalled", error: "No new output for ~3 minutes", next: "stopped" } });
  assert.deepEqual([s.class, s.reason], ["reviewer_stall", "stalled"]);
});

test("a completed round without a verdict is malformed", () => {
  const noVerdict = { status: "completed", review: { format: "review", blocks: [{ id: 1 }], verdict: null, raw_markdown: "### ISSUE-1: x" }, next: "respond", next_reason: "open_issues" };
  assert.deepEqual([classify({ beginCode: 0, waitJson: noVerdict }).class, classify({ beginCode: 0, waitJson: noVerdict }).reason], ["reviewer_malformed", "missing_verdict"]);
  const empty = { status: "completed", review: null, next: "ask_user" };
  assert.equal(classify({ beginCode: 0, waitJson: empty }).class, "reviewer_malformed");
});

test("findings about rate limits, auth or networking never make a malformed review infra", () => {
  const raw = "### ISSUE-1: Missing rate limit on login\n- Problem: no 429 after repeated 401 Unauthorized; ECONNRESET is not retried; token expired is ignored";
  const findings = { status: "completed", review: { format: "review", blocks: [{ id: 1 }], verdict: null, raw_markdown: raw }, next: "respond" };
  assert.deepEqual(classify({ beginCode: 0, waitJson: findings, errorLog: "warn: 429 Too Many Requests, retrying" }), { class: "reviewer_malformed", reason: "missing_verdict" });
  // with no findings, the reviewer's text can still be the CLI's limit message
  const said = { status: "completed", review: { format: "review", blocks: [], verdict: null, raw_markdown: "You've hit your usage limit." }, next: "ask_user" };
  assert.equal(classify({ beginCode: 0, waitJson: said }).reason, "usage_limit");
});

test("a wait that returned no JSON is infra", () => {
  assert.deepEqual([classify({ beginCode: 0, waitJson: null, errorLog: "POLL_FAILED" }).class, classify({ beginCode: 0, waitJson: null }).reason], ["infra", "wait_failed"]);
});
