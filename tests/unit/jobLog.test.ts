// The engine log saved with every job (backlog row 55): <clip>_log.txt next to the results, what ran it on top,
// for done, failed and cancelled jobs.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { clipStem, jobLogText, saveJobLog } from "../../electron/main/jobLog";
import { discardsSettled } from "../../electron/main/partial";
import { Queue, type EngineHandle } from "../../electron/main/queue";
import type { EngineReply } from "../../electron/main/engine";
import { LOG_KEPT, type Job } from "../../src/shared/types";
import { clipInfo, job as fixtureJob } from "./fixtures";

const OUT = mkdtempSync(join(tmpdir(), "ck-joblog-"));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

function rig() {
  let reply: (r: EngineReply) => void = () => {};
  const q = new Queue({
    makeEngine: (onReply) => {
      reply = onReply;
      const h: EngineHandle = {
        running: true,
        start: () => Promise.resolve({ type: "pong", protocol: 1, version: "1.0.0", engine: "onnxruntime", device: "cuda" }),
        send: () => {},
        quit: () => {},
        kill: () => {},
        stderrTail: () => ["thread 'main' panicked"],
      };
      return h;
    },
    tempDirFor: (id) => join(OUT, "temp", id),
    changed: () => {},
    finished: () => {},
    saveLog: (j) => saveJobLog(j, "1.0.0-test"),
    now: () => 1_000,
  });
  return { q, reply: (r: EngineReply) => reply(r), flush: () => new Promise((r) => setTimeout(r, 0)) };
}

const job = (id: string): Job => fixtureJob(id, { clip: clipInfo(id, { path: join(OUT, `${id}.mov`) }), outputDir: join(OUT, `out_${id}`) });

describe("the engine log saved with every job", () => {
  it("names the file as the engines name the clip", () => {
    expect(clipStem("/c/shot_010.mov")).toBe("shot_010");
    expect(clipStem("/c/plate.v2.exr")).toBe("plate.v2");
    expect(clipStem("/c/.hidden")).toBe(".hidden");
    expect(clipStem("/c/shot_020/frames/")).toBe("shot_020");
    expect(clipStem("/c/shot_020/Input")).toBe("shot_020");
    expect(clipStem("/c/seq")).toBe("seq");
  });

  it("writes the whole log next to a done job's results, what ran it on top", async () => {
    const r = rig();
    const j = job("a");
    r.q.add(j);
    await r.q.start();
    await r.flush();
    r.reply({ type: "provider", id: "a", provider: "tensorrt", precision: "fp16", tensorrt_requested: true, range: "h1024-1280_w1792-2176_t1-48_f1-4", cache: "reused" });
    r.reply({ type: "memory", id: "a", hann_chunk: 48, hann_stride: 24, low_vram: true, auto: true, free_gb: 13.9, estimate_gb: 9.4 });
    // loop: NOT-WORTH — 40 lines in a test
    for (let i = 0; i < 40; i++) r.reply({ type: "log", id: "a", text: `line ${i}` });
    r.reply({ type: "result", id: "a", outputs: [] });
    const file = join(j.outputDir, "a_log.txt");
    expect(j.logSaved).toEqual({ path: file, error: null });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("Status: done");
    expect(text).toContain("  Ran on: TensorRT · fp16");
    expect(text).toContain("  TensorRT range: h1024-1280_w1792-2176_t1-48_f1-4 (up to 2176×1280, windows up to 48 frames)");
    expect(text).toContain("  Temporal window: 48 / 24 (chosen automatically)");
    expect(text).toContain("  Low-memory mode: on");
    expect(text).toContain("  Free graphics memory when it started: 13.9 GiB");
    expect(text.indexOf("Technology for this run")).toBeLessThan(text.indexOf("Engine log (41 lines"));
    // every line, not the page's last 12
    expect(text).toContain("line 0\n");
    expect(text).toContain("line 39\n");
  });

  it("writes it for a failed job into its folder, with the engine's error output, and the folder stays", async () => {
    const r = rig();
    const j = job("b");
    r.q.add(j);
    await r.q.start();
    await r.flush();
    r.reply({ type: "log", id: "b", text: "Reading the clip" });
    r.reply({ type: "error", id: "b", code: "oom", message: "out of graphics memory" });
    await discardsSettled();
    expect(readdirSync(j.outputDir)).toEqual(["b_log_failed.txt"]);
    const text = readFileSync(join(j.outputDir, "b_log_failed.txt"), "utf8");
    expect(text).toContain("Status: failed: out of graphics memory");
    expect(text).toContain("  Temporal window: not reported (the job ended before the engine chose it)");
    expect(text).toContain("The engine's last error output (code oom)\nthread 'main' panicked\n");
  });

  it("writes it for a cancelled job, and Copy log's text is the file's", async () => {
    const r = rig();
    const j = job("c");
    r.q.add(j);
    await r.q.start();
    await r.flush();
    r.reply({ type: "log", id: "c", text: "Keying" });
    r.q.stop();
    expect(j.status).toBe("cancelled");
    expect(readFileSync(join(j.outputDir, "c_log_cancelled.txt"), "utf8")).toBe(jobLogText(j, "1.0.0-test"));
    expect(jobLogText(j, "1.0.0-test")).toContain("Status: cancelled");
  });

  it("keeps up to LOG_KEPT lines and says how many went", async () => {
    const r = rig();
    const j = job("d");
    r.q.add(j);
    await r.q.start();
    await r.flush();
    // loop: NOT-WORTH — LOG_KEPT + 5 short lines in a test
    for (let i = 0; i < LOG_KEPT + 5; i++) r.reply({ type: "log", id: "d", text: `l${i}` });
    expect(j.log).toHaveLength(LOG_KEPT);
    expect(j.logDropped).toBe(5);
    expect(jobLogText(j, "x")).toContain("the first 5 lines were dropped");
  });

  it("says why when the log can't be written", () => {
    // a file where its folder should be
    writeFileSync(join(OUT, "blocker"), "");
    const r = saveJobLog(fixtureJob("e", { outputDir: join(OUT, "blocker", "out") }), "x");
    expect(r.error).not.toBeNull();
    expect(existsSync(r.path)).toBe(false);
  });
});
