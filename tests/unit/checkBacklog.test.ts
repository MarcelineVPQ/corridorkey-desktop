import { describe, expect, it } from "vitest";
import { cells, checkAll, checkBranches, checkTable } from "../../tools/check_backlog.mjs";

const HEAD = "| # | Item | Source | Status |\n|---|---|---|---|\n";

describe("the backlog gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("splits on unescaped pipes only", () => {
    expect(cells("| 1 | a `x \\| y` | s | idea |")).toEqual([" 1 ", " a `x \\| y` ", " s ", " idea "]);
  });

  it("(a) an unescaped pipe, also inside backticks, fails (row 95 as it was)", () => {
    const md = HEAD + "| 95 | farm export `openjd|deadline` and `;` `&&` `||` | Marcy | building |\n";
    expect(checkTable(md).problems).toEqual([expect.stringContaining("docs/BACKLOG.md:3: 7 cells, not 4")]);
    expect(checkTable(md.replace("openjd|deadline", "openjd\\|deadline").replace("`||`", "`\\|\\|`")).problems).toEqual([]);
  });

  it("(b)-(d) a repeated number, an unknown status, a merge into a missing row fail", () => {
    const md = HEAD + "| 1 | a | s | idea |\n| 1 | b | s | done |\n| 2 | c | s | maybe later |\n| 3 | d | s | merged into row 9 (dupe) |\n";
    expect(checkTable(md).problems).toEqual([
      expect.stringContaining("row 1 is already at line 3"),
      expect.stringContaining('status "maybe later"'),
      expect.stringContaining('"merged into row 9", which doesn\'t exist'),
    ]);
  });

  it("(e) an open status naming a branch already in HEAD fails (row 95: building on feat/console after its merge)", () => {
    const md = HEAD + "| 95 | Console | Marcy | building (branch feat/console): phase 4 |\n| 14 | Portrait | hunt | done on `fix/portrait` |\n";
    const { branches } = checkTable(md);
    expect(branches.map((b) => [b.branch, b.open])).toEqual([
      ["feat/console", true],
      ["fix/portrait", false],
    ]);
    expect(checkBranches(branches, () => true)).toEqual([expect.stringContaining("branch feat/console is already in HEAD")]);
    expect(checkBranches(branches, () => false)).toEqual([]);
  });
});
