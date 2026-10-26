// A run's workspace: the corpus repo at corpus HEAD as a fresh one-commit repo, plus the PR
// applied as uncommitted changes (F15). Nothing from the task directory but the PR enters it (I3).

import fs from "node:fs";
import path from "node:path";
import { run, tail, cleanEnv } from "./exec.js";
import { prepareDeps } from "./cache.js";

const AUTHOR = { name: "Dev", email: "dev@example.com", date: "2026-01-01T00:00:00Z" };

async function git(args, cwd, env = cleanEnv()) {
  const r = await run("git", args, { cwd, env });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${tail(r, 6)}`);
  return r.stdout.trim();
}

/** The corpus commit a repo directory is archived from (recorded in run.json). */
export async function corpusCommit(repoDir) {
  return git(["rev-parse", "HEAD"], repoDir);
}

/**
 * Materialize task's repo into <runDir>/<repo>. Options: applyPatch (default true), env (extra
 * variables for deps_cmd: services and caches), deps (default true; judges only read the code).
 * Returns the workspace path.
 */
export async function materialize(task, runDir, { applyPatch = true, env = {}, deps = true } = {}) {
  let top;
  try {
    top = await git(["rev-parse", "--show-toplevel"], task.repoDir);
  } catch (e) {
    throw new Error(`corpus repo ${task.repoDir} is not inside a git repository (the harness archives corpus HEAD): ${e.message}`);
  }
  const prefix = path.relative(fs.realpathSync(top), fs.realpathSync(task.repoDir)).split(path.sep).join("/");
  const tree = `HEAD:${prefix}`;
  const tar = path.join(runDir, ".src.tar");
  await git(["archive", "--format=tar", "-o", tar, tree], top);

  const ws = path.join(runDir, task.repo);
  fs.mkdirSync(ws, { recursive: true });
  const x = await run("tar", ["-xf", tar, "-C", ws], { env: cleanEnv() });
  fs.rmSync(tar, { force: true });
  if (x.code !== 0) throw new Error(`cannot extract ${tree}: ${tail(x, 4)}`);
  // bench metadata, not part of the project
  fs.rmSync(path.join(ws, "crb-repo.json"), { force: true });

  const gitEnv = cleanEnv({
    GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_AUTHOR_DATE: AUTHOR.date,
    GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email, GIT_COMMITTER_DATE: AUTHOR.date,
  });
  await git(["init", "-q", "-b", "main"], ws, gitEnv);
  await git(["add", "-A"], ws, gitEnv);
  await git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "Initial import"], ws, gitEnv);

  if (deps) await prepareDeps(task, ws, env);
  if (applyPatch) await applyTaskPatch(task, task.pr_patch, ws);
  return ws;
}

/** Apply one of the task's patches (task-relative) to the workspace as uncommitted changes. */
export async function applyTaskPatch(task, rel, ws) {
  await git(["apply", path.join(task.dir, rel)], ws);
}
