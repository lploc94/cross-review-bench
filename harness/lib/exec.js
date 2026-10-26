// Child processes with a timeout and captured output. Never throws for a non-zero exit.

import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Run `cmd args` and resolve { code, stdout, stderr, timedOut }.
 * A timed-out process group is killed and reported with code null.
 */
export function run(cmd, args = [], { cwd, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, input } = {}) {
  // A `node --test` child that inherits NODE_TEST_CONTEXT reports to its parent runner and exits 0
  // even when its tests fail; corpus test commands must report their own exit code.
  const { NODE_TEST_CONTEXT, ...childEnv } = env;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
    });
    // a command may exit without reading its stdin; the closed pipe is not an error of ours
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

const KEEP_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];

/**
 * A clean environment for corpus commands: the few host variables a toolchain needs, no user git
 * configuration, then `extra` (service and cache variables, explicit overrides).
 */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const k of KEEP_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extra };
}

/** True when the command did not run to completion (timeout or signal); its exit says nothing about the tests. */
export function interrupted(res) {
  return res.timedOut || res.code === null;
}

/** Run a shell command line (test commands in task.json and crb-repo.json are shell lines). */
export function sh(line, opts = {}) {
  return run("/bin/sh", ["-c", line], opts);
}

/** Last lines of a command's output, for short diagnostics. */
export function tail(res, n = 12) {
  const out = `${res.stdout}\n${res.stderr}`.trim().split("\n").slice(-n).join("\n");
  return res.timedOut ? `timed out\n${out}` : res.code === null ? `killed by a signal\n${out}` : out;
}
