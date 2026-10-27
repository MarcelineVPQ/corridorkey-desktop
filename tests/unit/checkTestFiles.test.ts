import { describe, expect, it } from "vitest";
import { checkAll, checkModules, importsOf } from "../../tools/check_test_files.mjs";

const MODULES = {
  "electron/main/console/runner": 'import { overview } from "./help";\nimport type { X } from "../engine";\n',
  "electron/main/console/help": "export const overview = () => [];\n",
  "electron/main/appImageQuit": "export const descendantPids = () => [];\n",
  "electron/main/index": 'import { holdAppImageMountUntilExit } from "./appImageQuit";\n',
};

describe("the test-file gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("resolves relative imports", () => {
    expect(importsOf("tests/unit/a.test.ts", 'import { a } from "../../electron/main/queue";\nimport x from "vitest";')).toEqual(["electron/main/queue"]);
    expect(importsOf("electron/main/console/runner.ts", MODULES["electron/main/console/runner"])).toEqual(["electron/main/console/help", "electron/main/engine"]);
  });

  it("a module no test reaches fails (appImageQuit before 2026-10-27); index.ts's imports don't count as tested", () => {
    const tests = {
      "tests/unit/consoleRunner.test.ts": 'import { Console } from "../../electron/main/console/runner";\n',
      "tests/unit/boot.test.ts": 'import { app } from "../../electron/main/index";\n',
    };
    expect(checkModules(MODULES, tests, new Map())).toEqual([expect.stringContaining("electron/main/appImageQuit.ts has no unit test")]);
    const now = {
      "tests/unit/consoleRunner.test.ts": tests["tests/unit/consoleRunner.test.ts"],
      "tests/unit/appImageQuit.test.ts": 'import { descendantPids } from "../../electron/main/appImageQuit";\n',
    };
    expect(checkModules(MODULES, now, new Map([["electron/main/index", "wiring"]]))).toEqual([]);
  });

  it("a stale UNTESTED entry fails", () => {
    const tests = { "tests/unit/x.test.ts": 'import { a } from "../../electron/main/appImageQuit";\nimport { b } from "../../electron/main/console/runner";\n' };
    const listed = new Map([
      ["electron/main/index", "wiring"],
      ["electron/main/appImageQuit", "old"],
      ["electron/main/gone", "old"],
    ]);
    expect(checkModules(MODULES, tests, listed)).toEqual([
      expect.stringContaining("UNTESTED lists electron/main/appImageQuit, which is tested now"),
      expect.stringContaining("electron/main/gone, which doesn't exist"),
    ]);
  });
});
