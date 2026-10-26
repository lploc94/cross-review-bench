// Toolchains and dependency caches (F14). Caches live under ~/.crbench/cache and are shared
// read-mostly by validation, repo-check, review runs and Track C; `crb cache warm` fills them online
// once, and every later command works offline from them.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run, sh, tail, cleanEnv } from "./exec.js";
import { cacheDir, realHome, scratchDir } from "./paths.js";
import { provisionRun, releaseRun, needsServices } from "./services.js";

/** JDK 21 (brew `openjdk@21`; F14). CRB_JAVA_HOME overrides. */
export function javaHome() {
  return process.env.CRB_JAVA_HOME || "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home";
}

/**
 * Environment for corpus commands: cache locations, the uv-managed Python, JDK 21 first on PATH.
 * `online` (cache warm only) lets Maven and Go reach the network and sets `CRB_ONLINE=1`. `scratch` (validation, repo-check,
 * warm) puts Go's build cache inside that scratch directory, removed with it: Go keys compiled
 * packages by their absolute directory, so a shared cache grows by every scratch copy, and it holds
 * compiled hidden tests, which no review run may read. Review runs keep theirs in their own HOME.
 */
export function toolchainEnv({ online = false, scratch = null } = {}) {
  const c = cacheDir();
  const m2 = path.join(c, "m2");
  const jdk = javaHome();
  return {
    npm_config_cache: path.join(c, "npm"),
    UV_CACHE_DIR: path.join(c, "uv"),
    UV_PYTHON_INSTALL_DIR: path.join(realHome(), ".local", "share", "uv", "python"),
    GOMODCACHE: path.join(c, "gomod"),
    GOFLAGS: online ? "-mod=mod" : "-mod=vendor",
    JAVA_HOME: jdk,
    MAVEN_ARGS: online ? `-Dmaven.repo.local=${m2}` : `-Dmaven.repo.local=${m2} -o`,
    PATH: `${path.join(jdk, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    ...(scratch ? { GOCACHE: path.join(scratch, "gocache") } : {}),
    // deps_cmd installs offline; under warm it may fill the caches first (`pnpm fetch`, `go mod download`)
    ...(online ? { CRB_ONLINE: "1" } : {}),
  };
}

const LOCKS = ["package-lock.json"];

/** Cached node_modules of a repo, keyed by its lock file (null for repos without one). */
function nodeModulesKey(repo, ws) {
  const lock = LOCKS.map(f => path.join(ws, f)).find(f => fs.existsSync(f));
  if (!lock) return null;
  const h = crypto.createHash("sha256").update(fs.readFileSync(lock)).digest("hex").slice(0, 16);
  return path.join(cacheDir(), "node_modules", `${repo}-${h}`);
}

/** APFS clone (`cp -c`): a node_modules tree costs no disk until written. */
async function cloneTree(src, dest) {
  const r = await run("cp", ["-cR", src, dest], { env: cleanEnv() });
  if (r.code !== 0) throw new Error(`cannot clone ${src}: ${tail(r, 4)}`);
}

/**
 * Install a workspace's dependencies: clone the cached node_modules when there is one, then run
 * the repo's deps_cmd with the toolchain environment plus `env` (services).
 */
export async function prepareDeps(task, ws, env = {}) {
  const key = nodeModulesKey(task.repo, ws);
  if (key && fs.existsSync(path.join(key, "node_modules")) && !fs.existsSync(path.join(ws, "node_modules"))) {
    await cloneTree(path.join(key, "node_modules"), path.join(ws, "node_modules"));
  }
  const cmd = task.repoConfig.deps_cmd;
  if (!cmd) return;
  const r = await sh(cmd, { cwd: ws, env: cleanEnv({ ...toolchainEnv(), ...env }) });
  if (r.code !== 0) throw new Error(`deps_cmd failed: ${tail(r)}`);
}

/**
 * `crb cache warm <repo>`: in a scratch copy of the repo, run deps_cmd and warm_cmd online (with
 * services when the repo needs them), then keep its node_modules for later clones.
 */
export async function warm(repoDir, repoConfig, { repo = path.basename(repoDir) } = {}) {
  const ws = path.join(scratchDir(), `warm-${crypto.randomBytes(4).toString("hex")}`, repo);
  fs.mkdirSync(path.dirname(ws), { recursive: true });
  const hex = crypto.randomBytes(4).toString("hex");
  const steps = [];
  let svcEnv = {};
  try {
    fs.cpSync(repoDir, ws, { recursive: true, verbatimSymlinks: true, filter: src => !["node_modules", ".venv", "target", ".git"].includes(path.basename(src)) || src === repoDir });
    if (needsServices(repoConfig)) svcEnv = await provisionRun(hex);
    const env = cleanEnv({ ...toolchainEnv({ online: true, scratch: path.dirname(ws) }), ...svcEnv });
    for (const [name, cmd] of [["deps_cmd", repoConfig.deps_cmd], ["warm_cmd", repoConfig.warm_cmd]]) {
      if (!cmd) continue;
      const r = await sh(cmd, { cwd: ws, env, timeoutMs: 3_600_000 });
      steps.push({ step: name, ok: r.code === 0 });
      if (r.code !== 0) throw new Error(`${name} failed: ${tail(r)}`);
    }
    const key = nodeModulesKey(repo, ws);
    if (key && fs.existsSync(path.join(ws, "node_modules"))) {
      fs.rmSync(key, { recursive: true, force: true });
      fs.mkdirSync(key, { recursive: true });
      await cloneTree(path.join(ws, "node_modules"), path.join(key, "node_modules"));
      steps.push({ step: "node_modules", ok: true, key: path.basename(key) });
    }
    return { repo, ok: true, steps };
  } finally {
    if (needsServices(repoConfig)) await releaseRun(hex).catch(() => {});
    fs.rmSync(path.dirname(ws), { recursive: true, force: true });
  }
}
