import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRepo, countLoc } from "../lib/repocheck.js";

// Invented TypeScript-shaped project; only file shapes matter, nothing here is compiled.
const LAYERS = ["api", "domain", "persistence"];

function makeRepo(over = {}) {
  const o = {
    files: 21, linesPerFile: 200, layers: LAYERS, migrations: true, config: true, logger: true, errors: true,
    tests: 60, readme: "# Shop\n\n## Running\n\nnpm start\n\n## Tests\n\nnpm test\n",
    repoConfig: { language: "ts", test_cmd: "true", typecheck_cmd: "true", lint_cmd: "true", deps_cmd: null, warm_cmd: null, services: ["postgres"], allow_words: [] },
    extra: {},
    ...over,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crb-repocheck-"));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  for (let i = 0; i < o.files; i++) {
    const layer = o.layers[i % o.layers.length];
    const body = Array.from({ length: o.linesPerFile }, (_, j) => `export const v${i}_${j} = ${j} + ${i};`).join("\n");
    w(`src/${layer}/m${i}.ts`, body + "\n");
  }
  if (o.config) w("src/config.ts", 'import { z } from "zod";\nconst Env = z.object({ PORT: z.string() });\nexport const config = Env.parse(process.env);\n');
  if (o.logger) w("src/log.ts", 'import pino from "pino";\nexport const logger = pino();\nlogger.debug("ready");\n');
  if (o.errors) w("src/errors.ts", "export class NotFoundError extends Error {}\nexport class ConflictError extends Error {}\n");
  if (o.migrations) w("migrations/001_init.sql", "CREATE TABLE t (id int);\n");
  w("test/app.test.ts", Array.from({ length: o.tests }, (_, i) => `test("case ${i}", () => {});`).join("\n") + "\n");
  if (o.readme !== null) w("README.md", o.readme);
  w("crb-repo.json", JSON.stringify(o.repoConfig));
  for (const [rel, text] of Object.entries(o.extra)) w(rel, text);
  return dir;
}

const noServices = () => ({ provision: async () => ({}), release: async () => {} });

async function check(over) {
  const dir = makeRepo(over);
  try {
    return await checkRepo(dir, { services: noServices });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const failed = res => res.results.filter(r => !r.ok).map(r => r.rule);

test("a repo meeting every rule passes", async () => {
  const res = await check();
  assert.deepEqual(failed(res), [], JSON.stringify(res.results, null, 1));
  assert.equal(res.ok, true);
});

test("each threshold below its limit fails naming the rule", async () => {
  assert.deepEqual(failed(await check({ linesPerFile: 180 })), ["loc"]);
  // 16 + config, log and errors = 19 source files
  assert.deepEqual(failed(await check({ files: 16, linesPerFile: 260 })), ["source_files"]);
  assert.deepEqual(failed(await check({ layers: ["api", "domain"] })), ["layers"]);
  assert.deepEqual(failed(await check({ migrations: false })), ["migrations"]);
  assert.deepEqual(failed(await check({ config: false })), ["config_module"]);
  assert.deepEqual(failed(await check({ logger: false })), ["structured_logging"]);
  assert.deepEqual(failed(await check({ errors: false })), ["typed_errors"]);
  assert.deepEqual(failed(await check({ tests: 59 })), ["visible_tests"]);
  assert.deepEqual(failed(await check({ readme: "# Shop\n\n## Running\n\nnpm start\n" })), ["readme"]);
  assert.deepEqual(failed(await check({ readme: null })), ["readme"]);
});

test("a repo without postgres needs no migrations folder", async () => {
  const base = { language: "ts", test_cmd: "true", typecheck_cmd: "true", lint_cmd: "true", services: [], allow_words: [] };
  assert.deepEqual(failed(await check({ migrations: false, repoConfig: base })), []);
});

test("test, typecheck and lint commands must exist and pass", async () => {
  const cfg = c => ({ repoConfig: { language: "ts", test_cmd: "true", typecheck_cmd: "true", lint_cmd: "true", services: ["postgres"], allow_words: [], ...c } });
  assert.deepEqual(failed(await check(cfg({ test_cmd: "exit 3" }))), ["test_cmd"]);
  assert.deepEqual(failed(await check(cfg({ typecheck_cmd: "false" }))), ["typecheck_cmd"]);
  assert.deepEqual(failed(await check(cfg({ lint_cmd: null }))), ["lint_cmd"]);
});

test("leftover markers and bench-revealing words fail; logger.debug does not", async () => {
  assert.deepEqual(failed(await check({ extra: { "src/api/x.ts": "// TODO tidy later\nexport const a = 1;\n" } })), ["no_markers"]);
  assert.deepEqual(failed(await check({ extra: { "docs/notes.md": "This handler is a decoy.\n" } })), ["no_bench_words"]);
  assert.deepEqual(failed(await check({ extra: { "scripts/Bench.sh": "echo hi\n" } })), ["no_bench_words"], "file names count too");
  assert.deepEqual(failed(await check({ extra: { "src/api/y.ts": 'logger.debug("x"); const benchmark = 1; const todo_list = [];\n' } })), []);
  assert.deepEqual(failed(await check({ extra: { "vendor/github.com/acme/retry/retry.go": "// TODO(upstream): drop the bench helper\npackage retry\n", "third_party/lib/x.ts": "// XXX decoy\n" } })), [], "vendored code is not ours");
  const allowed = { language: "ts", test_cmd: "true", typecheck_cmd: "true", lint_cmd: "true", services: ["postgres"], allow_words: ["bench"] };
  assert.deepEqual(failed(await check({ repoConfig: allowed, extra: { "docs/gym.md": "Use the bench press.\n" } })), [], "allow_words");
});

test("LOC excludes comments, blank lines, tests, generated and vendored code", async () => {
  // padded with comments: 21 more files of 500 lines each, only 100 of them code (3,788 code lines in all)
  const padded = Array.from({ length: 21 }, (_, i) => [`src/${LAYERS[i % 3]}/pad${i}.ts`,
    Array.from({ length: 100 }, (_, j) => `// note ${j}\n\n/* block\n   still block */\nexport const p${i}_${j} = ${j};`).join("\n")]);
  assert.deepEqual(failed(await check({ linesPerFile: 80, extra: Object.fromEntries(padded) })), ["loc"]);
  const notCounted = {
    "test/big.test.ts": Array.from({ length: 3000 }, (_, j) => `const t${j} = ${j};`).join("\n"),
    "src/gen/api.ts": "// Code generated by openapi. DO NOT EDIT.\n" + Array.from({ length: 3000 }, (_, j) => `export const g${j} = ${j};`).join("\n"),
    "vendor/lib/x.go": Array.from({ length: 3000 }, (_, j) => `var X${j} = ${j}`).join("\n"),
    "dist/app.js": Array.from({ length: 3000 }, (_, j) => `var d${j} = ${j};`).join("\n"),
  };
  assert.deepEqual(failed(await check({ linesPerFile: 180, extra: notCounted })), ["loc"]);
  // python docstrings and # comments are not code
  const py = path.join(os.tmpdir(), `crb-loc-${process.pid}.py`);
  fs.writeFileSync(py, '"""Module docs.\n\nMore docs.\n"""\n# comment\nimport os\n\n\ndef f():\n    """Doc."""\n    return os.sep  # trailing comment counts as code\n');
  try {
    assert.equal(countLoc(py), 3);
  } finally {
    fs.rmSync(py, { force: true });
  }
});

test("each rule's detail says what was found", async () => {
  const res = await check({ tests: 59 });
  const r = res.results.find(x => x.rule === "visible_tests");
  assert.match(r.detail, /59/);
  assert.match(res.results.find(x => x.rule === "loc").detail, /\d+/);
});
