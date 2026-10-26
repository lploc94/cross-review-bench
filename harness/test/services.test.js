// Live: needs colima, Postgres and Redis (CRB_LIVE=1). Leases live under a temporary CRB_HOME.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { run, cleanEnv } from "../lib/exec.js";
import { up, status, provisionRun, releaseRun, PG, REDIS } from "../lib/services.js";
import { pinnedRoot } from "../lib/paths.js";

// before any test moves CRB_HOME: the pinned cross-review checkout and its fake CLIs
const PINNED = pinnedRoot();

const live = process.env.CRB_LIVE === "1";
const hex = () => crypto.randomBytes(4).toString("hex");
const dockerEnv = () => cleanEnv({ DOCKER_HOST: `unix://${path.join(os.homedir(), ".colima", "default", "docker.sock")}` });
const redis = async (url, ...args) => {
  const db = url.split("/").pop();
  const r = await run("docker", ["exec", REDIS.name, "redis-cli", "-n", db, ...args], { env: dockerEnv() });
  return r.stdout.trim();
};
const databases = async () => (await run("docker", ["exec", PG.name, "psql", "-U", PG.user, "-d", "postgres", "-Atc", "SELECT datname FROM pg_database"], { env: dockerEnv() })).stdout.trim().split("\n");

function withCrbHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-svc-"));
  const saved = process.env.CRB_HOME;
  process.env.CRB_HOME = dir;
  return Promise.resolve().then(fn).finally(() => {
    if (saved === undefined) delete process.env.CRB_HOME; else process.env.CRB_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("up is idempotent and both services are healthy", { skip: !live, timeout: 1_200_000 }, async () => {
  await up();
  const again = await up();
  assert.deepEqual(again.changed, []);
  const s = await status();
  assert.equal(s.colima, "running");
  assert.deepEqual([s[PG.name].healthy, s[REDIS.name].healthy], [true, true]);
});

test("concurrent runs get their own database and Redis db; release flushes and drops", { skip: !live, timeout: 300_000 }, () => withCrbHome(async () => {
  const [a, b] = [hex(), hex()];
  const [ea, eb] = await Promise.all([provisionRun(a), provisionRun(b)]);
  try {
    assert.notEqual(ea.REDIS_URL, eb.REDIS_URL);
    assert.match(ea.DATABASE_URL, new RegExp(`/crw_${a}$`));
    assert.match(eb.DATABASE_URL, new RegExp(`/crw_${b}$`));
    const dbs = await databases();
    assert.ok(dbs.includes(`crw_${a}`) && dbs.includes(`crw_${b}`));

    await redis(ea.REDIS_URL, "SET", "k", "from-a");
    assert.equal(await redis(eb.REDIS_URL, "GET", "k"), "", "leases do not share keys");
  } finally {
    await releaseRun(a);
    await releaseRun(b);
  }
  assert.ok(!(await databases()).includes(`crw_${a}`), "the database is dropped");
  // the same Redis db leased again starts empty
  const c = hex();
  const ec = await provisionRun(c);
  try {
    assert.equal(ec.REDIS_URL, ea.REDIS_URL);
    assert.equal(await redis(ec.REDIS_URL, "GET", "k"), "");
  } finally {
    await releaseRun(c);
  }
  await releaseRun(c); // twice is fine
}));

test("validation stages, repo-check and review runs each get services and give them back", { skip: !live, timeout: 600_000 }, () => withCrbHome(async () => {
  const { fileURLToPath } = await import("node:url");
  const { execFileSync } = await import("node:child_process");
  const { validateTask } = await import("../lib/validate.js");
  const { checkRepo } = await import("../lib/repocheck.js");
  const { loadTask } = await import("../lib/task.js");
  const { executeRun, planRuns } = await import("../lib/scheduler.js");
  const { taskServices } = await import("../lib/services.js");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crb-svc-wire-"));
  const saved = { ...process.env };
  try {
    const corpus = path.join(root, "corpus");
    fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "corpus"), corpus, { recursive: true });
    // its tests fail unless they got their own database and Redis db; deps need only the caches
    const need = 'test -n "$DATABASE_URL" && test -n "$REDIS_URL"';
    const cfgFile = path.join(corpus, "repos/pager-js/crb-repo.json");
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    Object.assign(cfg, { services: ["postgres", "redis"], test_cmd: `${need} && ${cfg.test_cmd}`, deps_cmd: `test -n "$npm_config_cache" && test -n "$JAVA_HOME" && echo "$DATABASE_URL" >> ${path.join(root, "db-seen")}` });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "init", "-q"], { cwd: corpus });
    execFileSync("git", ["add", "-A"], { cwd: corpus });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "c"], { cwd: corpus });
    const before = (await databases()).filter(d => d.startsWith("crw_")).length;
    const leases = () => JSON.parse(fs.readFileSync(path.join(process.env.CRB_HOME, "locks", "redis-leases.json"), "utf8"));

    const v = await validateTask(path.join(corpus, "tasks/pager-js/pager-js-T01"), { corpus, services: taskServices });
    assert.equal(v.ok, true, JSON.stringify(v.results.filter(r => !r.ok)));
    assert.deepEqual(leases(), {});

    const rc = await checkRepo(path.join(corpus, "repos/pager-js"));
    assert.equal(rc.results.find(r => r.rule === "test_cmd").ok, true, JSON.stringify(rc.results.find(r => r.rule === "test_cmd")));
    assert.deepEqual(leases(), {});

    // one review run with cross-review's fake codex
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const { writeFakeCodex } = await import(path.join(PINNED, "tests", "helpers", "fake-codex.js"));
    writeFakeCodex(bin);
    const out = path.join(root, "review.md");
    fs.writeFileSync(out, "### VERDICT\n- Status: APPROVE\n- Reason: invented\n");
    const real = path.join(root, "realhome");
    fs.mkdirSync(path.join(real, "Library/Keychains"), { recursive: true });
    Object.assign(process.env, { CRB_REAL_HOME: real, CRB_RUN_ROOT: path.join(root, "crw"), CRB_CORPUS: corpus, CRB_PINNED: PINNED, CRB_TEST: "1", CRB_DOCKER_HOST: `unix://${path.join(os.homedir(), ".colima", "default", "docker.sock")}`, FAKE_CODEX_OUTPUT: out, FAKE_CODEX_LOG: path.join(root, "codex.log"), PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    const task = loadTask(path.join(corpus, "tasks/pager-js/pager-js-T02"), { corpus });
    const [spec] = planRuns({ set: "smoke", config: "high", reviewers: ["codex"], tasks: [task], n: 1 });
    const { result } = await executeRun(spec, { flags: 0, infra: 0, reviewer: 0, usage: 0 });
    assert.deepEqual([result.class, result.reason], ["ok", "approve"], JSON.stringify(result));
    // the run's workspace was installed with the run's own database
    assert.match(fs.readFileSync(path.join(root, "db-seen"), "utf8"), /\/crw_[0-9a-f]{8}\n$/);
    assert.deepEqual(leases(), {});
    assert.equal((await databases()).filter(d => d.startsWith("crw_")).length, before, "every crw_ database was dropped");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

test("a lease held by a dead process is reclaimed", { skip: !live, timeout: 120_000 }, () => withCrbHome(async () => {
  const leases = path.join(process.env.CRB_HOME, "locks", "redis-leases.json");
  fs.mkdirSync(path.dirname(leases), { recursive: true });
  // pid 999999 does not exist; all 15 dbs look taken
  fs.writeFileSync(leases, JSON.stringify(Object.fromEntries(Array.from({ length: 15 }, (_, i) => [i + 1, { hex: `dead${String(i).padStart(4, "0")}`, pid: 999999 }]))));
  const h = hex();
  const env = await provisionRun(h, { waitMs: 5000 });
  try {
    assert.match(env.REDIS_URL, /\/1$/);
  } finally {
    await releaseRun(h);
  }
}));
