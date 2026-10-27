// The AppImage quit guard's pure parts (electron/main/appImageQuit.ts): the process tree it waits for, and the
// helper's argv (a fixed script; the pids only as arguments).
import { describe, expect, it } from "vitest";
import { descendantPids, mountGuardArgs, WAIT_SCRIPT } from "../../electron/main/appImageQuit";

describe("the AppImage quit guard", () => {
  it("finds every process below the app, once each, even with a loop in the lookup", () => {
    const tree: Record<number, number[]> = { 1: [2, 3], 2: [4], 3: [2], 4: [] };
    expect(descendantPids(1, (p) => tree[p] ?? [])).toEqual([2, 3, 4]);
  });

  it("stops at 256 processes", () => {
    expect(descendantPids(0, (p) => (p < 1000 ? [p + 1] : []))).toHaveLength(256);
  });

  it("passes the pids as arguments to the fixed script, never inside it", () => {
    expect(mountGuardArgs([10, 11])).toEqual(["-c", WAIT_SCRIPT, "sh", "10", "11"]);
  });
});
