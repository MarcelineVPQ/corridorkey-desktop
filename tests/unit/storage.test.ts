import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TrtCatalog } from "../../electron/main/install";
import { folderBytes, pruneCache, removeAside, removeStorage, storageItems, sweepRemoving } from "../../electron/main/storage";

describe("storage", () => {
  const dir = mkdtempSync(join(tmpdir(), "ck-storage-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const day = 86_400_000;
  const now = Date.UTC(2026, 9, 24);
  const still = (name: string, bytes: number, ageDays: number) => {
    const p = join(dir, "media", name);
    writeFileSync(p, Buffer.alloc(bytes));
    const t = (now - ageDays * day) / 1000;
    utimesSync(p, t, t);
  };

  it("measures folders, nested ones too, and an absent one as 0", async () => {
    mkdirSync(join(dir, "data", "models", "set"), { recursive: true });
    writeFileSync(join(dir, "data", "models", "set", "a.onnx"), Buffer.alloc(1000));
    writeFileSync(join(dir, "data", "models", "b.json"), Buffer.alloc(24));
    expect(await folderBytes(join(dir, "data", "models"))).toBe(1024);
    expect(await folderBytes(join(dir, "nope"))).toBe(0);
    const items = await storageItems(join(dir, "data"), dir, "ONNX Runtime, CUDA, cuDNN", "win32");
    expect(items.map((i) => [i.id, i.bytes])).toEqual([
      ["runtime", 0],
      ["models", 1024],
      ["cache", 0],
    ]);
  });

  it("measures TensorRT's parts as their own item (Linux), out of the runtime's and models' sizes, and removes only them", async () => {
    const data = join(dir, "trt");
    const rt = join(data, "runtime", "rt");
    const m1 = join(data, "models", "m1");
    mkdirSync(join(rt, "tensorrt_libs"), { recursive: true });
    mkdirSync(join(rt, "tensorrt_cu13_libs-10.16.1.11.dist-info"), { recursive: true });
    mkdirSync(join(rt, "onnxruntime", "capi"), { recursive: true });
    mkdirSync(m1, { recursive: true });
    writeFileSync(join(rt, "onnxruntime", "capi", "libonnxruntime.so.1.31.0"), Buffer.alloc(100));
    writeFileSync(join(rt, "tensorrt_libs", "libnvinfer.so.10"), Buffer.alloc(700));
    writeFileSync(join(rt, "tensorrt_cu13_libs-10.16.1.11.dist-info", "LICENSE.txt"), Buffer.alloc(10));
    writeFileSync(join(m1, "a.onnx"), Buffer.alloc(300));
    writeFileSync(join(m1, "models.json"), JSON.stringify({ fp16: { rvm: "a.onnx" }, "tensorrt-fp16": { rvm: "t.onnx" } }));
    writeFileSync(join(m1, "t.onnx"), Buffer.alloc(200));
    writeFileSync(join(m1, "models-tensorrt.json"), JSON.stringify({ "tensorrt-fp16": { rvm: "t.onnx" } }));
    const c: TrtCatalog = {
      runtime: { name: "rt", wheels: [{ file: "onnxruntime_gpu.whl", url: "", size: 1, sha256: "" }] },
      models: { name: "m1", files: [] },
      libs: { file: "trt.whl", url: "", size: 1, sha256: "" },
      trtModels: {
        name: "m1-trt",
        files: [
          { file: "t.onnx", url: "", size: 200, sha256: "" },
          { file: "models.json", url: "", size: 1, sha256: "" },
        ],
      },
    };
    const list = statSync(join(m1, "models-tensorrt.json")).size;
    const modelsJson = statSync(join(m1, "models.json")).size;
    // the engines built for the card count with TensorRT too
    const cache = join(dir, "cache2");
    mkdirSync(join(cache, "tensorrt", "h1024"), { recursive: true });
    writeFileSync(join(cache, "tensorrt", "h1024", "stage2.engine"), Buffer.alloc(50));
    const items = await storageItems(data, cache, "ONNX Runtime, CUDA, cuDNN", "linux", c);
    expect(items.map((i) => [i.id, i.bytes])).toEqual([
      ["runtime", 100],
      ["models", 300 + modelsJson],
      ["tensorrt", 710 + 200 + list + 50],
      ["cache", 0],
    ]);
    await removeStorage(items[2], data, cache, c);
    expect(readdirSync(cache)).toEqual([]);
    expect(readdirSync(rt)).toEqual(["onnxruntime"]);
    expect(readdirSync(m1).sort()).toEqual(["a.onnx", "models.json"]);
    expect(JSON.parse(readFileSync(join(m1, "models.json"), "utf8"))).toEqual({ fp16: { rvm: "a.onnx" } });
    // no TensorRT item off Linux: there is no switch to bring it back there
    expect((await storageItems(data, dir, "x", "darwin")).map((i) => i.id)).toEqual(["runtime", "models", "cache"]);
  });

  it("removes a folder by renaming it aside first, with an earlier removal's leftover (review 2026-10-27)", async () => {
    const parent = join(dir, "aside");
    mkdirSync(join(parent, "runtime", "lib"), { recursive: true });
    writeFileSync(join(parent, "runtime", "lib", "a.so"), "x");
    mkdirSync(join(parent, ".runtime.removing"), { recursive: true });
    writeFileSync(join(parent, ".runtime.removing", "old.so"), "x");
    writeFileSync(join(parent, "keep.txt"), "x");
    await removeAside(join(parent, "runtime"));
    expect(readdirSync(parent)).toEqual(["keep.txt"]);
    // nothing there: nothing to do
    await removeAside(join(parent, "runtime"));
    expect(readdirSync(parent)).toEqual(["keep.txt"]);
  });

  it("sweeps the .<name>.removing leftovers of removals cut short at start, nothing else", async () => {
    const data = join(dir, "sweep-data");
    const cache = join(dir, "sweep-cache");
    mkdirSync(join(data, ".models.removing", "x"), { recursive: true });
    mkdirSync(join(data, "models"), { recursive: true });
    mkdirSync(join(cache, ".tensorrt.removing"), { recursive: true });
    writeFileSync(join(cache, "removing"), "x");
    expect(await sweepRemoving([data, cache, join(dir, "not-there")])).toBe(2);
    expect(readdirSync(data)).toEqual(["models"]);
    expect(readdirSync(cache)).toEqual(["removing"]);
  });

  it("prunes cached stills older than 30 days, then the oldest until under the cap", async () => {
    mkdirSync(join(dir, "media"), { recursive: true });
    still("old.jpg", 100, 40);
    still("mid.jpg", 300, 10);
    still("new.jpg", 300, 1);
    // the old one goes for its age; then 600 bytes > a 400-byte cap: the next oldest goes too
    expect(await pruneCache(join(dir, "media"), now, 30, 400)).toBe(2);
    expect(readdirSync(join(dir, "media"))).toEqual(["new.jpg"]);
    expect(await pruneCache(join(dir, "media"), now, 30, 400)).toBe(0);
    expect(await pruneCache(join(dir, "absent"), now)).toBe(0);
  });
});
