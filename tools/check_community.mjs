#!/usr/bin/env node
// Community files gate: the repository keeps GitHub's community files. Source of truth: the files themselves. It fails
// when any is missing: README.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md, LICENSE, SECURITY.md, an issue form
// (.github/ISSUE_TEMPLATE/*.yml or *.md, other than config.yml) and .github/pull_request_template.md.
//   node tools/check_community.mjs    the gate (npm run gates)
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

export const FILES = ["README.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "LICENSE", "SECURITY.md", ".github/pull_request_template.md"];
const ISSUES = ".github/ISSUE_TEMPLATE";

/** `present`: the repository's paths that exist (the FILES and the issue template folder's entries). */
export function checkFiles(present) {
  const has = new Set(present);
  // loop: NOT-WORTH — six files
  const out = FILES.filter((f) => !has.has(f)).map((f) => `${f} is missing: GitHub's community files need it`);
  // loop: NOT-WORTH — the issue template folder's few entries
  if (!present.some((p) => p.startsWith(`${ISSUES}/`) && /\.(yml|md)$/.test(p) && p !== `${ISSUES}/config.yml`))
    out.push(`${ISSUES}/ has no issue form (a .yml or .md other than config.yml): add one`);
  return out;
}

export function checkAll(app = APP) {
  // loop: NOT-WORTH — six files
  const present = FILES.filter((f) => existsSync(join(app, f)));
  // loop: NOT-WORTH — the issue template folder's few entries
  if (existsSync(join(app, ISSUES))) present.push(...readdirSync(join(app, ISSUES)).map((n) => `${ISSUES}/${n}`));
  return checkFiles(present);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const problems = checkAll();
  if (problems.length) {
    console.log("Community files gate (tools/check_community.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
