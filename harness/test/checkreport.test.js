// crb check-report (Phase 22): every number in a marked leaderboard table equals leaderboard.json at
// the precision the cell shows. Systems and values are invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReport, parseMarkedTables } from "../lib/checkreport.js";

const LB = {
  leaderboard: [
    { system: "alpha-high", rank: 1, f1: 0.51234, f1_lo: 0.4801, f1_hi: 0.5507, false_alarm_rate: 0.125, median_output_tokens: 4531, realbug_f1: null },
    { system: "beta-high", rank: 2, f1: 0.40449, f1_lo: 0.3712, f1_hi: 0.4433, false_alarm_rate: 0.25, median_output_tokens: 2748, realbug_f1: null },
  ],
};

const table = (rows, columns = "system,rank,f1,false_alarm_rate,median_output_tokens,realbug_f1") => [
  "Some text before.",
  "",
  `<!-- crb:leaderboard columns=${columns} -->`,
  "| System | Rank | F1 [95% CI] | False alarms | Output tokens | Real-bug F1 |",
  "|---|---|---|---|---|---|",
  ...rows,
  "",
  "Text after the table | with a pipe.",
].join("\n");

const GOOD = [
  "| `alpha-high` | 1 | 0.512 [0.480, 0.551] | 12.5% | 4,531 | — |",
  "| **beta-high** | 2 | 0.40 [0.37, 0.44] | 25% | 2748 | n/a |",
];

test("a table that matches leaderboard.json passes, at the precision each cell shows", () => {
  const out = checkReport([{ name: "REPORT.md", text: table(GOOD) }], LB);
  assert.deepEqual(out.problems, []);
  assert.equal(out.tables, 1);
  assert.equal(out.cells, 10);
});

test("a wrong value, a wrong CI bound, a wrong percentage and a value shown for a null all fail", () => {
  const cases = [
    ["| alpha-high | 1 | 0.513 [0.480, 0.551] | 12.5% | 4531 | — |", /f1/],
    ["| alpha-high | 1 | 0.512 [0.470, 0.551] | 12.5% | 4531 | — |", /f1_lo/],
    ["| alpha-high | 1 | 0.512 [0.480, 0.551] | 12.4% | 4531 | — |", /false_alarm_rate/],    ["| alpha-high | 1 | 0.512 [0.480, 0.551] | 12.5% | 4531 | 0.3 |", /realbug_f1/],
    ["| alpha-high | 1 | 0.512 [0.480, 0.551] | 12.5% | — | — |", /median_output_tokens/],
    ["| alpha-high | 2 | 0.512 [0.480, 0.551] | 12.5% | 4531 | — |", /rank/],
  ];
  for (const [row, why] of cases) {
    const out = checkReport([{ name: "REPORT.md", text: table([row, GOOD[1]]) }], LB);
    assert.equal(out.problems.length, 1, row);
    assert.match(out.problems[0], why);
    assert.match(out.problems[0], /REPORT\.md/);
  }
});

test("an unknown system or field, a column count mismatch, and a file without a marked table fail", () => {
  assert.match(checkReport([{ name: "A.md", text: table(["| gamma-high | 1 | 0.5 | 1% | 1 | — |"]) }], LB).problems[0], /gamma-high/);
  assert.match(checkReport([{ name: "A.md", text: table(GOOD, "system,rank,f2,false_alarm_rate,median_output_tokens,realbug_f1") }], LB).problems[0], /f2/);
  assert.match(checkReport([{ name: "A.md", text: table(GOOD, "system,rank,f1") }], LB).problems[0], /3 columns.*6 cells|columns/);
  assert.match(checkReport([{ name: "ARTICLE.md", text: "| a | b |\n|---|---|\n| 1 | 2 |\n" }], LB).problems[0], /ARTICLE\.md.*no marked/);
  // a marked table without a system column cannot be checked
  assert.match(checkReport([{ name: "A.md", text: table(["| 1 | 1 | 0.5 | 1% | 1 | — |"], "rank,rank,f1,false_alarm_rate,median_output_tokens,realbug_f1") }], LB).problems[0], /system/);
});

test("every marked table in every file is read; unmarked tables are ignored", () => {
  const text = `${table(GOOD)}\n\n| unmarked | 9 |\n|---|---|\n| x | 9 |\n\n${table([GOOD[0]], "system,rank,f1,false_alarm_rate,median_output_tokens,realbug_f1")}`;
  assert.equal(parseMarkedTables(text).length, 2);
  const out = checkReport([{ name: "REPORT.md", text }, { name: "ARTICLE.md", text: table([GOOD[1]]) }], LB);
  assert.deepEqual(out.problems, []);
  assert.equal(out.tables, 3);
});
