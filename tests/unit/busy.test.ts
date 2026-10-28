// What a restart into an update must wait for (review 2026-10-28 #4): electron/main/busy.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { restartRefusal, type BusyState } from "../../electron/main/busy";

const idle: BusyState = { queue: false, consoleGpu: false, download: false, cacheMoving: false, trtBuild: false };

describe("the restart into an update", () => {
  it("goes when nothing runs; waits for the queue, the Console, a download, a cache move and the TensorRT build", () => {
    expect(restartRefusal(idle)).toBeNull();
    expect(restartRefusal({ ...idle, queue: true })).toMatch(/queue is running/);
    expect(restartRefusal({ ...idle, consoleGpu: true })).toMatch(/Console is running/);
    expect(restartRefusal({ ...idle, download: true })).toMatch(/download is running/);
    expect(restartRefusal({ ...idle, cacheMoving: true })).toMatch(/cache folder is moving/);
    expect(restartRefusal({ ...idle, trtBuild: true })).toMatch(/TensorRT is building/);
  });

  it("index.ts asks it with the app's real state", () => {
    const main = readFileSync(new URL("../../electron/main/index.ts", import.meta.url), "utf8");
    expect(main).toMatch(/cacheMoving: cacheMoving !== null, trtBuild: prebuild\.running/);
    expect(main).toMatch(/const why = restartRefusal\(busyState\(\)\);\n\s+if \(!why\) return updater\.restart\(\);/);
  });
});
