import { describe, expect, it } from "vitest";
import { checkAll, checkKnobs, knobs } from "../../tools/check_knobs.mjs";

describe("the engine knob gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads Rust's quoted names, and every name elsewhere", () => {
    expect(knobs('var("CK_ENGINE_THREADS"); // CK_ENGINE_OLD', true)).toEqual(["CK_ENGINE_THREADS"]);
    expect(knobs("out.CK_ENGINE_PARENT_PID = x; env.CK_ENGINE_BIN")).toEqual(["CK_ENGINE_PARENT_PID", "CK_ENGINE_BIN"]);
  });

  it("an undocumented knob fails (CK_ENGINE_PARENT_PID before 2026-10-27); so does a documented one nothing reads", () => {
    const doc = "Knobs: `CK_ENGINE_THREADS`; the app: `CK_ENGINE_BIN`.";
    expect(checkKnobs(["CK_ENGINE_THREADS"], ["CK_ENGINE_BIN"], doc)).toEqual([]);
    expect(checkKnobs(["CK_ENGINE_THREADS", "CK_ENGINE_PARENT_PID"], ["CK_ENGINE_BIN", "CK_ENGINE_PARENT_PID"], doc)).toEqual([
      expect.stringContaining("CK_ENGINE_PARENT_PID (the engine reads it) isn't in"),
    ]);
    expect(checkKnobs(["CK_ENGINE_THREADS"], [], doc)).toEqual([expect.stringContaining("names CK_ENGINE_BIN, which nothing reads")]);
  });
});
