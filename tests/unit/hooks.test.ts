// .hooks/ (senior review 2026-10-27 S7): the pre-commit hook fails where it can't run the gates, and every clone gets
// the hooks from npm's prepare script.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // release review 2026-10-28 #10: on native Windows the POSIX-only gates refused every commit (and ln -s copied
  // node_modules): the hooks skip there with a WSL note
  it("pre-commit and commit-msg skip on native Windows (MINGW, MSYS, Cygwin) with a WSL note", () => {
    const r3 = mkdtempSync(join(tmpdir(), "ck-hooks-"));
    try {
      mkdirSync(join(r3, "bin"));
      // loop: NOT-WORTH — three systems' uname, each hook run once with a 10 s deadline
      for (const sys of ["MINGW64_NT-10.0-26100", "MSYS_NT-10.0", "CYGWIN_NT-10.0"]) {
        writeFileSync(join(r3, "bin", "uname"), `#!/bin/sh\necho ${sys}\n`);
        chmodSync(join(r3, "bin", "uname"), 0o755);
        const env = { ...process.env, PATH: `${join(r3, "bin")}:${process.env.PATH}` };
        // no node_modules and no git repository: on Linux both would fail
        const pre = spawnSync("bash", [hook], { cwd: r3, encoding: "utf8", timeout: 10_000, env });
        expect(pre.status).toBe(0);
        expect(pre.stderr).toContain("commit from WSL");
        expect(spawnSync("bash", [new URL("../../.hooks/commit-msg", import.meta.url).pathname, "MSG"], { cwd: r3, timeout: 10_000, env }).status).toBe(0);
      }
    } finally {
      rmSync(r3, { recursive: true, force: true });
    }
  });

  // release review 2026-10-28 #12: `git commit --amend -m` with nothing staged passed a CLI change without docs
  it("commit-msg judges an amend by the amended commit's files", () => {
    const r4 = mkdtempSync(join(tmpdir(), "ck-hooks-"));
    try {
      // loop: NOT-WORTH — a few git commands in a scratch repository, 20 s deadline each
      const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: r4, encoding: "utf8", timeout: 20_000 });
      git("init", "-q");
      mkdirSync(join(r4, "tools"));
      mkdirSync(join(r4, "hooks"));
      copyFileSync(new URL("../../tools/check_docs_touch.mjs", import.meta.url), join(r4, "tools", "check_docs_touch.mjs"));
      copyFileSync(new URL("../../.hooks/commit-msg", import.meta.url), join(r4, "hooks", "commit-msg"));
      chmodSync(join(r4, "hooks", "commit-msg"), 0o755);
      git("config", "core.hooksPath", "hooks");
      git("add", "tools");
      expect(git("commit", "-q", "-m", "base").status).toBe(0);
      mkdirSync(join(r4, "src/shared/console"), { recursive: true });
      writeFileSync(join(r4, "src/shared/console/cliSpec.json"), "{}");
      git("add", "src");
      expect(git("commit", "-q", "-m", "CLI: a flag").status).toBe(1);
      expect(git("commit", "-q", "-m", "CLI: a flag\n\ndocs: none-needed — a test").status).toBe(0);
      // the amend drops the exemption with nothing staged: still a CLI change without docs
      const amend = git("commit", "-q", "--amend", "-m", "CLI: a flag");
      expect(amend.status).toBe(1);
      expect(amend.stdout + amend.stderr).toContain("changes the CLI");
    } finally {
      rmSync(r4, { recursive: true, force: true });
    }
  });

  it("npm's prepare script points git at .hooks", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    // outside a git checkout (a tarball's npm ci) it says the hooks aren't installed instead of failing (dcac64f)
    expect(pkg.scripts.prepare).toMatch(/^git config core\.hooksPath \.hooks \|\| echo prepare: not a git checkout/);
  });
});
