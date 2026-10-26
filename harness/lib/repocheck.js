// crb repo-check: a corpus repo is "production-grade" when it passes every rule below (plan Phase 3).
//
// Static rules read the repo as committed; the command rules (tests, typecheck, lint) run in a scratch
// copy with dependencies, caches and its own services lease, like validation.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sh, tail, cleanEnv, interrupted } from "./exec.js";
import { scratchDir } from "./paths.js";
import { prepareDeps, toolchainEnv } from "./cache.js";
import { taskServices } from "./services.js";

export const THRESHOLDS = { loc: 4000, sourceFiles: 20, layers: 3, visibleTests: 60, typedErrors: 2 };

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".go", ".java"]);
// not authored here, or build output
const SKIP_DIRS = new Set([".git", "node_modules", "vendor", "third_party", ".venv", "venv", "dist", "build", "target", "out", "coverage", "gen", "generated", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
// build output that can sit in a checkout; never part of the committed repo
const NEVER_SCAN = new Set([".git", "node_modules", ".venv", "venv", "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"]);
// third-party code copied in: its TODOs and words are not ours to clean (still copied for the command rules)
const NOT_OURS = new Set([...NEVER_SCAN, "vendor", "third_party"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "testdata", "spec", "e2e"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|^test_.*\.py$|_test\.py$|^conftest\.py$|(Test|Tests|IT)\.java$/;
const GENERATED = /Code generated|@generated|DO NOT EDIT/;

const LAYER_DIRS = {
  api: ["api", "apis", "handler", "handlers", "http", "routes", "router", "routers", "controller", "controllers", "rest", "grpc", "web", "transport", "endpoints", "resources"],
  domain: ["domain", "service", "services", "core", "model", "models", "usecase", "usecases", "application", "app", "logic", "business"],
  persistence: ["persistence", "repo", "repos", "repository", "repositories", "store", "stores", "storage", "db", "database", "dal", "dao", "integration", "integrations", "infra", "infrastructure", "adapter", "adapters", "client", "clients"],
};
const MIGRATION_DIRS = new Set(["migrations", "migration", "migrate"]);

const CONFIG_NAME = /^(config|configuration|settings|env|.*config|.*settings)$/i;
const ENV_READ = /process\.env|os\.environ|os\.getenv|os\.Getenv|os\.LookupEnv|System\.getenv|@ConfigurationProperties|BaseSettings|@Value\(/;
const VALIDATES = /z\.object|\bzod\b|pydantic|BaseSettings|[Vv]alidat|\bthrow\b|\braise\b|errors\.New|fmt\.Errorf|@NotNull|@NotBlank|Joi\.|\.parse\(/;
const STRUCTURED_LOG = /\bpino\b|\bwinston\b|\bbunyan\b|\bstructlog\b|python-json-logger|pythonjsonlogger|log\/slog|go\.uber\.org\/zap|\bzerolog\b|\blogrus\b|logstash-logback-encoder|net\.logstash|JsonLayout|JsonTemplateLayout|ecs-logging/;
const LOG_MANIFESTS = /^(package\.json|pyproject\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|logback.*\.xml|log4j2.*\.xml)$/;
const TYPED_ERRORS = [
  /class\s+(\w+(?:Error|Exception))\s+extends\s+[\w.]*(?:Error|Exception)\b/g,
  /class\s+(\w+(?:Error|Exception))\s*\(\s*[\w.]*(?:Error|Exception)\s*\)/g,
  /type\s+(\w+Error)\s+struct\b/g,
  /\b(Err\w+)\s*=\s*errors\.New\(/g,
];
const TEST_CASES = {
  js: /\b(?:it|test)(?:\.(?:each|concurrent|only)\b[^(]*\([^)]*\))?\s*\(\s*["'`]/g,
  py: /^\s*(?:async\s+)?def\s+test_\w*\s*\(/gm,
  go: /^func\s+Test\w*\s*\(\s*\w+\s+\*testing\.T\s*\)|\bt\.Run\(/gm,
  java: /@(?:Test|ParameterizedTest|RepeatedTest)\b/g,
};
const MARKERS = /\b(TODO|FIXME|XXX)\b/;
const BENCH_WORDS = /\b(planted|bench|crb|decoy)\b/gi;

const langOf = f => ({ ".py": "py", ".go": "go", ".java": "java" })[path.extname(f)] ?? "js";

/** Files under dir (relative paths), not descending into `skip` directories. */
function walk(dir, skip, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (!skip.has(e.name)) out.push(...walk(dir, skip, r)); }
    else if (e.isFile()) out.push(r);
  }
  return out;
}

function isTestPath(rel) {
  const parts = rel.split(path.sep);
  if (parts.slice(0, -1).some(p => TEST_DIRS.has(p))) return true;
  if (rel.split(path.sep).join("/").includes("src/test/")) return true;
  return TEST_FILE.test(parts.at(-1));
}

/** Code lines of a source file: blank lines, comments and Python docstrings do not count. */
export function countLoc(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let n = 0;
  if (langOf(file) === "py") {
    let inDoc = null;
    for (const line of lines) {
      const t = line.trim();
      if (inDoc) { if (t.includes(inDoc)) inDoc = null; continue; }
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^[rRbBuU]?("""|''')/);
      if (m) { if (!t.slice(m[0].length).includes(m[1])) inDoc = m[1]; continue; }
      n++;
    }
    return n;
  }
  let inBlock = false;
  for (let s of lines) {
    let code = false;
    while (s.length) {
      if (inBlock) {
        const e = s.indexOf("*/");
        if (e < 0) break;
        s = s.slice(e + 2);
        inBlock = false;
        continue;
      }
      if (s.trimStart().startsWith("//")) break;
      const b = s.indexOf("/*");
      if (b < 0) { if (s.trim()) code = true; break; }
      if (s.slice(0, b).trim()) code = true;
      s = s.slice(b + 2);
      inBlock = true;
    }
    if (code) n++;
  }
  return n;
}

function isText(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

function staticRules(repoDir, cfg) {
  const results = [];
  const push = (rule, ok, detail) => results.push({ rule, ok, detail });
  const files = walk(repoDir, SKIP_DIRS);
  const read = rel => fs.readFileSync(path.join(repoDir, rel), "utf8");
  const sources = files.filter(f => SOURCE_EXT.has(path.extname(f)) && !isTestPath(f) && !GENERATED.test(read(f).split("\n").slice(0, 5).join("\n")));
  const tests = files.filter(f => SOURCE_EXT.has(path.extname(f)) && isTestPath(f));

  const loc = sources.reduce((a, f) => a + countLoc(path.join(repoDir, f)), 0);
  push("loc", loc >= THRESHOLDS.loc, `${loc} code lines outside tests, generated and vendored code (need ${THRESHOLDS.loc})`);
  push("source_files", sources.length >= THRESHOLDS.sourceFiles, `${sources.length} source files (need ${THRESHOLDS.sourceFiles})`);

  const layers = Object.entries(LAYER_DIRS).filter(([, names]) => sources.some(f => f.split(path.sep).slice(0, -1).some(p => names.includes(p.toLowerCase())))).map(([k]) => k);
  push("layers", layers.length >= THRESHOLDS.layers, `layers found: ${layers.join(", ") || "none"} (need API/handler, domain/service, persistence/integration)`);

  if ((cfg.services ?? []).includes("postgres")) {
    const mig = files.filter(f => f.split(path.sep).slice(0, -1).some(p => MIGRATION_DIRS.has(p.toLowerCase())));
    push("migrations", mig.length > 0, mig.length ? `${mig.length} migration files` : "the repo uses postgres but has no migrations folder");
  }

  const configs = sources.filter(f => CONFIG_NAME.test(path.basename(f, path.extname(f))) && ENV_READ.test(read(f)) && VALIDATES.test(read(f)));
  push("config_module", configs.length > 0, configs.length ? `config module: ${configs.join(", ")}` : "no config module that reads and validates the environment");

  const logFiles = [...sources, ...files.filter(f => LOG_MANIFESTS.test(path.basename(f)))].filter(f => STRUCTURED_LOG.test(read(f)));
  push("structured_logging", logFiles.length > 0, logFiles.length ? `structured logging in ${logFiles.slice(0, 3).join(", ")}` : "no structured logging library in sources or manifests");

  const errors = new Set();
  for (const f of sources) for (const re of TYPED_ERRORS) for (const m of read(f).matchAll(re)) errors.add(m[1]);
  push("typed_errors", errors.size >= THRESHOLDS.typedErrors, `${errors.size} typed errors${errors.size ? `: ${[...errors].slice(0, 6).join(", ")}` : ""} (need ${THRESHOLDS.typedErrors})`);

  const testCount = tests.reduce((a, f) => a + (read(f).match(TEST_CASES[langOf(f)]) ?? []).length, 0);
  push("visible_tests", testCount >= THRESHOLDS.visibleTests, `${testCount} visible tests (need ${THRESHOLDS.visibleTests})`);

  const readme = fs.readdirSync(repoDir).find(f => /^readme\.md$/i.test(f));
  const rtext = readme ? read(readme) : "";
  const runSec = /^#{1,6}\s+.*\b(run|running|usage|getting started|quick ?start|start)\b/im.test(rtext);
  const testSec = /^#{1,6}\s+.*\btest/im.test(rtext);
  push("readme", runSec && testSec, readme ? `README run section: ${runSec ? "yes" : "no"}, test section: ${testSec ? "yes" : "no"}` : "no README.md");

  const allow = new Set((cfg.allow_words ?? []).map(w => w.toLowerCase()));
  const marks = [];
  const words = [];
  for (const f of walk(repoDir, NOT_OURS)) {
    if (f === "crb-repo.json") continue;
    for (const m of f.matchAll(BENCH_WORDS)) if (!allow.has(m[1].toLowerCase())) words.push(`${f} (file name)`);
    if (!isText(path.join(repoDir, f))) continue;
    read(f).split("\n").forEach((line, i) => {
      if (MARKERS.test(line)) marks.push(`${f}:${i + 1}`);
      for (const m of line.matchAll(BENCH_WORDS)) if (!allow.has(m[1].toLowerCase())) words.push(`${f}:${i + 1} "${m[1]}"`);
    });
  }
  push("no_markers", marks.length === 0, marks.length ? `TODO/FIXME/XXX at ${marks.slice(0, 5).join(", ")}` : "no TODO/FIXME/XXX");
  push("no_bench_words", words.length === 0, words.length ? `bench-revealing words at ${words.slice(0, 5).join(", ")}` : "no bench-revealing words");
  return results;
}

async function commandRules(repoDir, cfg, { services, timeoutMs }) {
  const results = [];
  const cmds = [["test_cmd", cfg.test_cmd], ["typecheck_cmd", cfg.typecheck_cmd], ["lint_cmd", cfg.lint_cmd]];
  const root = path.join(scratchDir(), `repocheck-${crypto.randomBytes(4).toString("hex")}`);
  const ws = path.join(root, path.basename(repoDir));
  const task = { repo: path.basename(repoDir), repoConfig: cfg };
  const svc = services(task);
  const hex = crypto.randomBytes(4).toString("hex");
  let leased = false;
  try {
    fs.cpSync(repoDir, ws, { recursive: true, verbatimSymlinks: true, filter: src => !NEVER_SCAN.has(path.basename(src)) || src === repoDir });
    fs.rmSync(path.join(ws, "crb-repo.json"), { force: true });
    const svcEnv = await svc.provision(hex);
    leased = true;
    const env = cleanEnv({ ...toolchainEnv({ scratch: root }), ...svcEnv });
    await prepareDeps(task, ws, { ...svcEnv, GOCACHE: env.GOCACHE });
    for (const [rule, cmd] of cmds) {
      if (!cmd) { results.push({ rule, ok: false, detail: `${rule} is not set in crb-repo.json` }); continue; }
      const r = await sh(cmd, { cwd: ws, env, timeoutMs });
      const ok = !interrupted(r) && r.code === 0;
      results.push({ rule, ok, detail: ok ? `${cmd}: passed` : `${cmd}: ${interrupted(r) ? "did not finish" : `exit ${r.code}`}\n${tail(r)}` });
    }
  } catch (e) {
    for (const [rule] of cmds) if (!results.some(r => r.rule === rule)) results.push({ rule, ok: false, detail: `could not run: ${e.message}` });
  } finally {
    if (leased) await svc.release(hex).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
  return results;
}

/**
 * Check one corpus repo. opts: services (factory as in validate.js; default the real services),
 * timeoutMs per command. Resolves { repo, ok, results: [{rule, ok, detail}] }.
 */
export async function checkRepo(repoDir, { services = taskServices, timeoutMs = 1_800_000 } = {}) {
  const repo = path.basename(repoDir);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(repoDir, "crb-repo.json"), "utf8"));
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("not an object");
  } catch (e) {
    return { repo, ok: false, results: [{ rule: "crb_repo_json", ok: false, detail: `crb-repo.json: ${e.message}` }] };
  }
  const results = [...staticRules(repoDir, cfg), ...(await commandRules(repoDir, cfg, { services, timeoutMs }))];
  return { repo, ok: results.every(r => r.ok), results };
}
