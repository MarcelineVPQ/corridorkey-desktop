// Frame sequences as a TD reads a folder (src/shared/console/sequences.ts): lsseq-style grouping for dir and Tab.
import { describe, expect, it } from "vitest";
import { frameRanges, groupSequences } from "../../src/shared/console/sequences";

const frames = (pre: string, from: number, to: number, ext = ".exr", pad = 4) => Array.from({ length: to - from + 1 }, (_, i) => `${pre}${String(from + i).padStart(pad, "0")}${ext}`);

describe("frameRanges", () => {
  it("writes runs as ranges, single frames alone", () => {
    expect(frameRanges([1001, 1002, 1003, 1005, 1007, 1008])).toBe("1001-1003, 1005, 1007-1008");
    expect(frameRanges([7])).toBe("7");
    expect(frameRanges([])).toBe("");
  });
});

describe("groupSequences (SME review S1, M4)", () => {
  it("groups numbered files into one pattern per sequence, padding from the names, gaps shown", () => {
    const names = [...frames("sh010_plate.", 1001, 1100).filter((n) => !/\.(1047|1050|1051|1052)\./.test(n)), "notes.txt", "sh010_plate.mov"];
    const { sequences, singles } = groupSequences(names);
    expect(singles).toEqual(["notes.txt", "sh010_plate.mov"]);
    expect(sequences).toHaveLength(1);
    const s = sequences[0];
    expect([s.pattern, s.range, s.count, s.missing]).toEqual(["sh010_plate.####.exr", "1001-1100", 96, "1047, 1050-1052"]);
    expect(s.names).toHaveLength(96);
  });

  it("keeps different paddings, prefixes and extensions apart; one numbered file is a single file", () => {
    const { sequences, singles } = groupSequences(["a.0001.exr", "a.0002.exr", "a.01.exr", "a.02.exr", "b_001.png", "b_002.png", "c.1001.exr", "plate 9.exr", "plate 10.exr"]);
    expect(sequences.map((s) => [s.pattern, s.range])).toEqual([
      ["a.####.exr", "1-2"],
      ["a.##.exr", "1-2"],
      ["b_###.png", "1-2"],
    ]);
    expect(singles).toEqual(["c.1001.exr", "plate 9.exr", "plate 10.exr"]);
  });

  it("never groups videos (shot01.mov and shot02.mov are two clips, not a pattern the CLI reads)", () => {
    expect(groupSequences(["shot01.mov", "shot02.mov", "take_1.MP4", "take_2.MP4"]).sequences).toEqual([]);
  });

  it("lists at most a few gaps, then says how many more", () => {
    const names = Array.from({ length: 40 }, (_, i) => `k.${String(1000 + i * 2).padStart(4, "0")}.exr`);
    expect(groupSequences(names).sequences[0].missing).toBe("1001, 1003, 1005, 1007, 1009, 1011, 1013, 1015 and 31 more");
  });
});
