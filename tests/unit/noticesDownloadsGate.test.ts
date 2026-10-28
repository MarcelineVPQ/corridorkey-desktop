// The notices gate (tools/check_notices_downloads.mjs) on fixture trees: a model set or wheel install.ts pins that
// THIRD_PARTY_NOTICES.md doesn't name fails it (audit 2026-10-27 row 4: the Core ML set was missing), and the real
// tree passes.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const gate = join(repo, "tools/check_notices_downloads.mjs");
const scratch = mkdtempSync(join(tmpdir(), "ck-notices-gate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const wheel = (file: string) => `  wheels: [{ file: "${file}", url: "", size: 1, sha256: "" }],`;
const INSTALL = [
  'const MODEL_SET = "2.0.0-onnx.5";',
  "const model = inRelease(MODEL_SET);",
  'const OLD_MODEL_SET = "2.0.0-onnx.4";',
  "const oldModel = inRelease(OLD_MODEL_SET);",
  "const COREML_SET = `${MODEL_SET}-coreml`;",
  "const coremlModel = inRelease(COREML_SET);",
  "export const RUNTIME = {",
  wheel("onnxruntime_gpu-1.23.2-cp312-cp312-manylinux_2_27_x86_64.whl"),
  "};",
  "export const RUNTIME_WIN = {",
  wheel("onnxruntime_gpu-1.23.2-cp312-cp312-win_amd64.whl"),
  "};",
  "export const RUNTIME_MAC = {",
  wheel("onnxruntime-1.23.2-cp312-cp312-macosx_13_0_universal2.whl"),
  "};",
  "export const TENSORRT = {",
  '  libs: { file: "tensorrt_cu13_libs-10.16.1.11-py2.py3-none-manylinux_2_28_x86_64.whl" } as Download,',
  "};",
  'const TRT_MODEL_SET = "2.0.0-onnx.5-trt";',
  "const trtModel = inRelease(TRT_MODEL_SET);",
].join("\n");
const NOTICES = [
  "| onnxruntime | 1.23.2 | macOS | MIT |",
  "| onnxruntime-gpu | 1.23.2 | Linux, Windows | MIT |",
  "| tensorrt-cu13-libs | 10.16.1.11 | Linux, opt-in TensorRT | NVIDIA |",
  "- `2.0.0-onnx.5` (Linux, Windows, macOS)",
  "- `2.0.0-onnx.4` (Linux: TensorRT copies its C-RADIO weights from an installed copy)",
  "- `2.0.0-onnx.5-coreml` (macOS: Core ML)",
  "- `2.0.0-onnx.5-trt` (Linux: the opt-in TensorRT jobs)",
].join("\n");

let n = 0;
function runGate(install: string, notices: string): { code: number | null; out: string } {
  const root = join(scratch, String(n++));
  mkdirSync(join(root, "electron/main"), { recursive: true });
  writeFileSync(join(root, "electron/main/install.ts"), install);
  writeFileSync(join(root, "THIRD_PARTY_NOTICES.md"), notices);
  // loop: NOT-WORTH — one small fixture tree, 10 s deadline
  const r = spawnSync(process.execPath, [gate, root], { encoding: "utf8", timeout: 10_000 });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe("notices gate (first-run downloads)", () => {
  it("passes on the real tree", () => {
    // loop: NOT-WORTH — two file reads, 30 s deadline
    const r = spawnSync(process.execPath, [gate], { cwd: repo, encoding: "utf8", timeout: 30_000 });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("passes when every set and wheel is named", () => {
    const r = runGate(INSTALL, NOTICES);
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  it("fails on a model set the notices don't name, the derived Core ML one and the Mac's own set too", () => {
    const r = runGate(INSTALL, NOTICES.replace("- `2.0.0-onnx.5-coreml` (macOS: Core ML)\n", ""));
    expect(r.code).toBe(1);
    expect(r.out).toContain("model set 2.0.0-onnx.5-coreml");
    expect(runGate(INSTALL, NOTICES.replace("- `2.0.0-onnx.4` (Linux: TensorRT copies its C-RADIO weights from an installed copy)\n", "")).out).toContain("model set 2.0.0-onnx.4\n");
    expect(runGate(INSTALL, NOTICES.replace("`2.0.0-onnx.5-trt`", "2.0.0-onnx.5-trt")).code).toBe(1);
  });

  it("fails on a wheel missing or at another version", () => {
    const r = runGate(INSTALL, NOTICES.replace("| tensorrt-cu13-libs | 10.16.1.11 |", "| tensorrt-cu13-libs | 10.15.0 |"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("wheel tensorrt-cu13-libs 10.16.1.11");
    expect(runGate(INSTALL, NOTICES.replace("| onnxruntime | 1.23.2 | macOS | MIT |\n", "")).out).toContain("wheel onnxruntime 1.23.2");
  });

  it("fails on a model release pinned past the set constants", () => {
    const r = runGate(INSTALL + '\nconst x = inRelease("2.0.0-onnx.6");', NOTICES);
    expect(r.code).toBe(1);
    expect(r.out).toContain("inRelease");
  });
});
