import { test } from "node:test";
import assert from "node:assert/strict";
import { run, sh } from "../lib/exec.js";

test("a command that exits without reading its stdin is not an error", async () => {
  // 8 MB never fits the pipe: writing it to `true` meets a closed pipe (EPIPE)
  const big = "x".repeat(8 * 1024 * 1024);
  for (let i = 0; i < 5; i++) {
    const r = await run("true", [], { input: big });
    assert.equal(r.code, 0);
  }
  assert.equal((await sh("exit 3", { input: big })).code, 3);
});
