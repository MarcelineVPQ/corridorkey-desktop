// What a restart into an update must wait for (review 2026-10-28 #4) and what a quit asks about (#5): electron/main/busy.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QUIT_ANYWAY, quitQuestion, restartRefusal, runningWork, type BusyState } from "../../electron/main/busy";

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

describe("closing the window or quitting while work runs (review 2026-10-28 #5)", () => {
  it("names the work a quit would stop; the TensorRT build goes on at the next start, so it isn't asked about", () => {
    expect(runningWork(idle)).toEqual([]);
    expect(runningWork({ ...idle, trtBuild: true })).toEqual([]);
    expect(runningWork({ queue: true, consoleGpu: true, download: true, cacheMoving: true, trtBuild: true })).toEqual([
      "the queue is running",
      "the Console is running corridorkey",
      "a download is running",
      "the cache folder is moving",
    ]);
  });

  it("asks Quit anyway / Keep running, Keep running the default and the Escape answer", () => {
    const q = quitQuestion(["the queue is running", "a download is running"]);
    expect(q.detail).toMatch(/^The queue is running, a download is running\. Quitting stops it/);
    expect(q.buttons[q.defaultId]).toBe("Keep running");
    expect(q.buttons[q.cancelId]).toBe("Keep running");
    expect(q.buttons[QUIT_ANYWAY]).toBe("Quit anyway");
  });

  it("index.ts asks on the window's close and on every quit, before the quit's cleanup", () => {
    const main = readFileSync(new URL("../../electron/main/index.ts", import.meta.url), "utf8");
    expect(main).toMatch(/mainWindow\.on\("close", \(e\) => \{\n\s+if \(!mayQuit\(\)\) e\.preventDefault\(\);/);
    expect(main).toMatch(/app\.on\("before-quit", \(e\) => \{\n\s+if \(quitCleaned\) return;\n\s+if \(!mayQuit\(\)\) return e\.preventDefault\(\);/);
    expect(main).toMatch(/const work = runningWork\(busyState\(\)\);/);
  });
});
