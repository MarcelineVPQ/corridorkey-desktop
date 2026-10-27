#!/usr/bin/env node
// Publish the wiki's source (docs/wiki/) to the GitHub wiki: copy it into a clone of the wiki repository and show
// the difference. Publishing is Marcy's step (public words get her OK first), so by default nothing leaves this PC:
// the changes are staged in the clone for her to read. Only `--push` commits and pushes them. docs/RELEASING.md "The wiki".
//
//   git clone https://github.com/MarcelineVPQ/corridorkey-desktop.wiki.git ~/ck-wiki   (once)
//   node tools/publish_wiki.mjs ~/ck-wiki            pull the clone, copy, stage, show the diff (no commit, no push)
//   node tools/publish_wiki.mjs ~/ck-wiki --push     the same, then commit and push (docs/wiki/ must be committed)
//
// It runs the wiki gate first (tools/check_wiki.mjs) and refuses a wiki that fails it. Pages removed from docs/wiki/
// are removed from the wiki. To drop the staged changes: git -C <clone> reset -q --hard.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP, WIKI, checkAll } from "./check_wiki.mjs";

const args = process.argv.slice(2);
const push = args.includes("--push");
// loop: NOT-WORTH — the command line's two words
const clone = args.find((a) => !a.startsWith("--"));
const fail = (m) => {
  console.error(`publish_wiki: ${m}`);
  process.exit(1);
};
// loop: NOT-WORTH — one short git command at a time [bounded: 120 s each]
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "inherit"] });

if (!clone) fail("usage: node tools/publish_wiki.mjs <wiki clone> [--push]");
const dir = resolve(clone);
if (!existsSync(join(dir, ".git"))) fail(`${dir} isn't a git clone`);
const origin = git(dir, "remote", "get-url", "origin").trim();
if (!/\.wiki(\.git)?$/.test(origin)) fail(`${dir}'s origin (${origin}) isn't a wiki repository`);
// changes this script staged before (a run without --push) are fine: the copy below replaces them
// loop: NOT-WORTH — the clone's changed files
if (
  git(dir, "status", "--porcelain")
    .split("\n")
    .some((l) => l && !/^[MAD] {2}\S+\.md$/.test(l))
)
  fail(`${dir} has changes of its own: commit or reset them first (git -C ${dir} reset -q --hard)`);
const problems = checkAll();
if (problems.length) fail("the wiki gate fails; fix docs/wiki/ first:\n" + problems.join("\n"));
if (push && git(APP, "status", "--porcelain", "--", "docs/wiki").trim()) fail("docs/wiki/ has uncommitted changes: commit them first, so the wiki is a commit's");

git(dir, "pull", "-q", "--ff-only");
// loop: NOT-WORTH — the wiki's few dozen pages
const src = readdirSync(WIKI).filter((n) => n.endsWith(".md"));
// loop: NOT-WORTH — the clone's pages
for (const n of readdirSync(dir).filter((n) => n.endsWith(".md") && !src.includes(n))) rmSync(join(dir, n));
// loop: NOT-WORTH — the wiki's pages
for (const n of src) copyFileSync(join(WIKI, n), join(dir, n));
git(dir, "add", "-A");
const stat = git(dir, "diff", "--cached", "--stat");
if (!stat.trim()) {
  console.log("publish_wiki: the wiki is already docs/wiki/; nothing to publish");
  process.exit(0);
}
console.log(git(dir, "diff", "--cached"));
console.log(stat);
if (!push) {
  console.log(`publish_wiki: staged in ${dir}, not published. Read it, then run again with --push (or: git -C ${dir} reset -q --hard)`);
  process.exit(0);
}
const head = git(APP, "rev-parse", "--short", "HEAD").trim();
git(dir, "commit", "-q", "-m", `The wiki from corridorkey-desktop ${head} (docs/wiki/)`);
git(dir, "push", "-q", "origin", "HEAD");
console.log(`publish_wiki: published (corridorkey-desktop ${head})`);
