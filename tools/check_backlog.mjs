#!/usr/bin/env node
// Backlog gate (audit row 10, rule 8: one backlog): docs/BACKLOG.md's table stays a table and its statuses stay true.
// It fails when a row
//   (a) doesn't have exactly four cells (# | Item | Source | Status): an unescaped `|` (also inside backticks:
//       GitHub splits there too; write `\|`) cuts it;
//   (b) has a number that isn't a whole number, or one used before;
//   (c) has a status that doesn't start with one of STATUSES;
//   (d) says "merged into row N" for a row that doesn't exist;
//   (e) names a branch (`branch x`, `on x`) in its status that git knows and that is already in HEAD while the
//       status still says building / agreed / idea (a merged branch: update the status).
//   node tools/check_backlog.mjs    the gate (npm run gates)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
// How a status starts (after an optional **): the words this backlog uses
export const STATUSES = [
  "idea",
  "agreed",
  "building",
  "built",
  "done",
  "closed",
  "merged into row",
  "measuring",
  "to measure",
  "needs research",
  "in progress",
  "later",
  "open",
  "published",
  "engine side",
];

/** A table row's cells: split on `|` not escaped as `\|`, without the outer empty ones. */
export function cells(line) {
  return line
    .trim()
    .split(/(?<!\\)\|/)
    .slice(1, -1);
}

/** (a)–(d), and the branches each row's status names: [{ problems, branches: [{ row, branch, open }] }]. */
export function checkTable(md) {
  const problems = [];
  const branches = [];
  const rows = new Map();
  // loop: NOT-WORTH — the backlog's lines (a few hundred), once per gate run
  md.split("\n").forEach((line, i) => {
    if (!/^\|\s*\d/.test(line)) return;
    const at = `docs/BACKLOG.md:${i + 1}`;
    const c = cells(line);
    if (c.length !== 4) {
      problems.push(`${at}: ${c.length} cells, not 4 (an unescaped | ? write \\|)`);
      return;
    }
    const n = c[0].trim();
    if (!/^\d+$/.test(n)) problems.push(`${at}: row number "${n}" isn't a whole number`);
    else if (rows.has(n)) problems.push(`${at}: row ${n} is already at line ${rows.get(n)}`);
    else rows.set(n, i + 1);
    const status = c[3].trim().replace(/^\*\*/, "").toLowerCase();
    // loop: NOT-WORTH — fifteen status words
    if (!STATUSES.some((s) => status.startsWith(s))) problems.push(`${at}: row ${n}'s status "${c[3].trim().slice(0, 40)}" doesn't start with one of: ${STATUSES.join(", ")}`);
    const merged = status.match(/^merged into row (\d+)/);
    if (merged) branches.push({ row: n, mergedInto: merged[1], at });
    // loop: NOT-WORTH — a branch or two per status
    for (const m of c[3].matchAll(/\b(?:branch|on) `?([\w-]+\/[\w./-]+)`?/g)) {
      branches.push({ row: n, branch: m[1], open: /^(building|agreed|idea)/.test(status), at });
    }
  });
  // loop: NOT-WORTH — a few merged rows
  for (const b of branches) if (b.mergedInto && !rows.has(b.mergedInto)) problems.push(`${b.at}: row ${b.row} is "merged into row ${b.mergedInto}", which doesn't exist`);
  // loop: NOT-WORTH — the rows naming a branch
  return { problems, branches: branches.filter((b) => b.branch) };
}

/** (e): an open status naming a branch `isMerged` says is in HEAD. */
export function checkBranches(branches, isMerged) {
  // loop: NOT-WORTH — the rows naming a branch
  return branches.filter((b) => b.open && isMerged(b.branch)).map((b) => `${b.at}: row ${b.row} still says it is open, but branch ${b.branch} is already in HEAD: update its status`);
}

export function checkAll(app = APP) {
  const { problems, branches } = checkTable(readFileSync(join(app, "docs/BACKLOG.md"), "utf8"));
  const isMerged = (branch) => {
    // loop: NOT-WORTH — one git call per branch named in an open row [bounded: timeout 10 s]
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      try {
        // loop: NOT-WORTH — one git call [bounded: timeout 10 s]
        execFileSync("git", ["merge-base", "--is-ancestor", ref, "HEAD"], { cwd: app, timeout: 10_000, stdio: "ignore" });
        return true;
      } catch {
        // not a ref here, or not in HEAD
      }
    }
    return false;
  };
  return [...problems, ...checkBranches(branches, isMerged)];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Backlog gate (docs/BACKLOG.md, tools/check_backlog.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
