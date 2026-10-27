import { describe, expect, it } from "vitest";
import { effectivePath, findCli, findEngineFiles, findTrtBuilder, isInsideApp, windowTitle } from "../../electron/main/engineFind";
import { addToPathList, appDirs } from "../../electron/main/platform";

const dataDir = (env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform) => appDirs(env, home, platform).data;

const tree = (files: Record<string, string>) => {
  const paths = Object.keys(files);
  return {
    exists: (p: string) => paths.some((f) => f === p || f.startsWith(`${p}/`)),
    list: (d: string) => {
      const kids = [...new Set(paths.filter((f) => f.startsWith(`${d}/`)).map((f) => f.slice(d.length + 1).split("/")[0]))];
      if (!kids.length) throw new Error("ENOENT");
      return kids;
    },
    read: (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
  };
};
const manifest = (version: string, created: string) => JSON.stringify({ version, created, models: [{ precision: "fp32" }, { precision: "fp16" }, { precision: "fp16" }] });

describe("finding the engine's files", () => {
  it("lists the app's engine, model sets and runtimes, newest first", () => {
    const t = tree({
      "/app/engine/corridorkey-engine": "",
      "/d/models/2.0.0-onnx.2/models.json": "",
      "/d/models/2.0.0-onnx.2/manifest.json": manifest("2.0.0-onnx.2", "2026-10-20T10:00:00-0600"),
      "/d/models/2.0.0-onnx.3/models.json": "",
      "/d/models/2.0.0-onnx.3/manifest.json": manifest("2.0.0-onnx.3", "2026-10-22T06:58:46-0600"),
      "/d/models/half-copied/ck2-rvm-fp16.onnx": "",
      "/d/runtime/ort-1.9.0/onnxruntime/capi/libonnxruntime.so.1.9.0": "",
      "/d/runtime/ort-1.31.0/onnxruntime/capi/libonnxruntime.so.1.31.0": "",
      "/d/runtime/ort-1.31.0/onnxruntime/capi/libonnxruntime_providers_cuda.so": "",
    });
    const f = findEngineFiles({ bundledBinary: "/app/engine/corridorkey-engine", devBinary: "/dev/missing", data: "/d" }, t, "linux");
    expect(f.binary).toEqual([{ path: "/app/engine/corridorkey-engine", label: "Included with the app" }]);
    // a folder without models.json is not a model set; 1.31 sorts above 1.9 (numbers, not text)
    expect(f.models).toEqual([
      { path: "/d/models/2.0.0-onnx.3", label: "2.0.0-onnx.3 (fp16 + fp32)" },
      { path: "/d/models/2.0.0-onnx.2", label: "2.0.0-onnx.2 (fp16 + fp32)" },
    ]);
    expect(f.ort).toEqual([
      { path: "/d/runtime/ort-1.31.0/onnxruntime/capi/libonnxruntime.so.1.31.0", label: "ONNX Runtime 1.31.0 (graphics card)" },
      { path: "/d/runtime/ort-1.9.0/onnxruntime/capi/libonnxruntime.so.1.9.0", label: "ONNX Runtime 1.9.0 (CPU only)" },
    ]);
  });

  it("never offers an install still in progress (.partial-…)", () => {
    const t = tree({
      "/d/runtime/.partial-ort-1.31.0-cuda13/onnxruntime/capi/libonnxruntime.so.1.31.0": "",
      "/d/runtime/.partial-ort-1.31.0-cuda13/onnxruntime/capi/libonnxruntime_providers_cuda.so": "",
      "/d/models/.partial-2.0.0-onnx.3/models.json": "",
    });
    const f = findEngineFiles({ bundledBinary: null, devBinary: null, data: "/d" }, t, "linux");
    expect(f.ort).toEqual([]);
    expect(f.models).toEqual([]);
    expect(effectivePath(null, f.ort)).toBeNull();
  });

  it("knows a path inside the running AppImage (never saved: it changes every launch)", () => {
    expect(isInsideApp("/tmp/.mount_CorridAbC123/resources/engine/corridorkey-engine", "/tmp/.mount_CorridAbC123/resources")).toBe(true);
    expect(isInsideApp("/tmp/.mount_CorridXyZ/resources/engine/corridorkey-engine", null)).toBe(true);
    expect(isInsideApp("/home/m/engine/corridorkey-engine", "/tmp/.mount_CorridAbC123/resources")).toBe(false);
    expect(isInsideApp(null, null)).toBe(false);
  });

  it("finds the Windows runtime (onnxruntime.dll, its version from the kept dist-info)", () => {
    const t = tree({
      "/d/runtime/ort-1.31.0-cuda13/onnxruntime/capi/onnxruntime.dll": "",
      "/d/runtime/ort-1.31.0-cuda13/onnxruntime/capi/onnxruntime_providers_cuda.dll": "",
      "/d/runtime/ort-1.31.0-cuda13/onnxruntime_gpu-1.31.0.dist-info/METADATA": "",
    });
    const f = findEngineFiles({ bundledBinary: null, devBinary: null, data: "/d" }, t, "win32");
    expect(f.ort).toEqual([{ path: "/d/runtime/ort-1.31.0-cuda13/onnxruntime/capi/onnxruntime.dll", label: "ONNX Runtime 1.31.0 (graphics card)" }]);
    expect(dataDir({ LOCALAPPDATA: "C:/Users/m/AppData/Local" }, "C:/Users/m", "win32")).toBe("C:/Users/m/AppData/Local/corridorkey-desktop");
  });

  it("finds the macOS runtime (libonnxruntime.<version>.dylib, Core ML built in) in Application Support", () => {
    const t = tree({ "/d/runtime/ort-1.31.0-coreml/onnxruntime/capi/libonnxruntime.1.31.0.dylib": "" });
    const f = findEngineFiles({ bundledBinary: null, devBinary: null, data: "/d" }, t, "darwin");
    expect(f.ort).toEqual([{ path: "/d/runtime/ort-1.31.0-coreml/onnxruntime/capi/libonnxruntime.1.31.0.dylib", label: "ONNX Runtime 1.31.0 (graphics card)" }]);
    expect(dataDir({ XDG_DATA_HOME: "/ignored" }, "/Users/m", "darwin")).toBe("/Users/m/Library/Application Support/corridorkey-desktop");
  });

  it("titles the window with CorridorKey's own version and the engine", () => {
    expect(windowTitle("2.0.0-onnx.3")).toBe("CorridorKey 2.0 — Rust + ONNX");
    expect(windowTitle("2.1.0-onnx.1")).toBe("CorridorKey 2.1 — Rust + ONNX");
    expect(windowTitle(null)).toBe("CorridorKey — Rust + ONNX");
  });

  it("finds nothing when nothing is installed", () => {
    expect(findEngineFiles({ bundledBinary: null, devBinary: null, data: "/none" }, tree({}), "linux")).toEqual({ binary: [], models: [], ort: [] });
  });

  it("lists a model set with an unreadable manifest under its folder name", () => {
    const f = findEngineFiles({ bundledBinary: null, devBinary: null, data: "/d" }, tree({ "/d/models/mine/models.json": "" }), "linux");
    expect(f.models).toEqual([{ path: "/d/models/mine", label: "mine" }]);
  });

  it("Automatic (null) takes the newest found; a choice wins", () => {
    const found = [
      { path: "/new", label: "n" },
      { path: "/old", label: "o" },
    ];
    expect(effectivePath(null, found)).toBe("/new");
    expect(effectivePath("/old", found)).toBe("/old");
    expect(effectivePath(null, [])).toBeNull();
  });

  it("keeps the data folder in XDG_DATA_HOME, else ~/.local/share", () => {
    expect(dataDir({ XDG_DATA_HOME: "/x" }, "/home/m", "linux")).toBe("/x/corridorkey-desktop");
    expect(dataDir({}, "/home/m", "linux")).toBe("/home/m/.local/share/corridorkey-desktop");
  });
});

describe("each system's folders and lists (platform.ts)", () => {
  it("keeps the cache next to the data on every system, never in /tmp", () => {
    expect(appDirs({ XDG_CACHE_HOME: "/c" }, "/home/m", "linux").cache).toBe("/c/corridorkey-desktop");
    expect(appDirs({}, "/home/m", "linux").cache).toBe("/home/m/.cache/corridorkey-desktop");
    expect(appDirs({ LOCALAPPDATA: "C:/L" }, "C:/Users/m", "win32").cache).toBe("C:/L/corridorkey-desktop/cache");
    expect(appDirs({}, "/Users/m", "darwin").cache).toBe("/Users/m/Library/Caches/corridorkey-desktop");
  });
  it("adds folders to a PATH list once, in front or behind", () => {
    expect(addToPathList("/usr/bin:/bin", ["/opt/homebrew/bin", "/usr/bin"], "back", ":")).toBe("/usr/bin:/bin:/opt/homebrew/bin");
    expect(addToPathList("C:/W", ["C:/ff", "C:/ff"], "front", ";")).toBe("C:/ff;C:/W");
    expect(addToPathList(undefined, ["/x"], "front", ":")).toBe("/x");
  });
});

describe("TensorRT's builder", () => {
  it("is found next to the engine (the AppImage's resources/engine), else in the release build's folder", () => {
    const has = (p: string[]) => (x: string) => p.includes(x);
    expect(findTrtBuilder("/app/resources/engine/corridorkey-engine", null, has(["/app/resources/engine/ck-trt-build"]))).toBe("/app/resources/engine/ck-trt-build");
    expect(findTrtBuilder("/src/engine-rs/target/release/corridorkey-engine", "/src/engine-rs/target/dist", has(["/src/engine-rs/target/dist/ck-trt-build"]))).toBe(
      "/src/engine-rs/target/dist/ck-trt-build",
    );
    expect(findTrtBuilder("/e/corridorkey-engine", "/dist", has([]))).toBeNull();
    expect(findTrtBuilder(null, null, has([]))).toBeNull();
  });
});

describe("the command line (corridorkey)", () => {
  const has = (p: string[]) => (x: string) => p.includes(x);
  it("is found next to the engine (packaged: resources/engine), else in the release build's folder", () => {
    expect(findCli("/app/resources/engine/corridorkey-engine", null, has(["/app/resources/engine/corridorkey"]), "linux")).toBe("/app/resources/engine/corridorkey");
    // a dev engine: target/release has its own corridorkey (cargo builds both), else target/dist's
    expect(findCli("/src/engine-rs/target/release/corridorkey-engine", "/src/engine-rs/target/dist", has(["/src/engine-rs/target/release/corridorkey"]), "linux")).toBe(
      "/src/engine-rs/target/release/corridorkey",
    );
    expect(findCli("/src/engine-rs/target/release/corridorkey-engine", "/src/engine-rs/target/dist", has(["/src/engine-rs/target/dist/corridorkey"]), "linux")).toBe(
      "/src/engine-rs/target/dist/corridorkey",
    );
    expect(findCli("/e/corridorkey-engine", "/dist", has([]), "linux")).toBeNull();
    expect(findCli(null, null, has([]), "linux")).toBeNull();
  });
  it("is corridorkey.exe on Windows", () => {
    expect(findCli("C:/CK/resources/engine/corridorkey-engine.exe", null, has(["C:/CK/resources/engine/corridorkey.exe"]), "win32")).toBe("C:/CK/resources/engine/corridorkey.exe");
    expect(findCli("C:/CK/resources/engine/corridorkey-engine.exe", null, has(["C:/CK/resources/engine/corridorkey"]), "win32")).toBeNull();
    expect(findCli("/Applications/CorridorKey.app/Contents/Resources/engine/corridorkey-engine", null, has(["/Applications/CorridorKey.app/Contents/Resources/engine/corridorkey"]), "darwin")).toBe(
      "/Applications/CorridorKey.app/Contents/Resources/engine/corridorkey",
    );
  });
});
