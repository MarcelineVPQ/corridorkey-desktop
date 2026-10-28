// History expansion (src/shared/console/expand.ts): bash's reflexes, with the SME review's rule that frame tokens and
// a `!` inside a word or quotes are file names in this world, never expansions.
import { describe, expect, it } from "vitest";
import { expandHistory, hasExpansion, HISTORY_WINDOW } from "../../src/shared/console/expand";

/** newest last, with stable numbers */
const past = [
  { n: 40, line: "cd /mnt/show/sq01/sh010" },
  { n: 41, line: "render -i plates/sh010.####.exr -o key/sh010_key.####.exr --despill 0.3" },
  { n: 42, line: "dir key" },
  { n: 43, line: `render shot.mov -o "my out/" --overwrite` },
];
const x = (line: string, windows = false) => expandHistory(line, past, { windows });

describe("history expansion", () => {
  it("!! is the line before, !N line N, !-N the Nth before, !prefix the newest line starting so", () => {
    expect(x("!!")).toEqual({ line: past[3].line, changed: true });
    expect(x("sudo !!")).toEqual({ line: `sudo ${past[3].line}`, changed: true });
    expect(x("!41")).toEqual({ line: past[1].line, changed: true });
    expect(x("!-2")).toEqual({ line: past[2].line, changed: true });
    expect(x("!cd")).toEqual({ line: past[0].line, changed: true });
    expect(x("!ren")).toEqual({ line: past[3].line, changed: true });
  });

  it("!prefix ends at a script separator: ;, & and | aren't part of it (P4 senior review N2, BACKLOG row 132)", () => {
    expect(x("!dir;pwd")).toEqual({ line: `${past[2].line};pwd`, changed: true });
    expect(x("!dir&&pwd")).toEqual({ line: `${past[2].line}&&pwd`, changed: true });
    expect(x("!dir||pwd")).toEqual({ line: `${past[2].line}||pwd`, changed: true });
  });

  it("!$ is the last word of the line before, as typed (its quotes kept)", () => {
    expect(x("dir !$")).toEqual({ line: "dir --overwrite", changed: true });
    expect(expandHistory("cd !$", [{ n: 1, line: `dir "my out/"` }], { windows: false })).toEqual({ line: `cd "my out/"`, changed: true });
    expect(expandHistory("dir !$", past.slice(0, 2), { windows: false })).toEqual({ line: "dir 0.3", changed: true });
  });

  it("^old^new: the line before with its first old replaced", () => {
    expect(x("^my out^v002")).toEqual({ line: `render shot.mov -o "v002/" --overwrite`, changed: true });
    expect(x("^my out^v002^")).toEqual({ line: `render shot.mov -o "v002/" --overwrite`, changed: true });
    expect(x("^nothere^x")).toEqual({ error: "^nothere^x: 'nothere' isn't in the line before (render shot.mov -o \"my out/\" --overwrite)" });
  });

  it("says when there is no such line (bash's event not found), and when there is no line before", () => {
    expect(x("!99")).toEqual({ error: "!99: no line 99 in the history (history lists the numbers)" });
    expect(x("!-9")).toEqual({ error: "!-9: the history has only 4 lines" });
    // whole review: !-0 says how !-N counts, not that the history is short
    expect(x("!-0")).toEqual({ error: "!-0: !-N counts back from 1 (!-1 is the line before)" });
    expect(x("!zzz")).toEqual({ error: "!zzz: no line in the history starts with zzz" });
  });

  it("review N2: past a full window, says the line is older than ! reaches (the history keeps more)", () => {
    // loop: NOT-WORTH — a 200-line fixture, once
    const full = Array.from({ length: HISTORY_WINDOW }, (_, i) => ({ n: 4122 + i, line: `info ${i}` }));
    const y = (line: string) => expandHistory(line, full, { windows: false });
    expect(y("!4000")).toEqual({ error: `!4000: line 4000 is older than the newest ${HISTORY_WINDOW} lines that ! reaches` });
    expect(y("!-250")).toEqual({ error: `!-250: older than the newest ${HISTORY_WINDOW} lines that ! reaches` });
    expect(y("!zzz")).toEqual({ error: `!zzz: no line in the newest ${HISTORY_WINDOW} lines that ! reaches starts with zzz` });
    expect(y("!99999")).toEqual({ error: "!99999: no line 99999 in the history (history lists the numbers)" });
    expect(expandHistory("!!", [], { windows: false })).toEqual({ error: "!!: the history is empty" });
  });

  it("frame tokens and file names stay literal: ! inside a word, in quotes, escaped, before a frame token, alone", () => {
    // loop: NOT-WORTH — the literal cases
    for (const line of [
      "render sh010!.mov -o key/",
      "render 'take!!.mov' -o key/",
      'render "!!" -o key/',
      "render \\!! -o key/",
      "render plate.$F4.exr -o key/",
      "render !$F4.exr -o key/",
      "render !####.exr -o key/",
      "render !%04d.exr -o key/",
      "render !@@@@.exr -o key/",
      "render ! -o key/",
      "dir !=x",
      "render a.mov -o key/ --despill 0.5^2",
    ])
      expect(x(line), line).toEqual({ line, changed: false });
    // a ^ not at the start is a character
    expect(hasExpansion("dir a^b^c")).toBe(false);
  });

  it("Windows: a backslash is a path separator, so C:\\shots\\!! has no ! at a word's start", () => {
    expect(x("dir C:\\shots\\!!", true)).toEqual({ line: "dir C:\\shots\\!!", changed: false });
    expect(x("dir !!", true)).toMatchObject({ changed: true });
  });

  it("hasExpansion: whether a line has anything to expand (the page's preview)", () => {
    expect(hasExpansion("sudo !!")).toBe(true);
    expect(hasExpansion("^a^b")).toBe(true);
    expect(hasExpansion("render sh010!.mov")).toBe(false);
  });
});
