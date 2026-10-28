// What the packaged app carries (whole-code review 2026-10-27: app.asar shipped 46 MB of node_modules nothing loaded).
// electron-builder copies package.json's `dependencies` into app.asar, so there are none: every package is a
// devDependency, which electron-vite bundles wherever the code imports it (main and preload import only Electron and
// Node's built-ins today; tools/gen_notices.mjs lists the bundled packages from the code's imports).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("packaging", () => {
  it("has no production dependencies, so app.asar has no node_modules", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
