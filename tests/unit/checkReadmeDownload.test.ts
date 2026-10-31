import { describe, expect, it } from "vitest";
import { checkAll, checkDownload, fixDownload } from "../../tools/check_readme_download.mjs";

// the README of 2026-10-30, while dev.8 was the newest release
const OLD = [
  "Download 1.0.0-dev.7 for Linux, Windows or Apple Silicon Macs from the",
  "[releases page](https://github.com/MarcelineVPQ/corridorkey-desktop/releases/tag/v1.0.0-dev.7).",
  "",
  "- **AMD cards on Linux** from 1.0.0-dev.4.",
].join("\n");

describe("the README download gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("fails on a download or release link that isn't the newest release, never on a version named in passing", () => {
    expect(checkDownload(OLD, "1.0.0-dev.8")).toEqual([
      expect.stringContaining('"Download 1.0.0-dev.7" isn\'t the newest release, 1.0.0-dev.8'),
      expect.stringContaining('"releases/tag/v1.0.0-dev.7" isn\'t the newest release'),
    ]);
    expect(checkDownload(OLD.replace("Download 1.0.0-dev.7", "Get it"), "1.0.0-dev.7")).toEqual([expect.stringContaining('has no "Download 1.0.0-dev.7"')]);
  });

  it("--fix sets both to the feed's version and leaves the rest", () => {
    const fixed = fixDownload(OLD, "1.0.0-dev.8");
    expect(checkDownload(fixed, "1.0.0-dev.8")).toEqual([]);
    expect(fixed).toContain("from 1.0.0-dev.4.");
  });
});
