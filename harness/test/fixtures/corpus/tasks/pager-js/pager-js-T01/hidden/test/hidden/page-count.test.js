import { test } from "node:test";
import assert from "node:assert/strict";
import { pageCount } from "../../src/pager.js";

test("a partial last page counts", () => {
  assert.equal(pageCount([1, 2, 3, 4, 5, 6, 7], 3), 3);
  assert.equal(pageCount([], 3), 0);
});
