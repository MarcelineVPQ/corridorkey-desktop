import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRustEngine, loadSettings } from "../../electron/main/settings";

const files = (list: string[]) => {
  const set = new Set(list);
  return { exists: (p: string) => set.has(p), list: (d: string) => list.filter((f) => f.startsWith(`${d}/`)).map((f) => f.slice(d.length + 1)) };
};

describe("Rust engine setup", () => {
  const five = ["cradio", "moge", "rvm", "stage1", "stage2"].map((p) => `/m/${p}_fp16.onnx`);

  it("is set up with the program and all five networks", () => {
    const f = files(["/e/corridorkey-engine", "/m", ...five]);
    expect(checkRustEngine("/e/corridorkey-engine", "/m", null, f.exists, f.list)).toEqual({ ok: true, problems: [] });
  });

  it("says what is missing", () => {
    const f = files(["/m", "/m/stage1_op23fp16.onnx", "/m/stage2.onnx"]);
    const c = checkRustEngine("/e/corridorkey-engine", "/m", null, f.exists, f.list);
    expect(c.ok).toBe(false);
    expect(c.problems).toEqual(["Missing /e/corridorkey-engine: the engine program.", "The models folder has no cradio, moge, rvm networks."]);
    expect(checkRustEngine(null, null).problems).toHaveLength(2);
  });

  it("says when ONNX Runtime's library is gone (not only at Start)", () => {
    const f = files(["/e/b", "/m", "/m/models.json"]);
    expect(checkRustEngine("/e/b", "/m", "/r/libonnxruntime.so.1.31.0", f.exists, f.list).problems).toEqual(["Missing /r/libonnxruntime.so.1.31.0: ONNX Runtime's library."]);
  });

  it("trusts a models.json manifest (the engine checks its files)", () => {
    const f = files(["/e/b", "/m", "/m/models.json"]);
    expect(checkRustEngine("/e/b", "/m", null, f.exists, f.list).ok).toBe(true);
  });

  it("keeps TensorRT off unless the file says true", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-settings-"));
    const f = join(dir, "settings.json");
    expect(loadSettings(f).tensorrt).toBe(false);
    writeFileSync(f, JSON.stringify({ tensorrt: "yes" }));
    expect(loadSettings(f).tensorrt).toBe(false);
    writeFileSync(f, JSON.stringify({ tensorrt: true }));
    expect(loadSettings(f).tensorrt).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads a settings file that still names the removed PyTorch engine's checkout, and drops the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-settings-"));
    try {
      const f = join(dir, "settings.json");
      writeFileSync(f, JSON.stringify({ corridorKeyRoot: "/ck", outputRoot: "/out", tensorrt: true }));
      const s = loadSettings(f);
      expect(s).toMatchObject({ outputRoot: "/out", tensorrt: true });
      expect(s).not.toHaveProperty("corridorKeyRoot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
