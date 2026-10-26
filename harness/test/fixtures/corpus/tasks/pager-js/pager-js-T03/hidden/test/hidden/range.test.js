import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRange } from "../../src/pager.js";

test("pageRange is inclusive", () => {
  assert.deepEqual(pageRange([1, 2, 3, 4, 5], 2, 2), { first: 2, last: 3 });
  assert.deepEqual(pageRange([1, 2, 3, 4, 5], 3, 2), { first: 4, last: 4 });
  assert.equal(pageRange([1, 2], 2, 2), null);
});
