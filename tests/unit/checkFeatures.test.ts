import { describe, expect, it } from "vitest";
import { checkAll, checkFeatures, lintSets, shippedSets } from "../../tools/check_features.mjs";

const BUILD = [
  "cargo build --release -p ck-engine --no-default-features --features ort-dynamic,ocio --target aarch64-apple-darwin",
  "cargo build --release -p ck-engine --no-default-features --features ort-dynamic,cuda,tensorrt,ocio --target x86_64-pc-windows-gnu",
  "  env PATH=x cargo zigbuild --release --no-default-features --features ort-dynamic,cuda,tensorrt,ocio \\",
  '  --target "x86_64-unknown-linux-gnu.$GLIBC"',
].join("\n");
const ALL = ["ort-dynamic", "cuda", "tensorrt", "ocio"];
const TARGETS = ["x86_64-unknown-linux-gnu", "x86_64-pc-windows-gnu", "aarch64-apple-darwin"];
const EXC = new Map([["aarch64-apple-darwin ocio", "no Apple SDK"]]);

describe("the feature-set gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads the shipped builds (continued lines too) and the lint lines", () => {
    expect(shippedSets(BUILD)).toEqual([
      { target: "aarch64-apple-darwin", features: ["ort-dynamic", "ocio"] },
      { target: "x86_64-pc-windows-gnu", features: ALL },
      { target: "x86_64-unknown-linux-gnu", features: ALL },
    ]);
    expect(lintSets('lint x86_64-pc-windows-gnu ort-dynamic,cuda\nlint aarch64-apple-darwin ort-dynamic CXX="a b"\n')).toEqual([
      { target: "x86_64-pc-windows-gnu", features: ["ort-dynamic", "cuda"] },
      { target: "aarch64-apple-darwin", features: ["ort-dynamic"] },
    ]);
  });

  it("(a) the Linux release set never linted (check_targets.sh before 2026-10-27) fails", () => {
    const shipped = shippedSets(BUILD);
    const linted = lintSets(`lint x86_64-pc-windows-gnu ${ALL.join(",")}\nlint aarch64-apple-darwin ort-dynamic\n`);
    expect(checkFeatures(shipped, linted, ALL, TARGETS, EXC)).toEqual([expect.stringContaining("no lint line for x86_64-unknown-linux-gnu")]);
    const all = lintSets(`lint x86_64-unknown-linux-gnu ${ALL.join(",")}\n`).concat(linted);
    expect(checkFeatures(shipped, all, ALL, TARGETS, EXC)).toEqual([]);
    expect(checkFeatures(shipped, all, ALL, TARGETS, new Map())).toEqual([expect.stringContaining('aarch64-apple-darwin is linted without "ocio"')]);
    expect(checkFeatures(shipped, [...all, { target: "riscv64gc-unknown-linux-gnu", features: [] }], ALL, TARGETS, EXC)).toEqual([expect.stringContaining("which nothing ships")]);
  });

  it("(b), (c) the notices' features and targets must be what ships", () => {
    const shipped = shippedSets(BUILD);
    const linted = shipped.map((s) => ({ ...s }));
    expect(checkFeatures(shipped, linted, ["ort-dynamic", "cuda", "tensorrt"], TARGETS, new Map())).toEqual([expect.stringContaining("ENGINE_FEATURES is ort-dynamic,cuda,tensorrt")]);
    expect(checkFeatures(shipped, linted, ALL, TARGETS.slice(0, 2), new Map())).toEqual([expect.stringContaining("engine-rs/about.toml")]);
    expect(checkFeatures(shipped, linted, ALL, TARGETS, EXC)).toEqual([expect.stringContaining("isn't needed any more")]);
  });
});
