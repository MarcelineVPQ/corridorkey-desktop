// .hooks/ (senior review 2026-10-27 S7): the pre-commit hook fails where it can't run the gates, and every clone gets
// the hooks from npm's prepare script.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const hook = new URL("../../.hooks/pre-commit", import.meta.url).pathname;
const repo = mkdtempSync(join(tmpdir(), "ck-hooks-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("git hooks", () => {
  it("pre-commit fails without node_modules instead of skipping the gates", () => {
    // loop: NOT-WORTH — two short commands, 10 s deadline each
    expect(spawnSync("git", ["init", "-q"], { cwd: repo, timeout: 10_000 }).status).toBe(0);
    const r = spawnSync("bash", [hook], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("run npm ci first");
  });

  // review N10: the hook gated the working tree, so a partly staged commit was judged by its unstaged files
  it("pre-commit gates what is staged, not the working tree", () => {
    const r2 = mkdtempSync(join(tmpdir(), "ck-hooks-"));
    try {
      // loop: NOT-WORTH — a few short git commands in a scratch repository, 10 s deadline each
      const git = (...a: string[]) => expect(spawnSync("git", a, { cwd: r2, timeout: 10_000 }).status).toBe(0);
      git("init", "-q");
      mkdirSync(join(r2, "node_modules"));
      // a gate that passes only when x.txt says "good"
      writeFileSync(join(r2, "package.json"), JSON.stringify({ scripts: { gates: "node gate.mjs" } }));
      writeFileSync(join(r2, "gate.mjs"), 'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("x.txt", "utf8") === "good" ? 0 : 1);\n');
      const hookRun = () => spawnSync("bash", [hook], { cwd: r2, encoding: "utf8", timeout: 60_000 }).status;
      writeFileSync(join(r2, "x.txt"), "good");
      git("add", "package.json", "gate.mjs", "x.txt");
      writeFileSync(join(r2, "x.txt"), "bad");
      expect(hookRun()).toBe(0);
      git("add", "x.txt");
      writeFileSync(join(r2, "x.txt"), "good");
      expect(hookRun()).toBe(1);
    } finally {
      rmSync(r2, { recursive: true, force: true });
    }
  });

  it("npm's prepare script points git at .hooks", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.prepare).toBe("git config core.hooksPath .hooks");
  });
});
