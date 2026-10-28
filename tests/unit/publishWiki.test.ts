// tools/publish_wiki.mjs (release review 2026-10-28 #15: it pushes public text and had no test), run against a local
// bare repository named like a wiki: by default it stages docs/wiki/ in the clone and pushes nothing; it refuses a
// clone whose origin isn't a wiki or that has changes of its own; --push commits and pushes as MarcelineVPQ.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../tools/publish_wiki.mjs", import.meta.url));
const app = fileURLToPath(new URL("../..", import.meta.url));
const pages = readdirSync(join(app, "docs", "wiki")).filter((n) => n.endsWith(".md"));
const scratch = mkdtempSync(join(tmpdir(), "ck-publish-wiki-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// loop: NOT-WORTH — one git command, 20 s deadline
const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", timeout: 20_000 });
// loop: NOT-WORTH — one run of the script, 60 s deadline
const publish = (...a: string[]) => spawnSync("node", [script, ...a], { encoding: "utf8", timeout: 60_000 });

/** A bare "<name>" repository with one old page and a stale page, and a clone of it. */
function wiki(name: string) {
  const d = mkdtempSync(join(scratch, "w-"));
  const bare = join(d, name);
  git(d, "init", "-q", "--bare", "-b", "master", bare);
  const seed = join(d, "seed");
  git(d, "clone", "-q", bare, seed);
  writeFileSync(join(seed, "Home.md"), "old\n");
  writeFileSync(join(seed, "Gone-Page.md"), "removed here\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "HEAD");
  const clone = join(d, "clone");
  git(d, "clone", "-q", bare, clone);
  return { bare, clone, head: () => git(bare, "rev-parse", "HEAD").stdout.trim() };
}

describe("publish_wiki.mjs", () => {
  it("stages docs/wiki/ in the clone (a removed page removed) and pushes nothing without --push", () => {
    const w = wiki("x.wiki.git");
    const before = w.head();
    const r = publish(w.clone);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("not published");
    expect(w.head()).toBe(before);
    const staged = git(w.clone, "diff", "--cached", "--name-status").stdout;
    expect(staged).toContain("D\tGone-Page.md");
    expect(staged).toContain("M\tHome.md");
    expect(existsSync(join(w.clone, "Gone-Page.md"))).toBe(false);
    // loop: NOT-WORTH — the wiki's pages
    for (const p of pages) expect(existsSync(join(w.clone, p))).toBe(true);
    // a second run over its own staged copy is fine
    expect(publish(w.clone).status).toBe(0);
  });

  it("refuses a clone whose origin isn't a wiki, or that has changes of its own", () => {
    const notWiki = wiki("x.git");
    const r = publish(notWiki.clone);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("isn't a wiki repository");
    const w = wiki("y.wiki.git");
    writeFileSync(join(w.clone, "notes.txt"), "mine\n");
    const own = publish(w.clone);
    expect(own.status).toBe(1);
    expect(own.stderr).toContain("has changes of its own");
    expect(publish(join(scratch, "nowhere")).stderr).toContain("isn't a git clone");
  });

  // --push needs docs/wiki/ committed here; other work in this checkout may have it changed
  const wikiDirty = git(app, "status", "--porcelain", "--", "docs/wiki").stdout.trim() !== "";
  it.skipIf(wikiDirty)("--push commits as MarcelineVPQ and pushes to the clone's origin", () => {
    const w = wiki("z.wiki.git");
    const before = w.head();
    const r = publish(w.clone, "--push");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("published");
    expect(w.head()).not.toBe(before);
    const author = git(w.bare, "log", "-1", "--format=%an <%ae>|%s").stdout.trim();
    expect(author).toMatch(/^MarcelineVPQ <25850221\+MarcelineVPQ@users\.noreply\.github\.com>\|The wiki from corridorkey-desktop \w+ \(docs\/wiki\/\)$/);
    expect(git(w.bare, "ls-tree", "--name-only", "HEAD").stdout.split("\n").filter(Boolean).sort()).toEqual([...pages].sort());
  });
});
