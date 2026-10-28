// tools/check_node_modules.mjs (release review 2026-10-28 #4): node_modules must be what package-lock.json says.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkNodeModules, installed } from "../../tools/check_node_modules.mjs";

const scratch = mkdtempSync(join(tmpdir(), "ck-node-modules-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** An app folder with this lock's packages and these installed ones (lock key -> version). */
function app(lock: Record<string, { version: string; optional?: boolean }>, disk: Record<string, string>) {
  const dir = mkdtempSync(join(scratch, "app-"));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "": { name: "app" }, ...lock } }));
  // loop: NOT-WORTH — a few fixture packages
  for (const [key, version] of Object.entries(disk)) {
    mkdirSync(join(dir, key), { recursive: true });
    writeFileSync(join(dir, key, "package.json"), JSON.stringify({ version }));
  }
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  return dir;
}

const LOCK = {
  "node_modules/a": { version: "1.0.0" },
  "node_modules/@s/b": { version: "2.0.0" },
  "node_modules/a/node_modules/c": { version: "3.0.0" },
  "node_modules/@esbuild/aix-ppc64": { version: "0.1.0", optional: true },
};
const DISK = { "node_modules/a": "1.0.0", "node_modules/@s/b": "2.0.0", "node_modules/a/node_modules/c": "3.0.0" };

describe("node_modules against package-lock.json", () => {
  it("passes when they agree (another system's optional package may be absent)", () => {
    const dir = app(LOCK, DISK);
    expect(installed(dir).sort()).toEqual(Object.keys(DISK).sort());
    expect(checkNodeModules(dir)).toEqual([]);
  });

  it("fails on a package at another version, a missing one, or one the lock doesn't list", () => {
    expect(checkNodeModules(app(LOCK, { ...DISK, "node_modules/@s/b": "1.9.0" }))).toEqual(["node_modules/@s/b: installed 1.9.0, the lock says 2.0.0"]);
    const { "node_modules/a/node_modules/c": _gone, ...without } = DISK;
    expect(checkNodeModules(app(LOCK, without))).toEqual(["node_modules/a/node_modules/c: in the lock (3.0.0), not installed"]);
    expect(checkNodeModules(app(LOCK, { ...DISK, "node_modules/@s/b/node_modules/stale": "0.0.1" }))).toEqual(["node_modules/@s/b/node_modules/stale: installed, not in the lock"]);
  });
});
