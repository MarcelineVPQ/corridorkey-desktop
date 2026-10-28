#!/usr/bin/env node
// Docs-touch gate (audit row 7): a commit that changes the command line (ck-cli's args.rs, or the spec the app reads,
// src/shared/console/cliSpec.json) also changes its docs: docs/CLI.md, the wiki's Command-Line.md and docs/GUIDE.md
// (the app's guide says how the Queue and the CLI agree: GUIDE.md went stale on --linear after 0cdad0c). A commit
// whose message has a line `docs: none-needed — <why>` is exempt (the why is required: a bare `docs: none-needed`
// isn't). EXCEPTIONS below lists pushed commits (history isn't rewritten) whose docs came later, each with why. It
// reads the commits not on origin/main yet
// (`git log origin/main..HEAD`); without origin/main it checks nothing and says so.
//   node tools/check_docs_touch.mjs                 the gate (npm run gates)
//   node tools/check_docs_touch.mjs <A>..<B>        the commits in a range (tools/release.sh: since the last tag)
//   node tools/check_docs_touch.mjs --staged <msg> [--amend]  the commit being made: its staged files and message
//                                                   file (.hooks/commit-msg; senior review 2026-10-27 S6); --amend: the
//                                                   files against HEAD^, since the amended commit replaces HEAD
//                                                   (release review 2026-10-28 #12: `--amend -m` with nothing staged
//                                                   passed)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_SOURCES = ["engine-rs/crates/ck-cli/src/args.rs", "src/shared/console/cliSpec.json"];
export const CLI_DOCS = ["docs/CLI.md", "docs/wiki/Command-Line.md", "docs/GUIDE.md"];

/**
 * Pushed commits that changed the CLI without all three docs, by full hash, each with where its docs are now
 * (reviewed 2026-10-28 for the dev.2 release check over v1.0.0-dev.1..HEAD; the gate came later, 0c6510a).
 */
export const EXCEPTIONS = new Map([
  ["716a7a77a30f9863de62b6ba7df9f8976c5c0b86", "the CLI's first commit: docs/CLI.md (992326f), the wiki's Command-Line.md (0109b35) and GUIDE.md (0c6510a) describe it"],
  ["5e74941eea2a6a655811b642c46fa426480144ed", "__spec --json: docs/CLI.md in the commit, the wiki's Command-Line.md since 0109b35; a tools' command, not the app's guide"],
  ["8da6a11591c298b8f4513c087c47859a2120992b", "the Console's parser reads cliSpec.json, no CLI change: docs/CONSOLE.md says how; CLI.md's Adding an option names the file"],
  ["bf1dc4a5cbed2b195fcde3cac224c5b42939d94f", "the spec's conflicts_with for the Console: docs/CLI.md and docs/CONSOLE.md in the commit; the CLI itself didn't change"],
  ["98fb94712f02f1984fccec1e6e7f093f1b313b17", "--version: docs/CLI.md and GUIDE.md in the commit, the wiki's Command-Line.md since 0109b35"],
  ["0cdad0cd5aa2238925741f357d3abde2c4d2302b", "frame folders read as the app starts them: docs/CLI.md and Command-Line.md in the commit, GUIDE.md since 0c6510a"],
]);

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

export function checkCommits(commits, exceptions = EXCEPTIONS) {
  const out = [];
  // loop: NOT-WORTH — the commits not on origin/main
  for (const c of commits) {
    if (exceptions.has(c.sha)) continue;
    // loop: NOT-WORTH — one commit's files
    if (!c.files.some((f) => CLI_SOURCES.includes(f)) || /^docs: none-needed[^\S\n]*(—|-{1,2})[^\S\n]*\S/m.test(c.message)) continue;
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

/** The commit being made in `app`: its staged files and the message in `msgFile` (git's commit-msg hook argument).
 * `amend`: the commit replaces HEAD, so its files are the index against HEAD's parent (the empty tree for a root). */
export function checkStaged(msgFile, app = APP, amend = false) {
  const git = gitIn(app);
  // without a base: against HEAD (or nothing, before the first commit)
  let base = [];
  if (amend) {
    try {
      base = [git(["rev-parse", "--verify", "--quiet", "HEAD^"]).trim()];
    } catch {
      // error: NOT-WORTH — HEAD is a root commit: everything in the index is the commit's
      base = ["4b825dc642cb6eb9a060e54bf8d69288fbee4904"];
    }
  }
  // loop: NOT-WORTH — one commit's staged files
  const files = git(["diff", "--cached", "--name-only", ...base])
    .split("\n")
    .filter((f) => f.trim());
  return checkCommits([{ sha: "staged", message: readFileSync(msgFile, "utf8"), files }]);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [a, b, c] = process.argv.slice(2);
  const problems = a === "--staged" ? checkStaged(b, process.cwd(), c === "--amend") : checkAll(APP, a);
  if (problems.length) {
    console.log("Docs-touch gate (tools/check_docs_touch.mjs):\n" + problems.join("\n"));
    process.exit(1);
  }
}
