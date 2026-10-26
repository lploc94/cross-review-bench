import { test } from "node:test";
import assert from "node:assert/strict";
import { hasNextPage } from "../../src/pager.js";

test("hasNextPage", () => {
  assert.equal(hasNextPage([1, 2, 3, 4, 5], 2, 2), true);
  assert.equal(hasNextPage([1, 2, 3, 4], 2, 2), false);
});
