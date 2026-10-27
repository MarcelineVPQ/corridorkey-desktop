#!/usr/bin/env node
// README "What's coming" gate (audit row 14): the README's short list agrees with the backlog. Source of truth:
// docs/BACKLOG.md's rows and statuses. In README.md's "## What's coming" section it fails when a `[N]`
//   (a) names a row the backlog doesn't have;
//   (b) names a row that is finished (its status starts with done, built, published, closed or merged into);
//   (c) sits under a **Ideas…** heading while its row is decided (its status doesn't start with idea or needs research).
//   node tools/check_readme_coming.mjs    the gate (npm run gates)
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The backlog's statuses by row number. */
export function statuses(backlog) {
  const out = new Map();
  // loop: NOT-WORTH — the backlog's lines, once per gate run
  for (const line of backlog.split("\n")) {
    if (!/^\|\s*\d/.test(line)) continue;
    const c = line.trim().split(/(?<!\\)\|/);
    out.set(c[1].trim(), (c[4] ?? "").trim().replace(/^\*\*/, "").toLowerCase());
  }
  return out;
}

export function checkComing(readme, status) {
  const start = readme.indexOf("## What's coming");
  if (start < 0) return [`README.md has no "## What's coming" section`];
  const rest = readme.slice(start + 3);
  const section = rest.slice(0, rest.search(/^## /m) < 0 ? rest.length : rest.search(/^## /m));
  const out = [];
  // loop: NOT-WORTH — the section's dozen paragraphs
  for (const para of section.split(/\n\s*\n/)) {
    const heading = para.match(/^\*\*([^*]+)\*\*/)?.[1] ?? "";
    // loop: NOT-WORTH — a few rows per paragraph
    for (const m of para.matchAll(/\[(\d+)\]/g)) {
      const s = status.get(m[1]);
      if (s === undefined) out.push(`README.md What's coming: [${m[1]}] isn't a backlog row`);
      else if (/^(done|built|published|closed|merged into)/.test(s)) out.push(`README.md What's coming: [${m[1]}] is finished ("${s.slice(0, 40)}"): take it out`);
      else if (/^ideas/i.test(heading) && !/^(idea|needs research)/.test(s)) out.push(`README.md What's coming: [${m[1]}] is under "${heading}", but its row says "${s.slice(0, 40)}"`);
    }
  }
  return out;
}

export function checkAll(app = APP) {
  const read = (p) => readFileSync(join(app, p), "utf8");
  return checkComing(read("README.md"), statuses(read("docs/BACKLOG.md")));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("README What's coming gate (README.md, docs/BACKLOG.md, tools/check_readme_coming.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
