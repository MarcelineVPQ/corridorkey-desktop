import { describe, expect, it } from "vitest";
import { checkAll, checkBugForm, checkDeviceLists, checkFormat, checkProtocol, comboNames, enumNames, screenNames } from "../../tools/check_providers.mjs";

const RS = `impl Provider { fn name(&self) { match self { Provider::Cuda => "cuda", Provider::CoreMl => "coreml", } } }`;
const FORMAT = `const names: Record<string, string> = { cuda: "CUDA", "tensorrt+cuda": "TensorRT + CUDA" };`;
const FORM = "  - type: dropdown\n    id: engine\n    attributes:\n      label: Engine\n      options:\n        - CUDA (the default)\n";

describe("the provider gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads the engine's names", () => {
    expect(enumNames(RS, "Provider")).toEqual(["cuda", "coreml"]);
    expect(comboNames(`"provider": if a { "tensorrt" } else { "tensorrt+cuda" }`)).toEqual(["tensorrt+cuda"]);
    expect(screenNames(FORMAT)).toEqual({ cuda: "CUDA", "tensorrt+cuda": "TensorRT + CUDA" });
  });

  it("(a) a provider without a screen name fails", () => {
    expect(checkFormat(FORMAT, ["cuda", "tensorrt+cuda"])).toEqual([]);
    expect(checkFormat(FORMAT, ["cuda", "coreml"])).toEqual([expect.stringContaining('"coreml"')]);
  });

  it("(b) the protocol doc's provider list missing one fails (the old line had no coreml)", () => {
    const old = `← {"type":"provider","id":"j1","provider":"cuda|tensorrt|tensorrt+cuda|cpu","precision":"fp16"}`;
    expect(checkProtocol(old, ["cuda", "coreml"])).toEqual([expect.stringContaining('"coreml"')]);
    expect(checkProtocol(old.replace("|cpu", "|cpu|coreml"), ["cuda", "coreml"])).toEqual([]);
  });

  it("(c) a device list missing a device fails; other knobs' auto lists don't count", () => {
    const devices = ["auto", "cuda", "cpu", "coreml"];
    expect(checkDeviceLists("ENGINE_RUST.md", "x [--device auto|cuda|cpu]\n`CK_ENGINE_DEVICE` (auto | cuda | cpu, = x)", devices)).toEqual([
      expect.stringContaining("ENGINE_RUST.md:1:"),
      expect.stringContaining("ENGINE_RUST.md:2:"),
    ]);
    expect(checkDeviceLists("CLI.md", "| `--device auto\\|cuda\\|cpu\\|coreml` |", devices)).toEqual([]);
    expect(checkDeviceLists("x.md", "CK_ENGINE_ARENA_SHRINK (auto | on | off)", devices)).toEqual([]);
  });

  it("(d) the bug form without an option naming a provider fails; combined providers are skipped", () => {
    const names = { cuda: "CUDA", coreml: "Core ML", "tensorrt+cuda": "TensorRT + CUDA" };
    expect(checkBugForm(FORM, names, ["cuda", "tensorrt+cuda"])).toEqual([]);
    expect(checkBugForm(FORM, names, ["cuda", "coreml"])).toEqual([expect.stringContaining("Core ML")]);
    expect(checkBugForm("id: os\n", names, ["cuda"])).toEqual([expect.stringContaining("no Engine dropdown")]);
  });
});
