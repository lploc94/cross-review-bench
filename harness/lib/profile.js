// Clean profile per run (F3) and the Codex token write-back (F4).
//
// A run's HOME holds only the CLIs' login material, copied from the real home: no skills, MCP
// servers, plugins, instructions or memory (I2). The real home is only read, except for the Codex
// token write-back, which backs up the original first (I4).

import fs from "node:fs";
import path from "node:path";
import { realHome, authBackupsDir } from "./paths.js";
import { withLockSync, writeAtomic } from "./store.js";

export const CLAUDE_KEYS = ["oauthAccount", "userID", "hasCompletedOnboarding", "lastOnboardingVersion", "firstStartTime"];
const GEMINI_FILES = ["oauth_creds.json", "google_accounts.json", "state.json", "installation_id"];
const AGY_FILES = ["settings.json", "jetski_state.pbtxt"];
const HOST_ENV = ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];

function copyIfExists(src, dest, mode = 0o600) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, mode);
  return true;
}

/**
 * Build `<runDir>/home`, the run's own temp dir `<runDir>/tmp` (TMPDIR; the host's is shared by every
 * run on the machine) and the environment every reviewer CLI of the run gets. macOS `mktemp` without
 * a template still uses the user's temp dir (_CS_DARWIN_USER_TEMP_DIR comes before TMPDIR): its names
 * are random, and the audit flags any listing or glob that could reach another run's (shared_tmp).
 * `env` adds run variables (services, caches). Returns { home, tmp, env }.
 */
export function buildProfile(runDir, { env: extra = {} } = {}) {
  const real = realHome();
  const home = path.join(runDir, "home");
  const tmp = path.join(runDir, "tmp");
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, "Library"), { recursive: true });

  copyIfExists(path.join(real, ".codex", "auth.json"), path.join(home, ".codex", "auth.json"));
  // an empty config: no MCP servers or profiles; the cross-review installer reads it in Track C
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
  // Claude Code and agy find their login in the Keychain (spike S1)
  fs.symlinkSync(path.join(real, "Library", "Keychains"), path.join(home, "Library", "Keychains"));

  const claudeJson = path.join(real, ".claude.json");
  if (fs.existsSync(claudeJson)) {
    const src = JSON.parse(fs.readFileSync(claudeJson, "utf8"));
    const kept = Object.fromEntries(CLAUDE_KEYS.filter(k => k in src).map(k => [k, src[k]]));
    writeAtomic(path.join(home, ".claude.json"), JSON.stringify(kept, null, 2) + "\n", 0o600);
  }
  // the login would otherwise bring the skills enabled on claude.ai into the run
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ syncClaudeAiSkills: false }, null, 2) + "\n");
  for (const f of GEMINI_FILES) copyIfExists(path.join(real, ".gemini", f), path.join(home, ".gemini", f));
  for (const f of AGY_FILES) copyIfExists(path.join(real, ".gemini", "antigravity-cli", f), path.join(home, ".gemini", "antigravity-cli", f));

  return { home, tmp, env: profileEnv(home, { ...extra, TMPDIR: tmp }) };
}

/**
 * Host basics, the clean HOME, CODEX_HOME, no auto-update, and no claude.ai connectors as MCP servers
 * (the login would otherwise bring them); CLAUDE_CONFIG_DIR is never set (spike S1).
 */
export function profileEnv(home, extra = {}) {
  const env = {};
  for (const k of HOST_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  // the harness's own tests drive fake CLIs through FAKE_* variables (cross-review test helpers)
  if (process.env.CRB_TEST === "1") {
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith("FAKE_")) env[k] = v;
  }
  return { ...env, ...extra, HOME: home, CODEX_HOME: path.join(home, ".codex"), DISABLE_AUTOUPDATER: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" };
}

function lastRefresh(file) {
  try {
    const t = Date.parse(JSON.parse(fs.readFileSync(file, "utf8")).last_refresh);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

/**
 * F4: when Codex refreshed its token inside the run's copy, the refresh token may have rotated and
 * the original may no longer work. Copy the newer token back, after backing up the original.
 */
export function codexWriteBack(profileHome) {
  const copy = path.join(profileHome, ".codex", "auth.json");
  const orig = path.join(realHome(), ".codex", "auth.json");
  return withLockSync("codex-auth", () => {
    const copyT = lastRefresh(copy);
    const origT = lastRefresh(orig);
    if (copyT === null || origT === null || copyT <= origT) return { written: false };
    const backup = path.join(authBackupsDir(), `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.mkdirSync(authBackupsDir(), { recursive: true, mode: 0o700 });
    writeAtomic(backup, fs.readFileSync(orig), 0o600);
    writeAtomic(orig, fs.readFileSync(copy), 0o600);
    return { written: true, backup };
  });
}
