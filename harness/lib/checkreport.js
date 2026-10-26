// crb check-report (Phase 22): every number in the leaderboard tables of REPORT.md and ARTICLE.md
// equals results/leaderboard.json. A table is checked when the line before it (blank lines allowed)
// is `<!-- crb:leaderboard columns=system,f1,… -->`, naming the leaderboard.json field of each column.
// A cell's first number is the field at the precision the cell shows; a `[lo, hi]` pair is
// `<field>_lo`/`<field>_hi`; a number with `%` is the field ×100; "—", "-", "n/a" or an empty cell
// stands for null.

const MARKER = /^\s*<!--\s*crb:leaderboard\s+columns=([\w,\s]+?)\s*-->\s*$/;
const NUMBER = /[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g;
const NULLS = new Set(["", "—", "–", "-", "n/a", "na"]);

const cellsOf = line => {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return s.split("|").map(c => c.trim());
};
const plain = cell => cell.replace(/[`*_]/g, "").trim();

/** Marked tables in a markdown text: [{ line, columns, header, rows: [{ line, cells }] }]; line numbers 1-based. */
export function parseMarkedTables(text) {
  const lines = text.split("\n");
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i]);
    if (!m) continue;
    const columns = m[1].split(",").map(c => c.trim()).filter(Boolean);
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const table = { line: i + 1, columns, header: null, rows: [] };
    if (j + 1 < lines.length && lines[j].trim().startsWith("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[j + 1])) {
      table.header = cellsOf(lines[j]);
      for (j += 2; j < lines.length && lines[j].trim().startsWith("|"); j++) table.rows.push({ line: j + 1, cells: cellsOf(lines[j]) });
    }
    tables.push(table);
  }
  return tables;
}

const parseNumber = s => {
  const percent = s.endsWith("%");
  const digits = s.replace(/%$/, "").replace(/,/g, "").replace("−", "-");
  const decimals = digits.includes(".") ? digits.split(".")[1].length : 0;
  return { shown: Number(digits), decimals, percent };
};

// the shown number equals the value rounded to the shown decimals (either way at an exact half)
const matches = (value, { shown, decimals, percent }) => {
  const v = percent ? value * 100 : value;
  return Math.abs(v - shown) <= 0.5 * 10 ** -decimals + 1e-9;
};

/** Problems in one cell against one leaderboard row; [] when it matches. */
function checkCell(cell, field, row) {
  const text = plain(cell);
  const value = row[field];
  if (NULLS.has(text.toLowerCase())) return value == null ? [] : [`${field} is ${value}, the cell shows "${cell}"`];
  const bracket = text.indexOf("[");
  const main = (bracket < 0 ? text : text.slice(0, bracket)).match(NUMBER) ?? [];
  if (!main.length) return [`${field}: no number in "${cell}"`];
  if (value == null) return [`${field} is null, the cell shows "${cell}"`];
  const problems = [];
  if (!matches(value, parseNumber(main[0]))) problems.push(`${field} is ${value}, the cell shows ${main[0]}`);
  if (bracket >= 0) {
    const ci = text.slice(bracket).match(NUMBER) ?? [];
    for (const [k, s] of [[`${field}_lo`, ci[0]], [`${field}_hi`, ci[1]]]) {
      if (s === undefined) problems.push(`${k}: missing in "${cell}"`);
      else if (row[k] == null) problems.push(`${k} is null, the cell shows ${s}`);
      else if (!matches(row[k], parseNumber(s))) problems.push(`${k} is ${row[k]}, the cell shows ${s}`);
    }
  }
  return problems;
}

/**
 * Checks the marked tables of each file ({ name, text }) against leaderboard.json's parsed content.
 * Returns { tables, cells, problems: ["<name>:<line>: …"] }.
 */
export function checkReport(files, leaderboard) {
  const rows = new Map((leaderboard.leaderboard ?? []).map(r => [r.system, r]));
  const fields = new Set([...rows.values()].flatMap(r => Object.keys(r)));
  const problems = [];
  let tables = 0;
  let cells = 0;
  for (const { name, text } of files) {
    const marked = parseMarkedTables(text);
    if (!marked.length) problems.push(`${name}: no marked leaderboard table (<!-- crb:leaderboard columns=… -->)`);
    for (const t of marked) {
      tables++;
      const at = l => `${name}:${l}`;
      if (!t.header) {
        problems.push(`${at(t.line)}: the marker is not followed by a table`);
        continue;
      }
      const sys = t.columns.indexOf("system");
      if (sys < 0) {
        problems.push(`${at(t.line)}: the marker names no system column`);
        continue;
      }
      const unknown = t.columns.filter(c => c !== "system" && !fields.has(c));
      if (unknown.length) problems.push(`${at(t.line)}: leaderboard.json has no field ${unknown.join(", ")}`);
      if (t.header.length !== t.columns.length) problems.push(`${at(t.line)}: the marker names ${t.columns.length} columns, the header has ${t.header.length} cells`);
      for (const r of t.rows) {
        if (r.cells.length !== t.columns.length) {
          problems.push(`${at(r.line)}: the marker names ${t.columns.length} columns, the row has ${r.cells.length} cells`);
          continue;
        }
        const system = plain(r.cells[sys]);
        const row = rows.get(system);
        if (!row) {
          problems.push(`${at(r.line)}: system ${system} is not in leaderboard.json`);
          continue;
        }
        t.columns.forEach((field, i) => {
          if (i === sys || unknown.includes(field)) return;
          cells++;
          for (const p of checkCell(r.cells[i], field, row)) problems.push(`${at(r.line)}: ${system}: ${p}`);
        });
      }
    }
  }
  return { tables, cells, problems };
}
