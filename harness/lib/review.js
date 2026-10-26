// Driving one review through the pinned runner's verbs (F6), as the review-impl skill does.

import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { pinnedRoot, pinnedRunner } from "./paths.js";
import { ROUND_TIMEOUT_S } from "./config.js";

/** The fenced block of the pinned review-impl output-format.md, extracted as the runner does. */
export function outputFormat() {
  const md = fs.readFileSync(path.join(pinnedRoot(), "skill-packs", "cross-review", "skills", "review-impl", "references", "output-format.md"), "utf8");
  const m = md.match(/```(?:markdown)?\n([\s\S]*?)```/);
  return m ? m[1].trim() : md.trim();
}

/** Round-1 input: USER_REQUEST is the PR description; SESSION_CONTEXT keeps its default (F6). */
export function reviewInput(task) {
  return `## USER_REQUEST\n${task.description.trim()}\n\n## OUTPUT_FORMAT\n${outputFormat()}\n`;
}

function parse(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

async function runner(args, { env, cwd, timeoutMs }) {
  const r = await run(process.execPath, [pinnedRunner(), ...args], { env, cwd, timeoutMs });
  return { code: r.code, json: parse(r.stdout), stderr: r.stderr, stdout: r.stdout };
}

/** `begin --skill review-impl --mode working-tree` in ws. Resolves { code, json, stderr }. */
export function begin(ws, { reviewer, model, effort, inputFile, env, timeoutS = ROUND_TIMEOUT_S }) {
  return runner([
    "begin", "--skill", "review-impl", "--mode", "working-tree", "--input", inputFile, "--working-dir", ws,
    "--reviewer", reviewer, "--model", model, "--effort", effort, "--timeout", String(timeoutS),
  ], { env, cwd: ws, timeoutMs: 300_000 });
}

/**
 * Call `wait` until `next` is no longer `running`. Resolves { code, json } with the last wait result,
 * or json null when `wait` itself failed (its stderr/stdout in `error`).
 */
export async function waitDone(sessionDir, { env, maxWaitS = 60, onTick } = {}) {
  for (;;) {
    const r = await runner(["wait", sessionDir, "--max-wait", String(maxWaitS)], { env, cwd: path.dirname(sessionDir), timeoutMs: (maxWaitS + 300) * 1000 });
    if (!r.json || r.json.status === "error" || !r.json.next) return { code: r.code, json: null, error: (r.json?.error ?? r.stderr ?? r.stdout ?? "").slice(0, 2000) };
    onTick?.(r.json);
    if (r.json.next !== "running") return { code: r.code, json: r.json };
  }
}

/** `reply` with a markdown input file (Track B). */
export function reply(sessionDir, { inputFile, env }) {
  return runner(["reply", sessionDir, "--input", inputFile], { env, cwd: path.dirname(sessionDir), timeoutMs: 300_000 });
}

/** `stop`: kill the session's reviewer and watchdog (process identity checked) and mark a running round stopped. */
export function stop(sessionDir, { env }) {
  return runner(["stop", sessionDir], { env, cwd: path.dirname(sessionDir), timeoutMs: 120_000 });
}

/** `end`: finalize when the review reached a normal end, and stop the reviewer in every case. */
export function end(sessionDir, { env }) {
  return runner(["end", sessionDir], { env, cwd: path.dirname(sessionDir), timeoutMs: 120_000 });
}

/** The reviewer CLI's version as `<cli> --version` prints it in the run's environment (first line), or null. */
export async function cliVersion(cli, { env, timeoutMs = 30_000 } = {}) {
  const r = await run(cli, ["--version"], { env, timeoutMs });
  const line = r.stdout.trim().split("\n")[0]?.trim();
  return r.code === 0 && line ? line.slice(0, 200) : null;
}
