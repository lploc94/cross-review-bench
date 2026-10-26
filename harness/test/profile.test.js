import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProfile, codexWriteBack, CLAUDE_KEYS } from "../lib/profile.js";

/** An invented real home with the login material F3 copies, plus things a clean profile must not get. */
function fakeRealHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crb-realhome-"));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
  w(".codex/auth.json", JSON.stringify({ tokens: { refresh_token: "r-old" }, last_refresh: "2026-10-01T00:00:00Z" }));
  w(".codex/config.toml", '[mcp_servers.x]\ncommand = "x"\n');
  w(".codex/AGENTS.md", "user instructions\n");
  w(".claude.json", JSON.stringify({ oauthAccount: { emailAddress: "someone@example.com" }, userID: "u1", hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.0", firstStartTime: "2026-01-01", mcpServers: { x: {} }, projects: { "/p": {} } }));
  w(".claude/CLAUDE.md", "memory\n");
  w(".claude/skills/review-impl/SKILL.md", "skill\n");
  for (const f of ["oauth_creds.json", "google_accounts.json", "state.json", "installation_id"]) w(`.gemini/${f}`, `${f}\n`);
  w(".gemini/settings.json", JSON.stringify({ mcpServers: { y: {} } }));
  w(".gemini/GEMINI.md", "memory\n");
  w(".gemini/antigravity-cli/settings.json", "{}\n");
  w(".gemini/antigravity-cli/jetski_state.pbtxt", "state\n");
  w(".gemini/antigravity-cli/skills/x/SKILL.md", "skill\n");
  fs.mkdirSync(path.join(home, "Library/Keychains"), { recursive: true });
  return home;
}

function listTree(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTree(p, base));
    else out.push(path.relative(base, p) + (e.isSymbolicLink() ? " -> " + fs.readlinkSync(p) : ""));
  }
  return out.sort();
}

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test("a clean profile holds exactly the F3 login material", () => {
  const real = fakeRealHome();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-run-"));
  try {
    const { home } = withEnv({ CRB_REAL_HOME: real }, () => buildProfile(runDir));
    assert.equal(home, path.join(runDir, "home"));
    assert.deepEqual(listTree(home), [
      ".claude.json",
      ".claude/settings.json",
      ".codex/auth.json",
      ".codex/config.toml",
      ".gemini/antigravity-cli/jetski_state.pbtxt",
      ".gemini/antigravity-cli/settings.json",
      ".gemini/google_accounts.json",
      ".gemini/installation_id",
      ".gemini/oauth_creds.json",
      ".gemini/state.json",
      `Library/Keychains -> ${path.join(real, "Library/Keychains")}`,
    ]);
    assert.equal(fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8"), "");
    const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    assert.deepEqual(Object.keys(claude).sort(), [...CLAUDE_KEYS].sort());
    // the skills enabled on claude.ai are not synced into the run
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8")), { syncClaudeAiSkills: false });
    assert.equal(fs.statSync(path.join(home, ".codex/auth.json")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("the profile environment points every CLI at the clean home", () => {
  const real = fakeRealHome();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-run-"));
  try {
    const { env, home, tmp } = withEnv({ CRB_REAL_HOME: real, CLAUDE_CONFIG_DIR: "/x", CODEX_HOME: "/y", FAKE_CODEX_OUTPUT: "/z", CRB_TEST: "", TMPDIR: "/host/shared/T/" },
      () => buildProfile(runDir, { env: { DATABASE_URL: "postgres://db", TMPDIR: "/elsewhere" } }));
    assert.equal(env.HOME, home);
    // the run's own temp dir: the host's is shared by every run on the machine
    assert.equal(tmp, path.join(runDir, "tmp"));
    assert.equal(env.TMPDIR, tmp);
    assert.equal(fs.statSync(tmp).isDirectory(), true);
    assert.equal(fs.statSync(tmp).mode & 0o777, 0o700);
    assert.equal(env.CODEX_HOME, path.join(home, ".codex"));
    assert.equal(env.DISABLE_AUTOUPDATER, "1");
    // no claude.ai connectors (Gmail, Drive, …) as MCP servers
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.DATABASE_URL, "postgres://db");
    assert.equal("CLAUDE_CONFIG_DIR" in env, false);
    assert.equal("FAKE_CODEX_OUTPUT" in env, false);
    assert.equal("CRB_REAL_HOME" in env, false);
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("FAKE_* variables reach the CLIs only in test mode", () => {
  const real = fakeRealHome();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-run-"));
  try {
    const { env } = withEnv({ CRB_REAL_HOME: real, FAKE_CODEX_OUTPUT: "/z", CRB_TEST: "1" }, () => buildProfile(runDir));
    assert.equal(env.FAKE_CODEX_OUTPUT, "/z");
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("missing login material is skipped, not invented", () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "crb-realhome-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-run-"));
  try {
    const { home } = withEnv({ CRB_REAL_HOME: real }, () => buildProfile(runDir));
    assert.deepEqual(listTree(home), [".claude/settings.json", ".codex/config.toml", `Library/Keychains -> ${path.join(real, "Library/Keychains")}`]);
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("Codex write-back copies a newer token home, after a backup, and never an older one", () => {
  const real = fakeRealHome();
  const crb = fs.mkdtempSync(path.join(os.tmpdir(), "crb-home-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-run-"));
  try {
    withEnv({ CRB_REAL_HOME: real, CRB_HOME: crb }, () => {
      const { home } = buildProfile(runDir);
      const copy = path.join(home, ".codex/auth.json");
      const orig = path.join(real, ".codex/auth.json");
      const before = fs.readFileSync(orig, "utf8");

      // unchanged copy: nothing written
      assert.equal(codexWriteBack(home).written, false);
      // older copy: nothing written
      fs.writeFileSync(copy, JSON.stringify({ tokens: { refresh_token: "r-older" }, last_refresh: "2026-09-01T00:00:00Z" }));
      assert.equal(codexWriteBack(home).written, false);
      assert.equal(fs.readFileSync(orig, "utf8"), before);
      assert.equal(fs.existsSync(path.join(crb, "auth-backups")) && fs.readdirSync(path.join(crb, "auth-backups")).length > 0, false);

      // newer copy: backup, then write
      const newer = JSON.stringify({ tokens: { refresh_token: "r-new" }, last_refresh: "2026-10-17T10:00:00Z" });
      fs.writeFileSync(copy, newer);
      const res = codexWriteBack(home);
      assert.equal(res.written, true);
      assert.equal(fs.readFileSync(orig, "utf8"), newer);
      assert.equal(fs.statSync(orig).mode & 0o777, 0o600);
      const backups = fs.readdirSync(path.join(crb, "auth-backups"));
      assert.equal(backups.length, 1);
      assert.equal(fs.readFileSync(path.join(crb, "auth-backups", backups[0]), "utf8"), before);
      assert.equal(fs.statSync(path.join(crb, "auth-backups", backups[0])).mode & 0o777, 0o600);
    });
  } finally {
    for (const d of [real, crb, runDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("write-back leaves the real token alone when there is none or the copy is unreadable", () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "crb-realhome-"));
  const crb = fs.mkdtempSync(path.join(os.tmpdir(), "crb-home-"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-run-"));
  try {
    withEnv({ CRB_REAL_HOME: real, CRB_HOME: crb }, () => {
      const { home } = buildProfile(runDir);
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(home, ".codex/auth.json"), JSON.stringify({ last_refresh: "2026-10-17T00:00:00Z" }));
      assert.equal(codexWriteBack(home).written, false);
      assert.equal(fs.existsSync(path.join(real, ".codex/auth.json")), false);
      fs.mkdirSync(path.join(real, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(real, ".codex/auth.json"), JSON.stringify({ last_refresh: "2026-10-01T00:00:00Z" }));
      fs.writeFileSync(path.join(home, ".codex/auth.json"), "{not json");
      assert.equal(codexWriteBack(home).written, false);
    });
  } finally {
    for (const d of [real, crb, runDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});
