import { describe, expect, it } from "vitest";
import { checkRustEngine, chooseEngine, loadSettings } from "../../electron/main/settings";

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

  it("prefers the Rust engine, falls back to the PyTorch checkout", () => {
    const ok = { ok: true, problems: [] };
    const no = { ok: false, problems: ["x"] };
    expect(chooseEngine(ok, ok)).toBe("rust");
    expect(chooseEngine(no, ok)).toBe("python");
    expect(chooseEngine(no, no)).toBeNull();
  });

  it("never loads the CK_ENGINE_* overrides into the saved settings (they'd stick after the variable is gone)", () => {
    const s = loadSettings("/nonexistent/settings.json", { CK_ENGINE_BIN: "/e/b", CK_ENGINE_MODELS: "/m" });
    expect([s.engineBinary, s.modelsDir, s.ortLibrary]).toEqual([null, null, null]);
  });
});
