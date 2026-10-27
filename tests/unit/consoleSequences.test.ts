// Frame sequences as a TD reads a folder (src/shared/console/sequences.ts): lsseq-style grouping for dir and Tab.
import { describe, expect, it } from "vitest";
import { folderRange, frameRanges, frameToken, groupSequences, sequenceOf } from "../../src/shared/console/sequences";

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
      ["a.##.exr", "1-2"],
      ["a.####.exr", "1-2"],
      ["b_###.png", "1-2"],
      ["plate #.exr", "9-10"],
    ]);
    expect(singles).toEqual(["c.1001.exr"]);
  });

  // SME review 2026-10-27 M2 (probe): split by digit count, unpadded frames were three sequences and a shot past 9999
  // two, and the farm export took the first one's range (Frames=1-9 of 120, ending green)
  it("an unpadded run and a run that outgrows its padding are one sequence, as lsseq and the CLI's frame_of read them", () => {
    const unpadded = groupSequences(Array.from({ length: 120 }, (_, i) => `frame.${i + 1}.exr`));
    expect(unpadded.sequences.map((s) => [s.pattern, s.range, s.count, s.missing])).toEqual([["frame.#.exr", "1-120", 120, null]]);
    expect(unpadded.singles).toEqual([]);
    const sim = groupSequences(["sim.9997.exr", "sim.9998.exr", "sim.9999.exr", "sim.10000.exr", "sim.10001.exr", "sim.10002.exr"]);
    expect(sim.sequences.map((s) => [s.pattern, s.range, s.count])).toEqual([["sim.####.exr", "9997-10002", 6]]);
    // the pattern reads back every frame (sequenceOf is the CLI's frame_of)
    expect(sequenceOf(sim.sequences[0].pattern, sim.sequences[0].names)!.count).toBe(6);
    expect(sequenceOf(unpadded.sequences[0].pattern, unpadded.sequences[0].names)!.count).toBe(120);
    // a wider run with its own leading zeros is its own padding: two sequences
    expect(groupSequences(["s.1.exr", "s.2.exr", "s.0001.exr", "s.0002.exr"]).sequences.map((s) => s.pattern)).toEqual(["s.#.exr", "s.####.exr"]);
  });

  it("never groups videos (shot01.mov and shot02.mov are two clips, not a pattern the CLI reads)", () => {
    expect(groupSequences(["shot01.mov", "shot02.mov", "take_1.MP4", "take_2.MP4"]).sequences).toEqual([]);
  });

  it("lists at most a few gaps, then says how many more", () => {
    const names = Array.from({ length: 40 }, (_, i) => `k.${String(1000 + i * 2).padStart(4, "0")}.exr`);
    expect(groupSequences(names).sequences[0].missing).toBe("1001, 1003, 1005, 1007, 1009, 1011, 1013, 1015 and 31 more");
  });
});

describe("a typed pattern names one sequence (Phase 4: sequences everywhere)", () => {
  const folder = [...frames("plate.", 1001, 1012).filter((n) => !/\.(1005|1006)\./.test(n)), "plate.mov", "plate.01.exr", "other.1001.exr", "plate.12345.exr", "plate.01234.exr"];

  it("reads the CLI's tokens and @ (frames.rs find_token): where, how long, the padding", () => {
    expect(frameToken("plate.####.exr")).toEqual({ at: 6, len: 4, pad: 4 });
    expect(frameToken("plate.%04d.exr")).toEqual({ at: 6, len: 4, pad: 4 });
    expect(frameToken("plate.%d.exr")).toEqual({ at: 6, len: 2, pad: 1 });
    expect(frameToken("plate.$F4.exr")).toEqual({ at: 6, len: 3, pad: 4 });
    expect(frameToken("plate.$F.exr")).toEqual({ at: 6, len: 2, pad: 1 });
    expect(frameToken("plate.@@@@.exr")).toEqual({ at: 6, len: 4, pad: 4 });
    expect(frameToken("plate.1001.exr")).toBeNull();
    expect(frameToken("50%.exr")).toBeNull();
  });

  it("####, %04d, $F4 and @@@@ name the same frames, shown in the CLI's #### form, gaps as ranges", () => {
    // loop: NOT-WORTH — four spellings
    for (const p of ["plate.####.exr", "plate.%04d.exr", "plate.$F4.exr", "plate.@@@@.exr"]) {
      const q = sequenceOf(p, folder)!;
      expect([q.pattern, q.range, q.count, q.missing], p).toEqual(["plate.####.exr", "1001-12345", 11, "1005-1006, 1013-12344"]);
      expect(q.names).not.toContain("plate.01.exr");
      expect(q.names).not.toContain("plate.01234.exr");
    }
    expect(sequenceOf("plate.##.exr", folder)!.names).toEqual([
      "plate.01.exr",
      "plate.1001.exr",
      "plate.1002.exr",
      "plate.1003.exr",
      "plate.1004.exr",
      "plate.1007.exr",
      "plate.1008.exr",
      "plate.1009.exr",
      "plate.1010.exr",
      "plate.1011.exr",
      "plate.1012.exr",
      "plate.12345.exr",
    ]);
    expect(sequenceOf("nothing.####.exr", folder)).toBeNull();
    expect(sequenceOf("plate.mov", folder)).toBeNull();
  });
});

describe("SME review 2026-10-27: the expert suggestions", () => {
  it("N9 (row 148): sim.-010.exr is frame -10 of sim.####.exr (Houdini's pre-roll, as wide as 0001); shot-0010 is frame 10", () => {
    const names = [...Array.from({ length: 10 }, (_, i) => `sim.-${String(10 - i).padStart(3, "0")}.exr`), ...frames("sim.", 0, 20)];
    const { sequences, singles } = groupSequences(names);
    expect(singles).toEqual([]);
    expect(sequences.map((s) => [s.pattern, s.range, s.count, s.belowZero])).toEqual([["sim.####.exr", "-10-20", 31, 10]]);
    expect(groupSequences(["shot-0010.exr", "shot-0011.exr"]).sequences.map((s) => [s.pattern, s.range, s.belowZero])).toEqual([["shot-####.exr", "10-11", 0]]);
    expect(sequenceOf("sim.####.exr", names)!.count).toBe(31);
    // a folder with a pre-roll: corridorkey numbers it from 1001, so farm export says so instead of a wrong range
    expect(folderRange(names)).toEqual({ error: expect.stringMatching(/^sim\.####\.exr has 10 frames below 0 .* from 1001/) });
  });

  it("P4 N5 (row 144): a sequence knows its span and lists more gaps for the hover", () => {
    const names = frames("p.", 1, 400).filter((n, i) => i % 2 === 0);
    const s = groupSequences(names).sequences[0];
    expect([s.count, s.span]).toEqual([200, 399]);
    expect(s.missing).toMatch(/^2, 4, .* and 191 more$/);
    expect(s.gaps!.split(", ")).toHaveLength(199);
  });
});
