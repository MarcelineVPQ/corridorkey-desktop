import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadVerified } from "../../electron/main/download";
import { installNeeds, keepFromWheel, MODELS, RUNTIME, runInstall, type Catalog } from "../../electron/main/install";
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
    expect(keepFromWheel("onnxruntime/capi/libonnxruntime_providers_tensorrt.so")).toBe(false);
    expect(keepFromWheel("onnxruntime/capi/onnxruntime_pybind11_state.cpython-312-x86_64-linux-gnu.so")).toBe(false);
    expect(keepFromWheel("nvidia/cu13/lib/libcublasLt.so.13")).toBe(true);
    expect(keepFromWheel("nvidia/cudnn/include/cudnn.h")).toBe(false);
    expect(keepFromWheel("nvidia_cudnn_cu13-9.27.0.42.dist-info/licenses/License.txt")).toBe(true);
    // Windows wheels
    expect(keepFromWheel("onnxruntime/capi/onnxruntime.dll")).toBe(true);
    expect(keepFromWheel("onnxruntime/capi/onnxruntime_providers_tensorrt.dll")).toBe(false);
    expect(keepFromWheel("nvidia/cu13/bin/x86_64/cublasLt64_13.dll")).toBe(true);
    expect(keepFromWheel("nvidia/cudnn/bin/cudnn64_9.dll")).toBe(true);
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
    expect(installNeeds("/d", has([])).bytes).toBe(RUNTIME.wheels.reduce((n, w) => n + w.size, 0) + MODELS.files.reduce((n, f) => n + f.size, 0));
    expect(installNeeds("/d", has([`/d/runtime/${RUNTIME.name}`, `/d/models/${MODELS.name}`]))).toEqual({ runtime: false, models: false, bytes: 0 });
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

  it("refuses up front when the disk can't hold it", async () => {
    const data = mkdtempSync(join(tmpdir(), "ck-run-"));
    mkdirSync(join(data, "runtime", "rt"), { recursive: true });
    await expect(runInstall(data, deps(100), catalog())).rejects.toThrow("not enough free disk space");
    rmSync(data, { recursive: true, force: true });
  });
});
