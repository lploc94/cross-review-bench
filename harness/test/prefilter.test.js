import { test } from "node:test";
import assert from "node:assert/strict";
import { prefilter, findingsFor, locationOverlaps, PREFILTER_SLACK } from "../lib/grade/prefilter.js";
import { parseLocation } from "../lib/normalize.js";

const targets = [
  { id: "B1", file: "src/pager.js", lines: [6, 6] },
  { id: "B2", file: "src/pager.js", lines: [40, 42] },
  { id: "D1", file: "src/range.js", lines: [12, 12] },
];
const f = loc => ({ locations: parseLocation(loc, null) });

test("prefilter: near within its slack, same file at any line, unknown files reach every target", () => {
  assert.deepEqual(prefilter(f("src/pager.js:8"), targets), { near: ["B1"], same_file: ["B1", "B2"], unknown: false, candidates: ["B1", "B2"] });
  assert.deepEqual(prefilter(f(`src/pager.js:${42 + PREFILTER_SLACK}`), targets).near, ["B2"]);
  assert.deepEqual(prefilter(f(`src/pager.js:${42 + PREFILTER_SLACK + 1}`), targets).near, []);
  // basename-only and absolute forms name the same file; another directory does not
  assert.deepEqual(prefilter(f("pager.js:6"), targets).near, ["B1"]);
  assert.deepEqual(prefilter(f("lib/pager.js:6"), targets).same_file, []);
  // a file without lines is the same file but near nothing
  assert.deepEqual(prefilter(f("src/range.js"), targets), { near: [], same_file: ["D1"], unknown: false, candidates: ["D1"] });
  assert.deepEqual(prefilter(f("the helper"), targets), { near: [], same_file: [], unknown: true, candidates: ["B1", "B2", "D1"] });
});

test("findingsFor keeps findings naming the target's file or no file", () => {
  const fs = [f("src/pager.js:99"), f("src/range.js:12"), f("somewhere"), f("src/other.js:6")];
  assert.deepEqual(findingsFor(fs, targets[0]), [fs[0], fs[2]]);
});

test("locationOverlaps is the ±3 location-accuracy rule", () => {
  assert.equal(locationOverlaps(parseLocation("src/pager.js:9", null), targets[0]), true);
  assert.equal(locationOverlaps(parseLocation("src/pager.js:10", null), targets[0]), false);
  assert.equal(locationOverlaps(parseLocation("src/pager.js", null), targets[0]), false);
});
