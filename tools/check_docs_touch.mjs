#!/usr/bin/env node
// Docs-touch gate (audit row 7): a commit that changes the command line (ck-cli's args.rs, or the spec the app reads,
// src/shared/console/cliSpec.json) also changes its docs: docs/CLI.md, the wiki's Command-Line.md and docs/GUIDE.md
// (the app's guide says how the Queue and the CLI agree: GUIDE.md went stale on --linear after 0cdad0c). A commit
// whose message has a line `docs: none-needed — <why>` is exempt. It reads the commits not on origin/main yet
// (`git log origin/main..HEAD`); without origin/main it checks nothing and says so.
//   node tools/check_docs_touch.mjs                 the gate (npm run gates)
//   node tools/check_docs_touch.mjs <A>..<B>        the commits in a range (tools/release.sh: since the last tag)
//   node tools/check_docs_touch.mjs --staged <msg>  the commit being made: its staged files and message file
//                                                   (.hooks/commit-msg; senior review 2026-10-27 S6)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_SOURCES = ["engine-rs/crates/ck-cli/src/args.rs", "src/shared/console/cliSpec.json"];
export const CLI_DOCS = ["docs/CLI.md", "docs/wiki/Command-Line.md", "docs/GUIDE.md"];

/** `git log --format=%x01%H%x02%B%x02 --name-only` output → [{ sha, message, files }]. */
export function parseLog(text) {
  // loop: NOT-WORTH — the commits not on origin/main (a branch's few)
  return text
    .split("\u0001")
    .filter((c) => c.trim())
    .map((c) => {
      const [sha, message, files] = c.split("\u0002");
      // loop: NOT-WORTH — one commit's files
      return { sha: sha.trim(), message, files: files.split("\n").filter((f) => f.trim()) };
    });
}

export function checkCommits(commits) {
  const out = [];
  // loop: NOT-WORTH — the commits not on origin/main
  for (const c of commits) {
    // loop: NOT-WORTH — one commit's files
    if (!c.files.some((f) => CLI_SOURCES.includes(f)) || /^docs: none-needed\b/m.test(c.message)) continue;
    // loop: NOT-WORTH — three docs
    const missing = CLI_DOCS.filter((d) => !c.files.includes(d));
    if (missing.length) out.push(`${c.sha.slice(0, 7)} "${c.message.split("\n")[0]}" changes the CLI but not ${missing.join(", ")} (or add a line "docs: none-needed — why" to its message)`);
  }
  return out;
}

// loop: NOT-WORTH — one or two git calls per gate run [bounded: timeout 20 s each]
const gitIn = (app) => (args) => execFileSync("git", args, { cwd: app, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });

/** The commits in `range` (default: those not on origin/main yet, none without origin/main). */
export function checkAll(app = APP, range) {
  const git = gitIn(app);
  if (!range) {
    try {
      git(["rev-parse", "--verify", "--quiet", "origin/main"]);
    } catch {
      console.log("check_docs_touch: no origin/main here, nothing to compare");
      return [];
    }
  }
  return checkCommits(parseLog(git(["log", "--format=%x01%H%x02%B%x02", "--name-only", range ?? "origin/main..HEAD"])));
}

/** The commit being made in `app`: its staged files and the message in `msgFile` (git's commit-msg hook argument). */
export function checkStaged(msgFile, app = APP) {
  // loop: NOT-WORTH — one commit's staged files
  const files = gitIn(app)(["diff", "--cached", "--name-only"])
    .split("\n")
    .filter((f) => f.trim());
  return checkCommits([{ sha: "staged", message: readFileSync(msgFile, "utf8"), files }]);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [a, b] = process.argv.slice(2);
  const problems = a === "--staged" ? checkStaged(b, process.cwd()) : checkAll(APP, a);
  if (problems.length) {
    console.log("Docs-touch gate (tools/check_docs_touch.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
