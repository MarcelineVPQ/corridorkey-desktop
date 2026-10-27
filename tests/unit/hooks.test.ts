// .hooks/ (senior review 2026-10-27 S7): the pre-commit hook fails where it can't run the gates, and every clone gets
// the hooks from npm's prepare script.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it("npm's prepare script points git at .hooks", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.prepare).toBe("git config core.hooksPath .hooks");
  });
});
