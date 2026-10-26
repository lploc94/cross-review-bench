import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../../src/pager.js";

test("page 0 is rejected", () => {
  assert.throws(() => paginate([1, 2, 3], 0, 2), RangeError);
});
