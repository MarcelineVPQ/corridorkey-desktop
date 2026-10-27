import { describe, expect, it } from "vitest";
import { checkCommits, parseLog } from "../../tools/check_docs_touch.mjs";

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
});
