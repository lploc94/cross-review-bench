import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLocation, anonymize, stripWorkspace, cleanText, seededShuffle, formatLocations } from "../lib/normalize.js";

const WS = "/tmp/crw/0721d92e/pager-js";

test("parseLocation reads every location form reviewers write", () => {
  const cases = [
    ["`src/a.ts:23-25`", [{ file: "src/a.ts", start: 23, end: 25 }]],
    ["src/a.ts:23", [{ file: "src/a.ts", start: 23, end: 23 }]],
    ["src/a.ts#L23-L25", [{ file: "src/a.ts", start: 23, end: 25 }]],
    // agy: a markdown link into the run's workspace, the anchor wins over the label's line
    ["[`src/pager.js:13`](file:///private/tmp/crw/0721d92e/pager-js/src/pager.js#L11-L14)", [{ file: "src/pager.js", start: 11, end: 14 }]],
    ["[src/a.ts](file:///tmp/crw/0721d92e/pager-js/src/a.ts#L7)", [{ file: "src/a.ts", start: 7, end: 7 }]],
    // several locations, separated by `,` or `;`
    ["src/a.ts:3, src/b.ts:9-10", [{ file: "src/a.ts", start: 3, end: 3 }, { file: "src/b.ts", start: 9, end: 10 }]],
    ["`src/a.ts:3`; `lib/c.go:40`", [{ file: "src/a.ts", start: 3, end: 3 }, { file: "lib/c.go", start: 40, end: 40 }]],
    // an absolute path inside the workspace becomes repo-relative
    ["/private/tmp/crw/0721d92e/pager-js/src/a.ts:5", [{ file: "src/a.ts", start: 5, end: 5 }]],
    ["/tmp/crw/0721d92e/pager-js/src/a.ts line 8", [{ file: "src/a.ts", start: 8, end: 8 }]],
    ["./src/a.ts:2", [{ file: "src/a.ts", start: 2, end: 2 }]],
    // a file without lines is still a file
    ["src/a.ts (function paginate)", [{ file: "src/a.ts", start: null, end: null }]],
    // nothing recognisable: still judged, with no file
    ["the pagination helper", [{ file: null, start: null, end: null }]],
    ["", [{ file: null, start: null, end: null }]],
  ];
  for (const [input, want] of cases) assert.deepEqual(parseLocation(input, WS), want, input);
});

test("parseLocation strips the given workspace root even outside /tmp/crw", () => {
  const ws = "/Users/x/.crbench/tmp/run/abcd/pager-js";
  assert.deepEqual(parseLocation(`${ws}/src/a.ts:4`, ws), [{ file: "src/a.ts", start: 4, end: 4 }]);
  assert.deepEqual(parseLocation(`[a](file://${ws}/src/a.ts#L4-L6)`, ws), [{ file: "src/a.ts", start: 4, end: 6 }]);
});

test("formatLocations writes ranges and unknown", () => {
  assert.equal(formatLocations([{ file: "a.ts", start: 3, end: 5 }, { file: "b.ts", start: 9, end: 9 }, { file: "c.ts", start: null, end: null }]), "a.ts:3-5, b.ts:9, c.ts");
  assert.equal(formatLocations([{ file: null, start: null, end: null }]), "unknown");
});

test("anonymize keeps the substance and drops what identifies a run or a reviewer", () => {
  const block = {
    id: 3, prefix: "ISSUE", title: "**`paginate`** accepts page `0`", category: "Bug", severity: "High",
    location: "[`src/pager.js:6`](file:///private/tmp/crw/0721d92e/pager-js/src/pager.js#L6)",
    problem: "[`paginate`](file:///private/tmp/crw/0721d92e/pager-js/src/pager.js#L4-L8) checks `page < 0`; see ISSUE-2 and https://example.com/docs.",
    evidence: "/tmp/crw/0721d92e/pager-js/src/pager.js:6",
    why_it_matters: "something only this reviewer writes",
    suggested_fix: "Use [`src/pager.js`](file:///private/tmp/crw/0721d92e/pager-js/src/pager.js#L6) `page <= 0`.",
    extra: { verdict: "REVISE" },
  };
  const a = anonymize(block, { workspaceRoot: WS });
  assert.deepEqual(Object.keys(a).sort(), ["category", "evidence", "location", "locations", "problem", "severity", "suggested_fix", "title"]);
  assert.equal(a.title, "paginate accepts page 0");
  assert.equal(a.category, "bug");
  assert.equal(a.severity, "high");
  assert.equal(a.location, "src/pager.js:6");
  assert.equal(a.problem, "`paginate` (`src/pager.js:4-8`) checks `page < 0`; see another finding and https://example.com/docs.");
  assert.equal(a.evidence, "src/pager.js:6");
  assert.equal(a.suggested_fix, "Use `src/pager.js:6` `page <= 0`.");
  const all = JSON.stringify(a);
  for (const leak of ["crw", "0721d92e", "file://", "ISSUE-", "only this reviewer", "REVISE"]) assert.ok(!all.includes(leak), leak);
});

test("cleanText keeps web links and strips run paths", () => {
  assert.equal(cleanText("[RFC](https://www.rfc-editor.org/rfc/rfc9110)", WS), "[RFC](https://www.rfc-editor.org/rfc/rfc9110)");
  assert.equal(stripWorkspace("cd /private/tmp/crw/deadbeef/other-repo/src && ls", null), "cd src && ls");
});

test("seededShuffle is deterministic per seed and a permutation", () => {
  const xs = Array.from({ length: 20 }, (_, i) => i);
  const a = seededShuffle(xs, "s1");
  assert.deepEqual(seededShuffle(xs, "s1"), a);
  assert.notDeepEqual(seededShuffle(xs, "s2"), a);
  assert.deepEqual([...a].sort((x, y) => x - y), xs);
});

test("stripWorkspace removes run paths written without a trailing slash", () => {
  const cases = [
    ["cd /private/tmp/crw/0721d92e/pager-js && npm test", "cd . && npm test"],
    ["(`/tmp/crw/0721d92e/pager-js`)", "(`.`)"],
    ["ran in /tmp/crw/0721d92e, then", "ran in ., then"],
    ["/tmp/crw/0721d92e/pager-js/src/a.js:3", "src/a.js:3"],
    // another run's workspace, with or without the slash
    ["see /tmp/crw/1a2b3c4d/other-repo: ok", "see .: ok"],
  ];
  for (const [text, want] of cases) {
    assert.equal(stripWorkspace(text, WS), want, text);
    assert.ok(!/[0-9a-f]{8}/.test(stripWorkspace(text, null)), text);
  }
  // a longer name that only starts like the workspace is a different directory, still a run path
  assert.equal(stripWorkspace("/tmp/crw/0721d92e/pager-jsx/a.js", WS), "a.js");
});
