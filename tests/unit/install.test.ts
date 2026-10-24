import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadVerified } from "../../electron/main/download";
import {
  installNeeds,
  keepFromWheel,
  keepTensorrt,
  MODELS,
  removeTensorrt,
  RUNTIME,
  RUNTIME_MAC,
  RUNTIME_WIN,
  runInstall,
  runTrtInstall,
  runtimeFor,
  systemSupport,
  TENSORRT,
  TRT_BYTES,
  trtNeeds,
  trtReady,
  trtSupported,
  useTensorrt,
  type Catalog,
  type TrtCatalog,
} from "../../electron/main/install";
import { unzip } from "../../electron/main/unzip";

/** A minimal zip (deflated entries) as a wheel looks, for the unpacker. */
function makeZip(files: Record<string, string>, stored: string[] = []): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const method = stored.includes(name) ? 0 : 8;
    const comp = method === 0 ? data : deflateRawSync(data);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp);
    central.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("first-run install", () => {
  const dir = mkdtempSync(join(tmpdir(), "ck-install-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps the runtime libraries and licences from a wheel, nothing else", () => {
    expect(keepFromWheel("onnxruntime/capi/libonnxruntime.so.1.31.0")).toBe(true);
    expect(keepFromWheel("onnxruntime/capi/libonnxruntime_providers_cuda.so")).toBe(true);
    // kept since 1.0: the opt-in TensorRT install then needs no second ONNX Runtime download
    expect(keepFromWheel("onnxruntime/capi/libonnxruntime_providers_tensorrt.so")).toBe(true);
    expect(keepFromWheel("onnxruntime/capi/onnxruntime_pybind11_state.cpython-312-x86_64-linux-gnu.so")).toBe(false);
    expect(keepFromWheel("nvidia/cu13/lib/libcublasLt.so.13")).toBe(true);
    expect(keepFromWheel("nvidia/cudnn/include/cudnn.h")).toBe(false);
    expect(keepFromWheel("nvidia_cudnn_cu13-9.27.0.42.dist-info/licenses/License.txt")).toBe(true);
    // Windows wheels
    expect(keepFromWheel("onnxruntime/capi/onnxruntime.dll")).toBe(true);
    expect(keepFromWheel("onnxruntime/capi/onnxruntime_providers_tensorrt.dll")).toBe(false);
    expect(keepFromWheel("nvidia/cu13/bin/x86_64/cublasLt64_13.dll")).toBe(true);
    expect(keepFromWheel("nvidia/cudnn/bin/cudnn64_9.dll")).toBe(true);
    // Windows: Microsoft's Visual C++ runtime, which onnxruntime.dll needs (the Scripts copy has all four)
    expect(keepFromWheel("msvc_runtime-14.51.36231.data/data/Scripts/vcruntime140_1.dll")).toBe(true);
    expect(keepFromWheel("msvc_runtime-14.51.36231.data/data/Scripts/msvcp140.dll")).toBe(true);
    expect(keepFromWheel("msvc_runtime-14.51.36231.data/data/Scripts/vcamp140.dll")).toBe(false);
    expect(keepFromWheel("msvc_runtime.cp312-win_amd64.pyd")).toBe(false);
    expect(RUNTIME_WIN.wheels.some((w) => w.file.startsWith("msvc_runtime-"))).toBe(true);
    expect(keepFromWheel("onnxruntime_gpu-1.31.0.dist-info/METADATA")).toBe(true);
  });

  it("unpacks the chosen entries and refuses paths outside the folder", async () => {
    const zip = join(dir, "w.whl");
    writeFileSync(zip, makeZip({ "nvidia/cu13/lib/libx.so.13": "LIB", "nvidia/cu13/include/x.h": "H" }));
    expect(await unzip(zip, join(dir, "out"), keepFromWheel)).toEqual(["nvidia/cu13/lib/libx.so.13"]);
    expect(readFileSync(join(dir, "out/nvidia/cu13/lib/libx.so.13"), "utf8")).toBe("LIB");
    expect(existsSync(join(dir, "out/nvidia/cu13/include/x.h"))).toBe(false);
    writeFileSync(zip, makeZip({ "../evil.so": "x" }));
    await expect(unzip(zip, join(dir, "out2"), () => true)).rejects.toThrow("outside the folder");
  });

  it("unpacks an empty stored file (a 0-byte licence) instead of failing the install", async () => {
    const zip = join(dir, "e.whl");
    writeFileSync(zip, makeZip({ "x.dist-info/licenses/LICENSE": "", "nvidia/cu13/lib/liby.so.13": "Y" }, ["x.dist-info/licenses/LICENSE"]));
    expect(await unzip(zip, join(dir, "out4"), keepFromWheel)).toHaveLength(2);
    expect(readFileSync(join(dir, "out4/x.dist-info/licenses/LICENSE"), "utf8")).toBe("");
  });

  it("stops unpacking when Stop is pressed", async () => {
    const zip = join(dir, "s.whl");
    writeFileSync(zip, makeZip({ "nvidia/cu13/lib/liba.so.13": "A", "nvidia/cu13/lib/libb.so.13": "B" }));
    const stop = new AbortController();
    stop.abort();
    await expect(unzip(zip, join(dir, "out3"), keepFromWheel, stop.signal)).rejects.toThrow();
    expect(existsSync(join(dir, "out3/nvidia/cu13/lib/libb.so.13"))).toBe(false);
  });

  it("knows what is missing from the data folder", () => {
    const has = (p: string[]) => (x: string) => p.includes(x);
    const linux: Catalog = { runtime: RUNTIME, models: MODELS };
    expect(installNeeds("/d", has([]), linux).bytes).toBe(RUNTIME.wheels.reduce((n, w) => n + w.size, 0) + MODELS.files.reduce((n, f) => n + f.size, 0));
    expect(installNeeds("/d", has([`/d/runtime/${RUNTIME.name}`, `/d/models/${MODELS.name}`]), linux)).toEqual({ runtime: false, models: false, bytes: 0 });
  });
});

describe("resumable SHA-256 download", () => {
  const body = Buffer.from("x".repeat(1000) + "y".repeat(1000));
  const sha256 = createHash("sha256").update(body).digest("hex");
  let server: Server;
  let url = "";
  const ranges: (string | undefined)[] = [];
  const dir = mkdtempSync(join(tmpdir(), "ck-dl-"));
  beforeAll(async () => {
    server = createServer((req, res) => {
      ranges.push(req.headers.range);
      const m = /bytes=(\d+)-/.exec(req.headers.range ?? "");
      const from = m ? Number(m[1]) : 0;
      res.writeHead(m ? 206 : 200, { "content-length": String(body.length - from) });
      if (req.url === "/slow") {
        // half now, the rest after the connect deadline has passed
        res.write(body.subarray(from, 1000));
        setTimeout(() => res.end(body.subarray(1000)), 400);
      } else res.end(body.subarray(from));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/f`;
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks only for the rest of a partial file and checks the whole", async () => {
    const path = join(dir, "f");
    writeFileSync(path, body.subarray(0, 1200));
    await downloadVerified(fetch, { url, size: body.length, sha256, source: "the list" }, path, () => undefined, undefined, undefined, { resume: true });
    expect(ranges.at(-1)).toBe("bytes=1200-");
    expect(readFileSync(path).equals(body)).toBe(true);
  });

  it("lets a download run past the connect deadline (it covers only the server's answer)", async () => {
    const path = join(dir, "slow");
    await downloadVerified(fetch, { url: url.replace(/\/f$/, "/slow"), size: body.length, sha256, source: "the list" }, path, () => undefined, undefined, undefined, { connectMs: 100 });
    expect(readFileSync(path).equals(body)).toBe(true);
  });

  it("keeps a complete earlier download without going online", async () => {
    const path = join(dir, "done");
    writeFileSync(path, body);
    const before = ranges.length;
    await downloadVerified(fetch, { url, size: body.length, sha256, source: "the list" }, path, () => undefined, undefined, undefined, { resume: true });
    expect(ranges.length).toBe(before);
    expect(readFileSync(path).equals(body)).toBe(true);
  });

  it("refuses a wrong checksum and keeps nothing", async () => {
    const path = join(dir, "g");
    await expect(downloadVerified(fetch, { url, size: body.length, sha256: "0".repeat(64), source: "the list" }, path, () => undefined, undefined, undefined, { resume: true })).rejects.toThrow(
      "refused: the download's SHA-256 doesn't match the list",
    );
    expect(existsSync(path)).toBe(false);
  });
});

describe("runInstall", () => {
  const files: Record<string, Buffer> = { "a.onnx": Buffer.from("A".repeat(300)), "b.onnx": Buffer.from("B".repeat(500)) };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  let server: Server;
  let base = "";
  const asked: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const name = (req.url ?? "").slice(1);
      asked.push(name);
      const body = files[name] ?? Buffer.alloc(0);
      res.writeHead(files[name] ? 200 : 404, { "content-length": String(body.length) });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());
  const catalog = (): Catalog => ({
    runtime: { name: "rt", wheels: [] },
    models: { name: "m1", files: Object.entries(files).map(([f, b]) => ({ file: f, url: `${base}/${f}`, size: b.length, sha256: sha(b) })) },
  });
  const deps = (free: number | null = null) => ({ fetch, progress: () => undefined, abort: new AbortController().signal, freeBytes: () => free });

  it("keeps the model files a stopped install already finished (fetches only the rest)", async () => {
    const data = mkdtempSync(join(tmpdir(), "ck-run-"));
    mkdirSync(join(data, "runtime", "rt"), { recursive: true });
    mkdirSync(join(data, "models", ".partial-m1"), { recursive: true });
    writeFileSync(join(data, "models", ".partial-m1", "a.onnx"), files["a.onnx"]);
    asked.length = 0;
    await runInstall(data, deps(), catalog());
    expect(asked).toEqual(["b.onnx"]);
    expect(readFileSync(join(data, "models", "m1", "a.onnx")).equals(files["a.onnx"])).toBe(true);
    expect(existsSync(join(data, "models", ".partial-m1"))).toBe(false);
    rmSync(data, { recursive: true, force: true });
  });

  it("installs a macOS runtime (a wheel whose only library is a .dylib)", async () => {
    const wheel = makeZip({ "onnxruntime/capi/libonnxruntime.1.31.0.dylib": "lib", "onnxruntime/LICENSE": "MIT" });
    files["ort-mac.whl"] = wheel;
    const data = mkdtempSync(join(tmpdir(), "ck-run-"));
    mkdirSync(join(data, "models", "m1"), { recursive: true });
    const mac: Catalog = { runtime: { name: "ort-coreml", wheels: [{ file: "ort-mac.whl", url: `${base}/ort-mac.whl`, size: wheel.length, sha256: sha(wheel) }] }, models: catalog().models };
    await runInstall(data, deps(), mac);
    expect(existsSync(join(data, "runtime", "ort-coreml", "onnxruntime", "capi", "libonnxruntime.1.31.0.dylib"))).toBe(true);
    delete files["ort-mac.whl"];
    rmSync(data, { recursive: true, force: true });
  });

  it("refuses up front when the disk can't hold it", async () => {
    const data = mkdtempSync(join(tmpdir(), "ck-run-"));
    mkdirSync(join(data, "runtime", "rt"), { recursive: true });
    await expect(runInstall(data, deps(100), catalog())).rejects.toThrow("not enough free disk space");
    rmSync(data, { recursive: true, force: true });
  });

  // TensorRT on top of an installed runtime ("rt") and model set ("m1", whose a.onnx doubles as a TensorRT file)
  const trtCatalog = (): TrtCatalog => {
    const serve = (name: string, body: Buffer) => {
      files[name] = body;
      return { file: name, url: `${base}/${name}`, size: body.length, sha256: sha(body) };
    };
    const trtWheel = makeZip({
      "tensorrt_libs/__init__.py": "",
      "tensorrt_libs/libnvinfer.so.10": "nvinfer",
      "tensorrt_libs/libnvonnxparser.so.10": "parser",
      "tensorrt_libs/libnvinfer_builder_resource_sm120.so.10.16.1": "sm120",
      "tensorrt_libs/libnvinfer_builder_resource_win_sm120.so.10.16.1": "windows only",
      "tensorrt_cu13_libs-10.16.1.11.dist-info/LICENSE.txt": "NVIDIA",
      "tensorrt_cu13_libs-10.16.1.11.dist-info/RECORD": "",
    });
    const ortWheel = makeZip({ "onnxruntime/capi/libonnxruntime.so.1.31.0": "ort", "onnxruntime/capi/libonnxruntime_providers_tensorrt.so": "trt provider" });
    const list = Buffer.from(JSON.stringify({ "tensorrt-fp16": { rvm: "rvm-trt.onnx", stage2: "a-trt.onnx" }, "tensorrt-fp16-ctx": { rvm: "rvm-trt-ctx.onnx" } }));
    return {
      runtime: { name: "rt", wheels: [serve("onnxruntime_gpu-1.31.0-x.whl", ortWheel)] },
      models: catalog().models,
      libs: { ...serve("trt.whl", trtWheel), label: "NVIDIA TensorRT" },
      trtModels: {
        name: "m1-trt",
        files: [
          serve("rvm-trt.onnx", Buffer.from("R".repeat(40))),
          serve("rvm-trt-ctx.onnx", Buffer.from("ctx")),
          // the same bytes as the set's a.onnx: copied, never downloaded
          { ...serve("a-trt.onnx", files["a.onnx"]) },
          serve("models.json", list),
        ],
      },
    };
  };
  const installedBase = () => {
    const data = mkdtempSync(join(tmpdir(), "ck-trt-"));
    mkdirSync(join(data, "runtime", "rt", "onnxruntime", "capi"), { recursive: true });
    writeFileSync(join(data, "runtime", "rt", "onnxruntime", "capi", "libonnxruntime.so.1.31.0"), "ort");
    mkdirSync(join(data, "models", "m1"), { recursive: true });
    writeFileSync(join(data, "models", "m1", "a.onnx"), files["a.onnx"]);
    writeFileSync(join(data, "models", "m1", "models.json"), JSON.stringify({ fp16: { stage2: "a.onnx" } }));
    return data;
  };

  it("installs TensorRT's parts where the engine looks, copying what the model set already has", async () => {
    const c = trtCatalog();
    const data = installedBase();
    const need = trtNeeds(data, existsSync, c);
    // the copied file isn't counted as a download
    expect(need).toEqual({ libs: true, provider: true, models: true, bytes: c.libs.size + c.runtime.wheels[0].size + 40 + 3 + c.trtModels.files[3].size });
    asked.length = 0;
    await runTrtInstall(data, deps(), c);
    expect(asked).toEqual(["trt.whl", "onnxruntime_gpu-1.31.0-x.whl", "rvm-trt.onnx", "rvm-trt-ctx.onnx", "models.json"]);
    const rt = join(data, "runtime", "rt");
    expect(readdirSync(join(rt, "tensorrt_libs")).sort()).toEqual(["libnvinfer.so.10", "libnvinfer_builder_resource_sm120.so.10.16.1", "libnvonnxparser.so.10"]);
    expect(readdirSync(join(rt, "tensorrt_cu13_libs-10.16.1.11.dist-info"))).toEqual(["LICENSE.txt"]);
    expect(readFileSync(join(rt, "onnxruntime", "capi", "libonnxruntime_providers_tensorrt.so"), "utf8")).toBe("trt provider");
    const m1 = join(data, "models", "m1");
    expect(readFileSync(join(m1, "a-trt.onnx")).equals(files["a.onnx"])).toBe(true);
    // the engine reads one models.json: the set's keys and TensorRT's, merged
    expect(JSON.parse(readFileSync(join(m1, "models.json"), "utf8"))).toEqual({
      fp16: { stage2: "a.onnx" },
      "tensorrt-fp16": { rvm: "rvm-trt.onnx", stage2: "a-trt.onnx" },
      "tensorrt-fp16-ctx": { rvm: "rvm-trt-ctx.onnx" },
    });
    expect(existsSync(join(m1, "models-tensorrt.json"))).toBe(true);
    expect(readdirSync(join(data, "models")).sort()).toEqual(["m1"]);
    expect(existsSync(join(data, "downloads"))).toBe(false);
    expect(trtNeeds(data, existsSync, c)).toMatchObject({ libs: false, provider: false, models: false });
    expect(trtReady(join(rt, "onnxruntime", "capi", "libonnxruntime.so.1.31.0"), m1)).toBe(true);

    // removing takes exactly TensorRT's files and keys; the provider stays with its runtime
    removeTensorrt(data, c);
    expect(JSON.parse(readFileSync(join(m1, "models.json"), "utf8"))).toEqual({ fp16: { stage2: "a.onnx" } });
    expect(readdirSync(m1).sort()).toEqual(["a.onnx", "models.json"]);
    expect(readdirSync(rt).sort()).toEqual(["onnxruntime"]);
    expect(existsSync(join(rt, "onnxruntime", "capi", "libonnxruntime_providers_tensorrt.so"))).toBe(true);
    expect(trtNeeds(data, existsSync, c)).toMatchObject({ libs: true, provider: false, models: true });
    rmSync(data, { recursive: true, force: true });
  });

  it("downloads no ONNX Runtime wheel when the runtime already has the TensorRT provider (installed since 1.0)", async () => {
    const c = trtCatalog();
    const data = installedBase();
    writeFileSync(join(data, "runtime", "rt", "onnxruntime", "capi", "libonnxruntime_providers_tensorrt.so"), "kept by the runtime install");
    asked.length = 0;
    await runTrtInstall(data, deps(), c);
    expect(asked).not.toContain("onnxruntime_gpu-1.31.0-x.whl");
    rmSync(data, { recursive: true, force: true });
  });

  it("resumes a TensorRT install whose model files were already moved into the set (a crash before the last step)", async () => {
    const c = trtCatalog();
    const data = installedBase();
    await runTrtInstall(data, deps(), c);
    const m1 = join(data, "models", "m1");
    // as if it stopped after the moves: no list yet, the models.json without TensorRT's keys
    rmSync(join(m1, "models-tensorrt.json"));
    writeFileSync(join(m1, "models.json"), JSON.stringify({ fp16: { stage2: "a.onnx" } }));
    asked.length = 0;
    await runTrtInstall(data, deps(), c);
    expect(asked).toEqual(["models.json"]);
    expect(JSON.parse(readFileSync(join(m1, "models.json"), "utf8"))).toHaveProperty("tensorrt-fp16");
    rmSync(data, { recursive: true, force: true });
  });

  it("asks for the runtime and models first", async () => {
    const data = mkdtempSync(join(tmpdir(), "ck-trt-"));
    await expect(runTrtInstall(data, deps(), trtCatalog())).rejects.toThrow("install the GPU runtime and the CorridorKey models first");
    rmSync(data, { recursive: true, force: true });
  });
});

describe("TensorRT catalogue and rules", () => {
  it("pins NVIDIA's wheel and the TensorRT model release by URL, size and SHA-256", () => {
    expect(TENSORRT.libs.url).toBe(`https://pypi.nvidia.com/tensorrt-cu13-libs/${TENSORRT.libs.file}`);
    expect([TENSORRT.libs.size, TENSORRT.libs.sha256]).toEqual([3728705565, "91142c8ab3c58bed213cf1a563a6eb4e4f0ac529d05b5f909073acece0e3b712"]);
    expect(TENSORRT.models.files).toHaveLength(16);
    for (const f of TENSORRT.models.files) {
      expect(f.url).toBe(`https://github.com/MarcelineVPQ/corridorkey-desktop/releases/download/models-2.0.0-onnx.3-trt/${f.file}`);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // the list goes last: its arrival is the mark that the set is whole
    expect(TENSORRT.models.files.at(-1)?.file).toBe("models.json");
    // C-RADIO's TensorRT weights are the normal set's bytes: copied, not downloaded (1.72 GB less)
    const cradio = TENSORRT.models.files.find((f) => f.file === "ck2-cradio-trt-fp16.onnx.data")!;
    expect(MODELS.files.find((f) => f.file === "ck2-cradio-fp16.onnx.data")).toMatchObject({ size: cradio.size, sha256: cradio.sha256 });
    // loop: NOT-WORTH — sixteen sizes
    const models = TENSORRT.models.files.reduce((n, f) => n + f.size, 0);
    expect(TRT_BYTES).toBe(TENSORRT.libs.size + models - cradio.size);
    expect(TRT_BYTES).toBe(6866685908);
  });

  it("builds the shipped ck-trt-build against the same TensorRT wheel users download", () => {
    const script = readFileSync(new URL("../../tools/build_trt_builder.sh", import.meta.url), "utf8");
    expect(script).toContain(`WHEEL=${TENSORRT.libs.file}\n`);
    expect(script).toContain(`SHA256=${TENSORRT.libs.sha256}\n`);
    expect(TENSORRT.libs.url).toBe(`https://pypi.nvidia.com/tensorrt-cu13-libs/${TENSORRT.libs.file}`);
  });

  it("keeps the libraries the builder and ONNX Runtime's provider load, for Linux cards, and the licence", () => {
    for (const keep of [
      "tensorrt_libs/libnvinfer.so.10",
      "tensorrt_libs/libnvinfer_plugin.so.10",
      "tensorrt_libs/libnvonnxparser.so.10",
      "tensorrt_libs/libnvinfer_builder_resource_sm75.so.10.16.1",
      "tensorrt_libs/libnvinfer_builder_resource_sm120.so.10.16.1",
      "tensorrt_libs/libnvinfer_builder_resource_ptx.so.10.16.1",
      "tensorrt_cu13_libs-10.16.1.11.dist-info/LICENSE.txt",
    ])
      expect(keepTensorrt(keep)).toBe(true);
    for (const drop of [
      "tensorrt_libs/__init__.py",
      "tensorrt_libs/libnvinfer_builder_resource_win_sm120.so.10.16.1",
      "tensorrt_libs/libnvinfer_builder_resource_win_ptx.so.10.16.1",
      "tensorrt_cu13_libs-10.16.1.11.dist-info/RECORD",
      "../tensorrt_libs/libnvinfer.so.10",
    ])
      expect(keepTensorrt(drop)).toBe(false);
  });

  it("asks the engine for TensorRT only on Linux, with the setting on, the Rust engine and the parts installed", () => {
    const yes = { platform: "linux" as const, setting: true, engine: "rust" as const, ready: true };
    expect(useTensorrt(yes)).toBe(true);
    expect(useTensorrt({ ...yes, ready: false })).toBe(false);
    expect(useTensorrt({ ...yes, setting: false })).toBe(false);
    expect(useTensorrt({ ...yes, engine: "python" })).toBe(false);
    expect(useTensorrt({ ...yes, platform: "win32" })).toBe(false);
    expect(useTensorrt({ ...yes, platform: "darwin" })).toBe(false);
    expect([trtSupported("linux"), trtSupported("win32"), trtSupported("darwin")]).toEqual([true, false, false]);
  });

  it("is ready only when the engine's own files have all three parts", () => {
    const ort = "/d/runtime/rt/onnxruntime/capi/libonnxruntime.so.1.31.0";
    const all = ["/d/runtime/rt/onnxruntime/capi/libonnxruntime_providers_tensorrt.so", "/d/runtime/rt/tensorrt_libs", "/d/models/m1/models-tensorrt.json"];
    const has = (p: string[]) => (x: string) => p.includes(x);
    expect(trtReady(ort, "/d/models/m1", has(all))).toBe(true);
    // loop: NOT-WORTH — three cases
    for (const missing of all) expect(trtReady(ort, "/d/models/m1", has(all.filter((x) => x !== missing)))).toBe(false);
    expect(trtReady(null, "/d/models/m1", has(all))).toBe(false);
  });
});

describe("each system's runtime and graphics check", () => {
  it("downloads Core ML's ONNX Runtime on macOS, CUDA's elsewhere", () => {
    expect(runtimeFor("darwin")).toBe(RUNTIME_MAC);
    expect(runtimeFor("win32")).toBe(RUNTIME_WIN);
    expect(runtimeFor("linux")).toBe(RUNTIME);
    expect(RUNTIME_MAC.wheels.map((w) => w.file)).toEqual(["onnxruntime-1.31.0-cp312-cp312-macosx_14_0_arm64.whl"]);
  });
  it("keeps the macOS library and ONNX Runtime's licence files", () => {
    expect(keepFromWheel("onnxruntime/capi/libonnxruntime.1.31.0.dylib")).toBe(true);
    expect(keepFromWheel("onnxruntime/capi/onnxruntime_pybind11_state.so")).toBe(false);
    expect(keepFromWheel("onnxruntime/LICENSE")).toBe(true);
    expect(keepFromWheel("onnxruntime/ThirdPartyNotices.txt")).toBe(true);
  });
  it("runs on Apple Silicon Macs and says why not on Intel ones", () => {
    const none = () => false;
    expect(systemSupport("darwin", "arm64", none, {})).toMatchObject({ ok: true, problem: null });
    expect(systemSupport("darwin", "arm64", none, {}).runtime).toContain("Core ML");
    const intel = systemSupport("darwin", "x64", none, {});
    expect(intel.ok).toBe(false);
    expect(intel.problem).toContain("Apple Silicon");
  });
  it("needs the NVIDIA driver on Linux and Windows", () => {
    expect(systemSupport("linux", "x64", (p) => p === "/proc/driver/nvidia/version", {}).ok).toBe(true);
    expect(systemSupport("linux", "x64", () => false, {})).toMatchObject({ ok: false });
    expect(systemSupport("win32", "x64", (p) => p.endsWith("nvml.dll"), { SystemRoot: "C:\\Windows" }).ok).toBe(true);
    expect(systemSupport("win32", "x64", () => false, {}).problem).toContain("NVIDIA");
  });
});
