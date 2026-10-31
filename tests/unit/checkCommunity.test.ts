import { describe, expect, it } from "vitest";
import { checkAll, checkFiles, FILES } from "../../tools/check_community.mjs";

const ALL = [...FILES, ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/config.yml"];

describe("the community files gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("fails on each missing file", () => {
    for (const f of FILES) expect(checkFiles(ALL.filter((p) => p !== f))).toEqual([expect.stringContaining(`${f} is missing`)]);
  });

  it("needs an issue form other than config.yml", () => {
    expect(checkFiles([...FILES, ".github/ISSUE_TEMPLATE/config.yml"])).toEqual([expect.stringContaining("has no issue form")]);
    expect(checkFiles([...FILES, ".github/ISSUE_TEMPLATE/feature.md"])).toEqual([]);
  });
});
