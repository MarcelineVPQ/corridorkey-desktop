#!/usr/bin/env node
// Loop pass (rule 7, the AVIEW/DS5 pattern): every loop statement and timer in
// app code carries one verdict, so no waiting or hot loop goes unexamined.
// Listed mechanically: `for`/`while`/`do` statements and setInterval in
// electron/, src/ (.ts/.tsx), engine/ (.py) and engine-rs/crates/*/src (.rs); tests excluded. Array
// callbacks (.map/.forEach) aren't listed here: they are bounded by the data
// they walk and the reviewer reads them with their caller.
//
//   node tools/list_loops.mjs           TSV: file line verdict head
//   node tools/list_loops.mjs --check   the gate: exit 1 on a loop without a valid verdict
//
// A verdict is a comment on the loop's line or the line above:
//   // loop: SERIAL-REQUIRED — one job at a time on one GPU
//   # loop: HOT-PATH-OK — N ≤ 6
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const VERDICTS = ["PARALLELIZE", "BATCH", "SERIAL-REQUIRED", "HOT-PATH-OK", "FIX-HOT-PATH", "NOT-WORTH"];
const ROOTS = ["electron", "src", "engine", "engine-rs/crates"];
const LOOP_TS = /^\s*(for\s*\(|for await\s*\(|while\s*\(|do\s*\{)|setInterval\(/;
const LOOP_PY = /^\s*(for .+ in .+:|while .+:)\s*(#.*)?$/;
const LOOP_RS = /^\s*(for .+ in .+\{|while .+\{|loop \{)/;
const VERDICT = new RegExp(`(//|#|\\{/\\*)\\s*loop: (${VERDICTS.join("|")}) — \\S`);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "__pycache__" && name !== "tests" && name !== "target") walk(p);
    } else if (/\.(tsx?|py|rs)$/.test(p) && !/(\.test\.|\/test_|\.d\.ts$)/.test(p)) files.push(p);
  }
};
ROOTS.forEach(walk);

const rows = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  const re = file.endsWith(".py") ? LOOP_PY : file.endsWith(".rs") ? LOOP_RS : LOOP_TS;
  lines.forEach((line, i) => {
    const code = file.endsWith(".py") ? line : line.replace(/\/\/.*$/, "");
    if (!re.test(code) || /^\s*(\*|\/\/|#)/.test(line)) return;
    const m = VERDICT.exec(line) ?? VERDICT.exec(lines[i - 1] ?? "");
    rows.push({ file, line: i + 1, verdict: m ? m[2] : "", head: line.trim().slice(0, 100) });
  });
}

if (process.argv.includes("--check")) {
  const bad = rows.filter((r) => !r.verdict);
  if (bad.length) {
    console.log(`Loop gate: ${bad.length} loop(s) without a verdict (// loop: VERDICT — reason):`);
    bad.forEach((r) => console.log(`${r.file}:${r.line}: ${r.head}`));
    process.exit(1);
  }
  console.log(`Loop gate: ${rows.length} loops, all with a verdict.`);
} else rows.forEach((r) => console.log([r.file, r.line, r.verdict || "-", r.head].join("\t")));
