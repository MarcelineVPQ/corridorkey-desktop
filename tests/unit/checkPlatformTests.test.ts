import { describe, expect, it } from "vitest";
import { branchesOn, checkAll, checkModule, codeOnly, passesSystem } from "../../tools/check_platform_tests.mjs";

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
    // a branch no test can take is listed with why; listed and tested is stale
    const why = new Map([["electron/main/console/runner darwin", "why"]]);
    expect(checkModule("electron/main/console/runner", codeOnly(RUNNER), [old], why)).toEqual([]);
    expect(checkModule("electron/main/console/runner", codeOnly(RUNNER), [now], why)).toEqual([expect.stringContaining("remove it")]);
    // a test that only quotes the import in a fixture string doesn't import it
    const quoted = { path: "tests/unit/x.test.ts", code: `const f = 'import { C } from "../../electron/main/console/runner";';\n` };
    expect(checkModule("electron/main/console/runner", codeOnly(RUNNER), [quoted])).toEqual([]);
    // an unrelated "darwin" (an expected value, a comparison, text) isn't running it as darwin (release review 2026-10-28 #14)
    const unrelated = { ...old, code: old.code + 'expect(list).toEqual(["windows", "darwin"]);\nit.skipIf(process.platform === "darwin")("x", f);\nconst s = "on darwin";\n' };
    expect(checkModule("electron/main/console/runner", codeOnly(RUNNER), [unrelated])).toEqual([expect.stringContaining('never run it as "darwin"')]);
    // no test imports it: not this gate's business
    expect(checkModule("electron/main/other", codeOnly(RUNNER), [now])).toEqual([]);
  });
});

describe("passesSystem", () => {
  it("counts a system handed in: a call argument, a platform field, an array item", () => {
    expect(passesSystem('f(x, "darwin")', "darwin")).toBe(true);
    expect(passesSystem('systemSupport("darwin", "arm64")', "darwin")).toBe(true);
    expect(passesSystem('make({ platform: "darwin" })', "darwin")).toBe(true);
    expect(passesSystem('for (const p of ["linux", "darwin"] as const) run(p);', "darwin")).toBe(true);
    // an input on the same line as an expectation still counts
    expect(passesSystem('expect(useTensorrt({ ...yes, platform: "darwin" })).toBe(false);', "darwin")).toBe(true);
  });

  it("doesn't count an expected value, a comparison or text", () => {
    expect(passesSystem('expect(os).toBe("darwin");', "darwin")).toBe(false);
    expect(passesSystem('expect(list).toEqual(["windows", "darwin"]);', "darwin")).toBe(false);
    expect(passesSystem('expect(x).not.toContain("darwin");', "darwin")).toBe(false);
    expect(passesSystem('if (process.platform === "darwin") skip();', "darwin")).toBe(false);
    expect(passesSystem('const s = "darwin";', "darwin")).toBe(false);
  });
});
