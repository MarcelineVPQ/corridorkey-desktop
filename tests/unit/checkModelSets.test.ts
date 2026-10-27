import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP, checkRelease, pinnedSets } from "../../tools/check_model_sets.mjs";

const H = (c: string) => c.repeat(64);
const LICENCES = [
  { name: "LICENSE", size: 26650 },
  { name: "NOTICE", size: 228 },
  { name: "ATTRIBUTION.md", size: 3478 },
  { name: "LICENSE-MIT-MoGe.txt", size: 12500 },
];

describe("the model-set gate (online at release; these checks are offline)", () => {
  it("reads this repository's pinned sets and what each derives from", () => {
    const sets = pinnedSets(readFileSync(join(APP, "electron/main/install.ts"), "utf8"));
    expect(sets.map((s) => [s.set, s.base])).toEqual([
      ["2.0.0-onnx.4", null],
      ["2.0.0-onnx.4-coreml", "2.0.0-onnx.4"],
      ["2.0.0-onnx.4-trt", "2.0.0-onnx.4"],
    ]);
    expect(sets.every((s) => s.files.length > 0)).toBe(true);
  });

  it("(a) a pinned file missing, at another size or with another SHA-256 fails", () => {
    const s = { set: "x", base: null, files: [{ file: "a.onnx", size: 10, sha256: H("a") }] };
    expect(checkRelease(s, [{ name: "a.onnx", size: 10, digest: `sha256:${H("a")}` }, ...LICENCES], null)).toEqual([]);
    expect(checkRelease(s, LICENCES, null)).toEqual([expect.stringContaining("not in the release")]);
    expect(checkRelease(s, [{ name: "a.onnx", size: 11, digest: null }, ...LICENCES], null)).toEqual([expect.stringContaining("11 bytes, pinned 10")]);
    expect(checkRelease(s, [{ name: "a.onnx", size: 10, digest: `sha256:${H("b")}` }, ...LICENCES], null)).toEqual([expect.stringContaining("isn't the pin's")]);
  });

  it("(b) a base release without its licence files fails; (c) the Core ML release as first uploaded (none) fails", () => {
    const base = { set: "2.0.0-onnx.4", base: null, files: [] };
    expect(checkRelease(base, [{ name: "LICENSE", size: 1 }], null)).toEqual([expect.stringContaining("no NOTICE"), expect.stringContaining("no ATTRIBUTION.md")]);
    const coreml = { set: "2.0.0-onnx.4-coreml", base: "2.0.0-onnx.4", files: [{ file: "coreml.json", size: 458, sha256: H("c") }] };
    const json = { name: "coreml.json", size: 458, digest: `sha256:${H("c")}` };
    expect(checkRelease(coreml, [json], LICENCES)).toHaveLength(4);
    expect(checkRelease(coreml, [json, ...LICENCES], LICENCES)).toEqual([]);
    expect(checkRelease(coreml, [json, ...LICENCES.slice(1), { name: "LICENSE", size: 5 }], LICENCES)).toEqual([expect.stringContaining("LICENSE is 5 bytes")]);
  });
});
