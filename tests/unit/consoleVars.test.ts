// The Console's variables (src/shared/console/vars.ts): ${name} only; a value is one quoted word; frame tokens literal.
import { describe, expect, it } from "vitest";
import { expandVars, forWords } from "../../src/shared/console/vars";
import { parse } from "../../src/shared/console/parse";
import { makeRegistry } from "../../src/shared/console/registry";

const vars: Record<string, string> = { shot: "sh010", sp: "my shots", q: 'say "hi"', flag: "--overwrite", both: `it's "x"` };
const x = (line: string, windows = false) => expandVars(line, (n) => vars[n], { windows });

describe("expandVars", () => {
  it("fills in ${name} outside quotes and in double quotes, as one quoted word", () => {
    expect(x("dir ${shot}")).toEqual({ line: 'dir "sh010"', changed: true });
    expect(x("dir plates/${shot}_plate.####.exr")).toEqual({ line: 'dir "plates/sh010_plate.####.exr"', changed: true });
    expect(x('cd "~/${sp}/x"')).toEqual({ line: 'cd "~/my shots/x"', changed: true });
    expect(x("echo ${q}")).toEqual({ line: 'echo "say \\"hi\\""', changed: true });
  });

  it("leaves frame tokens, other shells' variables, single quotes and escapes as typed", () => {
    for (const l of ["dir plate.$F4.exr", "dir $shot", "dir %04d ####.exr @@@@", "dir '${shot}'", "dir \\${shot}", "dir !$", "dir $HIP"]) expect(x(l)).toEqual({ line: l, changed: false });
  });

  it("an expanded word is never a flag (it parses as a value)", () => {
    const line = (x("render a.mov ${flag}") as { line: string }).line;
    const p = parse(line, makeRegistry(), { windows: false });
    expect(p.options).toEqual([]);
    expect(p.errors[0].message).toMatch(/takes no more arguments/);
  });

  it("Windows: no escapes, so a value with \" goes in '…'; one with both quote marks is refused", () => {
    expect(x("echo ${q}", true)).toEqual({ line: `echo 'say "hi"'`, changed: true });
    expect(x("dir C:\\${shot}", true)).toEqual({ line: 'dir "C:\\sh010"', changed: true });
    expect(x("echo ${both}", true)).toMatchObject({ error: expect.stringMatching(/both ' and "/) });
  });

  it("says what is wrong: an unknown name, a bad or unclosed one", () => {
    expect(x("dir ${nope}")).toEqual({ error: "${nope}: no such variable (set lists them; set nope=value makes it)" });
    expect(x("dir ${shot")).toMatchObject({ error: expect.stringMatching(/a variable is \$\{name\}/) });
    expect(x("dir ${1x}")).toMatchObject({ error: expect.stringMatching(/a variable is/) });
  });
});

describe("forWords (SME review 2026-10-27 M3, S10)", () => {
  const v: Record<string, string> = { dir: "/mnt/a*b", list: " sh010\tsh020\nsh030 " };
  const f = (line: string) => forWords(line, (n) => v[n], { windows: false });
  // loop: NOT-WORTH — a word's few characters
  const typed = (w: { value: string; active: boolean[] }) => [...w.value].map((c, i) => (w.active[i] ? c : "_")).join("");

  it("marks only what was typed unquoted as a pattern: never a value's characters, never quoted ones", () => {
    const r = f('${dir}/*.exr "x*"/y.####.exr \\*z') as Exclude<ReturnType<typeof f>, { error: string }>;
    expect(r.words.map((w) => w.value)).toEqual(["/mnt/a*b/*.exr", "x*/y.####.exr", "*z"]);
    expect(r.words.map(typed)).toEqual(["________/*.exr", "__/y.####.exr", "_z"]);
  });

  it("${name[@]} as a whole word splits the value at white space; ${name} is one word and a note says how to split", () => {
    expect(f("${list[@]} x")).toMatchObject({ words: [{ value: "sh010" }, { value: "sh020" }, { value: "sh030" }, { value: "x" }], notes: [] });
    expect(f("${list}")).toMatchObject({ words: [{ value: v.list }], notes: [expect.stringMatching(/for s in \$\{list\[@\]\}/)] });
    expect(f("${nope[@]}")).toMatchObject({ error: expect.stringMatching(/no such variable/) });
    expect(f("a${list[@]}")).toMatchObject({ error: expect.stringMatching(/a list splits only as a whole word/) });
  });
});
