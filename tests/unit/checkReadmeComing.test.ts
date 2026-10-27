import { describe, expect, it } from "vitest";
import { checkAll, checkComing, statuses } from "../../tools/check_readme_coming.mjs";

const BACKLOG = [
  "| # | Item | Source | Status |",
  "|---|---|---|---|",
  "| 4 | Mask painter | Marcy | agreed |",
  "| 7 | Review tools | video | idea |",
  "| 32 | Farm CLI | Marcy | built, in 1.0.0-dev.2 |",
  "| 59 | Core ML set | Marcy | published 2026-10-27 |",
  "| 60 | 4K Core ML | Marcy | open |",
].join("\n");

describe("the README What's coming gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads the statuses", () => {
    expect(statuses(BACKLOG).get("4")).toBe("agreed");
  });

  it("finished rows, unknown rows and decided rows under Ideas fail (the README before 2026-10-27)", () => {
    const old =
      "## What's coming\n\n**Working on now:** setup installs the Core ML models [59], a 4K set [60].\n\n**Agreed, after 1.0:** a render-farm command line [32].\n\n**Ideas, not decided:** making hints in the app [4], review tools [7], [99].\n\n## Requirements\n\n[59]\n";
    expect(checkComing(old, statuses(BACKLOG))).toEqual([
      expect.stringContaining("[59] is finished"),
      expect.stringContaining("[32] is finished"),
      expect.stringContaining('[4] is under "Ideas, not decided:"'),
      expect.stringContaining("[99] isn't a backlog row"),
    ]);
    const fixed = "## What's coming\n\n**Working on now:** a 4K set [60].\n\n**Agreed, not scheduled yet:** a mask painter [4].\n\n**Ideas, not decided:** review tools [7].\n";
    expect(checkComing(fixed, statuses(BACKLOG))).toEqual([]);
  });
});
