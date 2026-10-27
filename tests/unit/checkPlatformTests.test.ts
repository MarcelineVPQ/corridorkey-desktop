import { describe, expect, it } from "vitest";
import { branchesOn, checkAll, checkModule, codeOnly } from "../../tools/check_platform_tests.mjs";

const RUNNER = 'const a = p === "win32" ? win32 : posix;\nconst ci = p === "win32" || p === "darwin";\n// on "linux" nothing changes\n';

describe("the platform-test gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads the systems a module's code branches on (comments don't count)", () => {
    expect(branchesOn(codeOnly(RUNNER))).toEqual(["win32", "darwin"]);
    expect(branchesOn("if (isMac(platform)) x();")).toEqual(["darwin"]);
  });

  it("a system its tests never run it as fails (consoleRunner.test before 2026-10-27: darwin only in a comment)", () => {
    const old = {
      path: "tests/unit/consoleRunner.test.ts",
      code: codeOnly('import { ConsoleRunner } from "../../electron/main/console/runner";\nmake({ platform: "win32" });\n// macOS: darwin, win32 only\n'),
    };
    expect(checkModule("electron/main/console/runner", codeOnly(RUNNER), [old])).toEqual([expect.stringContaining('never run it as "darwin"')]);
    const now = { ...old, code: old.code + 'make({ platform: "darwin" });\n' };
    expect(checkModule("electron/main/console/runner", codeOnly(RUNNER), [now])).toEqual([]);
    // no test imports it: not this gate's business
    expect(checkModule("electron/main/other", codeOnly(RUNNER), [now])).toEqual([]);
  });
});
