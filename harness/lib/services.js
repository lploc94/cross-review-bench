// Postgres and Redis for corpus tests (F14): one container each in colima, a database and a Redis
// logical db per run or validation stage.
//
// Only containers named crb-* are ever touched. Docker talks to colima's own socket, whatever the
// user's current docker context is.

import fs from "node:fs";
import path from "node:path";
import { run, cleanEnv, tail } from "./exec.js";
import { realHome, locksDir } from "./paths.js";
import { withLockSync, writeAtomic } from "./store.js";

export const PG = { name: "crb-postgres", image: "postgres:17", port: 55432, user: "crb", password: "crb", volume: "crb-postgres-data" };
export const REDIS = { name: "crb-redis", image: "redis:7", port: 56379, volume: "crb-redis-data" };
export const REDIS_DBS = Array.from({ length: 15 }, (_, i) => i + 1);
const COLIMA_ARGS = ["start", "--cpu", "6", "--memory", "12"];
const HEX = /^[0-9a-f]{8}$/;

function dockerEnv() {
  const socket = process.env.CRB_DOCKER_HOST || `unix://${path.join(realHome(), ".colima", "default", "docker.sock")}`;
  return cleanEnv({ DOCKER_HOST: socket });
}

async function docker(args, { timeoutMs = 120_000, check = true } = {}) {
  const r = await run("docker", args, { env: dockerEnv(), timeoutMs });
  if (check && r.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${tail(r, 6)}`);
  return r;
}

async function colimaRunning() {
  const r = await run("colima", ["status"], { env: cleanEnv(), timeoutMs: 60_000 });
  return r.code === 0;
}

/** Container state: "missing", or docker's State.Status ("running", "exited", …). */
async function state(name) {
  const r = await docker(["inspect", "-f", "{{.State.Status}}", name], { check: false });
  return r.code === 0 ? r.stdout.trim() : "missing";
}

async function healthy(name) {
  const r = name === PG.name
    ? await docker(["exec", PG.name, "pg_isready", "-U", PG.user, "-d", "postgres"], { check: false })
    : await docker(["exec", REDIS.name, "redis-cli", "ping"], { check: false });
  return r.code === 0 && (name === PG.name || r.stdout.trim() === "PONG");
}

function runArgs(svc) {
  if (svc === PG) {
    return ["run", "-d", "--name", PG.name, "--restart", "unless-stopped", "-p", `127.0.0.1:${PG.port}:5432`,
      "-e", `POSTGRES_USER=${PG.user}`, "-e", `POSTGRES_PASSWORD=${PG.password}`, "-v", `${PG.volume}:/var/lib/postgresql/data`,
      PG.image, "-c", "max_connections=200"];
  }
  return ["run", "-d", "--name", REDIS.name, "--restart", "unless-stopped", "-p", `127.0.0.1:${REDIS.port}:6379`,
    "-v", `${REDIS.volume}:/data`, REDIS.image];
}

async function waitHealthy(name, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await healthy(name))) {
    if (Date.now() > deadline) throw new Error(`${name} did not become healthy in ${timeoutMs / 1000} s`);
    await new Promise(r => setTimeout(r, 1000));
  }
}

/** Start colima and both containers as needed. Idempotent. Resolves { changed: [what was started] }. */
export async function up() {
  const changed = [];
  if (!(await colimaRunning())) {
    const r = await run("colima", COLIMA_ARGS, { env: cleanEnv(), timeoutMs: 900_000 });
    if (r.code !== 0) throw new Error(`colima start failed: ${tail(r, 8)}`);
    changed.push("colima");
  }
  for (const svc of [PG, REDIS]) {
    const s = await state(svc.name);
    if (s === "missing") { await docker(runArgs(svc), { timeoutMs: 900_000 }); changed.push(svc.name); }
    else if (s !== "running") { await docker(["start", svc.name]); changed.push(svc.name); }
    await waitHealthy(svc.name);
  }
  return { changed };
}

/** Stop both containers (their data volumes stay). colima keeps running. */
export async function down() {
  const stopped = [];
  for (const svc of [PG, REDIS]) {
    if ((await state(svc.name)) === "running") { await docker(["stop", svc.name]); stopped.push(svc.name); }
  }
  return { stopped };
}

export async function status() {
  const colima = await colimaRunning();
  const out = { colima: colima ? "running" : "stopped" };
  for (const svc of [PG, REDIS]) {
    const s = colima ? await state(svc.name) : "unknown";
    out[svc.name] = { state: s, healthy: s === "running" ? await healthy(svc.name) : false, port: svc.port };
  }
  out.leases = readLeases();
  return out;
}

// ---------- per-run resources ----------

const leaseFile = () => path.join(locksDir(), "redis-leases.json");

function readLeases() {
  try { return JSON.parse(fs.readFileSync(leaseFile(), "utf8")); } catch { return {}; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Take a free Redis db (1–15) for hex, reclaiming leases whose process is gone; null when all are held. */
function takeLease(hex) {
  return withLockSync("redis-leases", () => {
    const leases = readLeases();
    for (const [db, l] of Object.entries(leases)) if (!alive(l.pid)) delete leases[db];
    const mine = Object.entries(leases).find(([, l]) => l.hex === hex);
    const db = mine ? Number(mine[0]) : REDIS_DBS.find(i => !leases[i]);
    if (!db) return null;
    leases[db] = { hex, pid: process.pid, at: new Date().toISOString() };
    writeAtomic(leaseFile(), JSON.stringify(leases, null, 2) + "\n");
    return db;
  });
}

function freeLease(hex) {
  return withLockSync("redis-leases", () => {
    const leases = readLeases();
    let db = null;
    for (const [i, l] of Object.entries(leases)) if (l.hex === hex) { db = Number(i); delete leases[i]; }
    writeAtomic(leaseFile(), JSON.stringify(leases, null, 2) + "\n");
    return db;
  });
}

function leasedDb(hex) {
  const e = Object.entries(readLeases()).find(([, l]) => l.hex === hex);
  return e ? Number(e[0]) : null;
}

async function psql(sql) {
  await docker(["exec", PG.name, "psql", "-v", "ON_ERROR_STOP=1", "-U", PG.user, "-d", "postgres", "-qc", sql]);
}

async function flush(db) {
  const r = await docker(["exec", REDIS.name, "redis-cli", "-n", String(db), "FLUSHDB"]);
  if (r.stdout.trim() !== "OK") throw new Error(`FLUSHDB ${db}: ${r.stdout.trim()}`);
}

/**
 * Database crw_<hex> and a flushed Redis db for one run or validation stage. When all 15 Redis dbs
 * are leased, waits for one to be released (up to waitMs). Resolves { DATABASE_URL, REDIS_URL }.
 */
export async function provisionRun(hex, { waitMs = 1_800_000 } = {}) {
  if (!HEX.test(hex)) throw new Error(`provisionRun: hex must be 8 hex digits (got ${hex})`);
  const deadline = Date.now() + waitMs;
  let db;
  while (!(db = takeLease(hex))) {
    if (Date.now() > deadline) throw new Error(`no free Redis db after ${waitMs / 1000} s (all ${REDIS_DBS.length} leased)`);
    await new Promise(r => setTimeout(r, 2000));
  }
  try {
    await flush(db);
    await psql(`DROP DATABASE IF EXISTS crw_${hex} WITH (FORCE)`);
    await psql(`CREATE DATABASE crw_${hex}`);
  } catch (e) {
    freeLease(hex);
    throw e;
  }
  return {
    DATABASE_URL: `postgres://${PG.user}:${PG.password}@127.0.0.1:${PG.port}/crw_${hex}`,
    REDIS_URL: `redis://127.0.0.1:${REDIS.port}/${db}`,
  };
}

/** Flush the run's Redis db, drop its database, free the lease. Safe to call twice. */
export async function releaseRun(hex) {
  if (!HEX.test(hex)) throw new Error(`releaseRun: hex must be 8 hex digits (got ${hex})`);
  const db = leasedDb(hex);
  try {
    if (db) await flush(db);
    await psql(`DROP DATABASE IF EXISTS crw_${hex} WITH (FORCE)`);
  } finally {
    freeLease(hex);
  }
}

/** True when the repo's crb-repo.json asks for services. */
export const needsServices = repoConfig => (repoConfig?.services ?? []).length > 0;

/** The `services` factory validate.js takes: real services for repos that need them, none otherwise. */
export function taskServices(task) {
  if (!needsServices(task.repoConfig)) return { provision: async () => ({}), release: async () => {} };
  return { provision: hex => provisionRun(hex), release: hex => releaseRun(hex) };
}
