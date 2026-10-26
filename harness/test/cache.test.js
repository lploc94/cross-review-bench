import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { warm, prepareDeps, toolchainEnv } from "../lib/cache.js";

function withCrbHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-cache-"));
  const saved = process.env.CRB_HOME;
  process.env.CRB_HOME = dir;
  return Promise.resolve().then(() => fn(dir)).finally(() => {
    if (saved === undefined) delete process.env.CRB_HOME; else process.env.CRB_HOME = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("the toolchain environment is offline except when warming", () => withCrbHome(home => {
  const off = toolchainEnv();
  assert.equal(off.MAVEN_ARGS, `-Dmaven.repo.local=${path.join(home, "cache", "m2")} -o`);
  assert.equal(off.GOFLAGS, "-mod=vendor");
  assert.equal(off.npm_config_cache, path.join(home, "cache", "npm"));
  assert.ok(off.PATH.startsWith(path.join(off.JAVA_HOME, "bin")));
  const on = toolchainEnv({ online: true });
  assert.doesNotMatch(on.MAVEN_ARGS, / -o$/);
  assert.equal(on.GOFLAGS, "-mod=mod");
  // deps_cmd is written offline; during warm it can tell it may fill the caches first
  assert.equal(on.CRB_ONLINE, "1");
  assert.equal("CRB_ONLINE" in off, false);
  // Go's build cache: inside the caller's scratch dir, never a shared one (review runs keep their own HOME's)
  assert.equal("GOCACHE" in off, false);
  assert.equal(toolchainEnv({ scratch: "/s/validate-1" }).GOCACHE, "/s/validate-1/gocache");
}));

test("warm keeps node_modules by lock file and later workspaces clone it offline", () => withCrbHome(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crb-warm-"));
  try {
    const repo = path.join(root, "shop-ts");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
    // installs only online (GOFLAGS stands in for "warming"); offline it needs the cached tree
    const repoConfig = {
      deps_cmd: 'test -d node_modules || { test "$GOFLAGS" = "-mod=mod" && mkdir -p node_modules/dep && echo v1 > node_modules/dep/index.js; }',
      warm_cmd: 'test -f node_modules/dep/index.js', services: [],
    };
    const res = await warm(repo, repoConfig);
    assert.deepEqual(res.steps.map(s => s.step), ["deps_cmd", "warm_cmd", "node_modules"]);

    const ws = path.join(root, "ws");
    fs.mkdirSync(ws);
    fs.copyFileSync(path.join(repo, "package-lock.json"), path.join(ws, "package-lock.json"));
    await prepareDeps({ repo: "shop-ts", repoConfig }, ws);
    assert.equal(fs.readFileSync(path.join(ws, "node_modules/dep/index.js"), "utf8"), "v1\n");

    // another lock file has no cached tree: offline install fails
    const ws2 = path.join(root, "ws2");
    fs.mkdirSync(ws2);
    fs.writeFileSync(path.join(ws2, "package-lock.json"), '{"lockfileVersion":3,"x":1}\n');
    await assert.rejects(prepareDeps({ repo: "shop-ts", repoConfig }, ws2), /deps_cmd failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}));
