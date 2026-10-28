import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EngineProcess, launchCommand, rustEngineEnv } from "../../electron/main/engine";
import { taskkillPath } from "../../electron/main/platform";

function fakeChild(onLine: (line: string, out: PassThrough) => void): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), pid: undefined });
  stdin.on("data", (b: Buffer) =>
    b
      .toString()
      .trim()
      .split("\n")
      .forEach((l) => onLine(l, stdout)),
  );
  return child;
}

const launch = { binary: "/e/corridorkey-engine", models: "/m", ort: null, env: {} };

describe("EngineProcess", () => {
  it("resolves the pong and forwards other replies", async () => {
    const replies: unknown[] = [];
    const p = new EngineProcess(
      launch,
      (r) => replies.push(r),
      () => {},
      () =>
        fakeChild((l, out) => {
          if (JSON.parse(l).cmd === "ping") out.write('{"type":"pong","protocol":1,"version":"0.1.0"}\n{"type":"log","text":"hi"}\n');
        }),
    );
    expect((await p.start()).version).toBe("0.1.0");
    await new Promise((r) => setTimeout(r, 10));
    expect(replies).toEqual([{ type: "log", text: "hi" }]);
  });

  it("refuses an engine with another protocol", async () => {
    const p = new EngineProcess(
      launch,
      () => {},
      () => {},
      () => fakeChild((_l, out) => out.write('{"type":"pong","protocol":9}\n')),
    );
    await expect(p.start()).rejects.toThrow(/protocol 9/);
  });

  it("fails the start at once when the ping is answered with an error (a panic in the engine's pong)", async () => {
    const p = new EngineProcess(
      launch,
      () => {},
      () => {},
      () => fakeChild((_l, out) => out.write('{"type":"error","id":null,"code":"engine","message":"internal error: boom"}\n')),
    );
    await expect(p.start()).rejects.toThrow(/couldn't answer the ping: internal error: boom/);
  });

  it("keeps a JSON line that isn't an object (`null`) in the stderr tail instead of throwing (review 2026-10-27)", async () => {
    const replies: unknown[] = [];
    const p = new EngineProcess(
      launch,
      (r) => replies.push(r),
      () => {},
      () => fakeChild((_l, out) => out.write('null\n7\n{"type":"pong","protocol":1,"version":"0.1.0"}\n')),
    );
    expect((await p.start()).version).toBe("0.1.0");
    expect(p.stderrTail()).toEqual(["[stdout] null", "[stdout] 7"]);
    expect(replies).toEqual([]);
  });

  it("a write to an engine that died (EPIPE on stdin) is no uncaught exception (review 2026-10-27)", async () => {
    let child: ChildProcess | null = null;
    const p = new EngineProcess(
      launch,
      () => {},
      () => {},
      () => (child = fakeChild((_l, out) => out.write('{"type":"pong","protocol":1}\n'))),
    );
    await p.start();
    // an 'error' event with no listener throws
    expect(() => child!.stdin!.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
  });
});

describe("engine launch", () => {
  it("names Windows' taskkill by its full path, never a bare name (review 2026-10-27)", () => {
    expect(taskkillPath({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\taskkill.exe");
    expect(taskkillPath({})).toBe("C:\\Windows\\System32\\taskkill.exe");
  });

  it("runs the Rust engine with its models (and ONNX Runtime's library)", () => {
    const c = launchCommand({ binary: "/e/corridorkey-engine", models: "/m", ort: null, env: { HOME: "/h", LD_PRELOAD: "/bad.so" } });
    expect([c.cmd, ...c.args]).toEqual(["/e/corridorkey-engine", "--models", "/m"]);
    // the engine ends with this app (proc.rs end_with_parent): it gets the app's pid
    expect(c.env).toEqual({ HOME: "/h", CK_ENGINE_PARENT_PID: String(process.pid) });
    const g = launchCommand({ binary: "/e/corridorkey-engine", models: "/m", ort: "/o/libonnxruntime.so", env: {} });
    expect(g.args).toEqual(["--models", "/m", "--ort", "/o/libonnxruntime.so"]);
  });

  it("points the Rust engine's TensorRT cache at the app's cache folder, unless the environment says otherwise", () => {
    const c = launchCommand({ binary: "/e/corridorkey-engine", models: "/m", ort: null, env: {}, trtCache: "/c/corridorkey-desktop/tensorrt" });
    expect(c.env.CK_ENGINE_TRT_CACHE).toBe("/c/corridorkey-desktop/tensorrt");
    const o = launchCommand({ binary: "/e/corridorkey-engine", models: "/m", ort: null, env: { CK_ENGINE_TRT_CACHE: "/mine" }, trtCache: "/c/t" });
    expect(o.env.CK_ENGINE_TRT_CACHE).toBe("/mine");
  });

  it("hands the Rust engine the shipped TensorRT builder, unless the environment names one", () => {
    const c = launchCommand({ binary: "/e/corridorkey-engine", models: "/m", ort: null, env: {}, trtBuild: "/e/ck-trt-build" });
    expect(c.env.CK_ENGINE_TRT_BUILD).toBe("/e/ck-trt-build");
    const o = launchCommand({ binary: "/e/corridorkey-engine", models: "/m", ort: null, env: { CK_ENGINE_TRT_BUILD: "/mine" }, trtBuild: "/e/ck-trt-build" });
    expect(o.env.CK_ENGINE_TRT_BUILD).toBe("/mine");
    expect(launchCommand({ binary: "/e/corridorkey-engine", models: "/m", ort: null, env: {}, trtBuild: null }).env).not.toHaveProperty("CK_ENGINE_TRT_BUILD");
  });

  it("finds the CUDA, cuDNN and TensorRT libraries of a pip-wheel layout next to ONNX Runtime", () => {
    const site = "/v/lib/python3.12/site-packages";
    const have = new Set([`${site}/nvidia`, `${site}/nvidia/cu13/lib`, `${site}/nvidia/cudnn/lib`, `${site}/tensorrt_libs`]);
    const env = rustEngineEnv(
      { LD_LIBRARY_PATH: "/appimage/lib", CK_ENGINE_LD_LIBRARY_PATH: "/extra" },
      `${site}/onnxruntime/capi/libonnxruntime.so.1.31.0`,
      (p) => have.has(p),
      () => ["cudnn", "cu13", "readme"],
      "linux",
    );
    expect(env.LD_LIBRARY_PATH).toBe([`${site}/onnxruntime/capi`, `${site}/nvidia/cu13/lib`, `${site}/nvidia/cudnn/lib`, `${site}/tensorrt_libs`, "/extra"].join(":"));
    expect(env.CK_ENGINE_ORT).toBe(`${site}/onnxruntime/capi/libonnxruntime.so.1.31.0`);
  });

  it("puts the macOS library folder on DYLD_LIBRARY_PATH and drops inherited DYLD variables", () => {
    const rt = "/data/runtime/ort-1.31.0-coreml";
    const env = rustEngineEnv(
      { DYLD_INSERT_LIBRARIES: "/x.dylib", DYLD_LIBRARY_PATH: "/old" },
      `${rt}/onnxruntime/capi/libonnxruntime.1.31.0.dylib`,
      () => false,
      () => [],
      "darwin",
    );
    expect(env.DYLD_LIBRARY_PATH).toBe(`${rt}/onnxruntime/capi`);
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
  });

  it("asks for Core ML on macOS (BACKLOG row 58), unless CK_ENGINE_DEVICE is already set; never elsewhere", () => {
    const run = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
      rustEngineEnv(
        env,
        null,
        () => false,
        () => [],
        platform,
      ).CK_ENGINE_DEVICE;
    expect(run({}, "darwin")).toBe("coreml");
    expect(run({ CK_ENGINE_DEVICE: "cpu" }, "darwin")).toBe("cpu");
    expect(run({}, "linux")).toBeUndefined();
    expect(run({}, "win32")).toBeUndefined();
  });

  it("puts the Windows DLL folders (bin, CUDA 13's bin/x86_64) first on PATH", () => {
    const rt = "/data/runtime/ort-1.31.0-cuda13";
    const vc = `${rt}/msvc_runtime-14.51.36231.data/data/Scripts`;
    const have = new Set([rt, `${rt}/nvidia`, `${rt}/nvidia/cu13/bin/x86_64`, `${rt}/nvidia/cudnn/bin`, vc]);
    const env = rustEngineEnv(
      { PATH: "C:/Windows" },
      `${rt}/onnxruntime/capi/onnxruntime.dll`,
      (p) => have.has(p),
      (p) => (p === rt ? ["onnxruntime", "nvidia", "msvc_runtime-14.51.36231.data", "msvc_runtime-14.51.36231.dist-info"] : ["cu13", "cudnn"]),
      "win32",
    );
    // the Visual C++ runtime folder too: onnxruntime.dll can't load without it on a fresh Windows
    expect(env.PATH).toBe([`${rt}/onnxruntime/capi`, `${rt}/nvidia/cu13/bin/x86_64`, `${rt}/nvidia/cudnn/bin`, vc, "C:/Windows"].join(";"));
    expect(env.LD_LIBRARY_PATH).toBeUndefined();
  });
});
