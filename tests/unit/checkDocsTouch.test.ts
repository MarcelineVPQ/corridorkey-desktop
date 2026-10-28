import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXCEPTIONS, checkAll, checkCommits, checkStaged, parseLog } from "../../tools/check_docs_touch.mjs";

const ARGS = "engine-rs/crates/ck-cli/src/args.rs";

describe("the docs-touch gate", () => {
  it("parses git log's commits, messages and files", () => {
    const log = `\u0001abc1234567\u0002CLI: --no-linear\n\nbody\n\u0002\n\n${ARGS}\ndocs/CLI.md\n\u0001def7654321\u0002Docs only\n\u0002\n\ndocs/GUIDE.md\n`;
    expect(parseLog(log)).toEqual([
      { sha: "abc1234567", message: "CLI: --no-linear\n\nbody\n", files: [ARGS, "docs/CLI.md"] },
      { sha: "def7654321", message: "Docs only\n", files: ["docs/GUIDE.md"] },
    ]);
  });

  it("a CLI change without the three docs fails (0cdad0c's shape: GUIDE.md left stale)", () => {
    const c = { sha: "0cdad0cd5a", message: "CLI: frame folders read as the app starts them\n", files: [ARGS, "docs/CLI.md", "docs/wiki/Command-Line.md"] };
    expect(checkCommits([c])).toEqual([expect.stringContaining("not docs/GUIDE.md")]);
    expect(checkCommits([{ ...c, files: [...c.files, "docs/GUIDE.md"] }])).toEqual([]);
    expect(checkCommits([{ ...c, message: c.message + "\ndocs: none-needed — a help text typo\n" }])).toEqual([]);
    expect(checkCommits([{ ...c, files: ["src/ui/App.tsx"] }])).toEqual([]);
  });

  it("the exemption needs its why (whole-code review 2026-10-27: a bare line passed)", () => {
    const c = { sha: "0cdad0cd5a", message: "CLI: a flag\n", files: [ARGS] };
    // loop: NOT-WORTH — four messages
    for (const bare of ["docs: none-needed", "docs: none-needed —", "docs: none-needed - ", "docs: none-needed because"])
      expect(checkCommits([{ ...c, message: `${c.message}\n${bare}\nCo-Authored-By: someone\n` }]), bare).toHaveLength(1);
    expect(checkCommits([{ ...c, message: `${c.message}\ndocs: none-needed - help text only\n` }])).toEqual([]);
  });

  it("a listed pushed commit passes by its full hash only, and every listed one says why", () => {
    const c = { sha: "0cdad0cd5aa2238925741f357d3abde2c4d2302b", message: "CLI: frame folders\n", files: [ARGS] };
    expect(checkCommits([c])).toEqual([]);
    expect(checkCommits([c], new Map())).toHaveLength(1);
    expect(checkCommits([{ ...c, sha: "0cdad0c" }])).toHaveLength(1);
    // loop: NOT-WORTH — six entries
    for (const [sha, why] of EXCEPTIONS) expect([sha, why.length > 20], sha).toEqual([expect.stringMatching(/^[0-9a-f]{40}$/), true]);
  });

  // senior review 2026-10-27 S6: the gate read only origin/main..HEAD, which a pushed commit has already left
  describe("in a scratch repository", () => {
    const repo = mkdtempSync(join(tmpdir(), "ck-docs-touch-"));
    afterAll(() => rmSync(repo, { recursive: true, force: true }));
    // loop: NOT-WORTH — a test's few git calls [bounded: timeout 10 s each]
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8", timeout: 10_000 });
    const touch = (...files: string[]) => {
      // loop: NOT-WORTH — a test's few files
      for (const f of files) {
        mkdirSync(join(repo, dirname(f)), { recursive: true });
        writeFileSync(join(repo, f), String(Math.random()));
      }
      git("add", ...files);
    };
    const msg = (text: string) => {
      writeFileSync(join(repo, "MSG"), text);
      return join(repo, "MSG");
    };
    git("init", "-q");
    touch("README.md");
    git("commit", "-q", "-m", "base");

    it("--staged judges the commit being made: its staged files and message (the commit-msg hook)", () => {
      touch(ARGS, "docs/CLI.md");
      expect(checkStaged(msg("CLI: a flag\n"), repo)).toEqual([expect.stringContaining("not docs/wiki/Command-Line.md, docs/GUIDE.md")]);
      expect(checkStaged(msg("CLI: a flag\n\ndocs: none-needed — help text only\n"), repo)).toEqual([]);
      touch("docs/wiki/Command-Line.md", "docs/GUIDE.md");
      expect(checkStaged(msg("CLI: a flag\n"), repo)).toEqual([]);
      git("reset", "-q");
      expect(checkStaged(msg("Docs only\n"), repo)).toEqual([]);
    });

    it("a range reads those commits, with no origin/main (release.sh: since the last tag)", () => {
      git("tag", "v0");
      touch(ARGS);
      git("commit", "-q", "-m", "CLI: a flag");
      expect(checkAll(repo)).toEqual([]);
      expect(checkAll(repo, "v0..HEAD")).toEqual([expect.stringContaining('"CLI: a flag" changes the CLI')]);
    });

    // release review 2026-10-28 #12: `git commit --amend -m` with nothing staged passed, though the commit changes the CLI
    it("--staged --amend judges the amended commit's files (against HEAD^), not only what is staged now", () => {
      expect(checkStaged(msg("CLI: a flag, reworded\n"), repo)).toEqual([]);
      expect(checkStaged(msg("CLI: a flag, reworded\n"), repo, true)).toEqual([expect.stringContaining("changes the CLI")]);
      touch("docs/CLI.md", "docs/wiki/Command-Line.md", "docs/GUIDE.md");
      expect(checkStaged(msg("CLI: a flag, with its docs\n"), repo, true)).toEqual([]);
      git("reset", "-q");
    });
  });
});
