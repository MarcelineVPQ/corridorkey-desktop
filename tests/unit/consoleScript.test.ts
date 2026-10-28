// The Console's scripting language (src/shared/console/script.ts): separators outside quotes, for, if, time.
import { describe, expect, it } from "vitest";
import { commandStart, commands, globRegExp, isCompound, parseLine, parseProgram, type List } from "../../src/shared/console/script";
import { makeRegistry } from "../../src/shared/console/registry";

const opts = { windows: false };
const prog = (src: string) => {
  const r = parseProgram(src, opts);
  if ("error" in r) throw new Error(r.error.message);
  return r.list;
};
const err = (src: string) => {
  const r = parseProgram(src, opts);
  return "error" in r ? r.error.message : null;
};
/** a list as text: op and node, nested */
const show = (l: List): string =>
  l.items
    .map(
      ({ op, node: n }) =>
        (op ? `${op} ` : "") +
        (n.kind === "cmd"
          ? `${n.time ? "time " : ""}[${n.text}]`
          : n.kind === "for"
            ? `for ${n.name} in <${n.items}> { ${show(n.body)} }`
            : `if { ${show(n.cond)} } then { ${show(n.then)} }${n.else ? ` else { ${show(n.else)} }` : ""}`),
    )
    .join(" ");

describe("parseProgram", () => {
  it("splits at ; && || and new lines, never inside quotes or after a backslash", () => {
    expect(show(prog("dir a && dir b || pwd; cd ..\nversion"))).toBe("[dir a] && [dir b] || [pwd] ; [cd ..] ; [version]");
    expect(show(prog(String.raw`echo "a;b && c" 'x||y' d\;e`))).toBe(String.raw`[echo "a;b && c" 'x||y' d\;e]`);
    expect(show(prog("dir a &&\n  dir b"))).toBe("[dir a] && [dir b]");
    expect(isCompound(prog("dir"))).toBe(false);
    expect(isCompound(prog("dir; pwd"))).toBe(true);
    expect(isCompound(prog("time dir"))).toBe(true);
  });

  it("reads for, if/else and time, nested, over lines; # at a line's start is a comment", () => {
    expect(show(prog("for f in a.mov b.mov; do render ${f} -o out; done"))).toBe("for f in <a.mov b.mov> { [render ${f} -o out] }");
    expect(show(prog("if verify -i x; then echo ok; else echo bad; fi && pwd"))).toBe("if { [verify -i x] } then { [echo ok] } else { [echo bad] } && [pwd]");
    const src = "# nightly\nfor s in sh010 sh020\ndo\n  # each shot\n  cd @${s}\n  time render plate.mov -o out\ndone\n";
    const l = prog(src);
    expect(show(l)).toBe("for s in <sh010 sh020> { [cd @${s}] ; time [render plate.mov -o out] }");
    expect(commands(l).map((c) => c.line)).toEqual([5, 6]);
    expect(show(prog("for x in 1 2; do if pwd; then dir; fi; done"))).toBe("for x in <1 2> { if { [pwd] } then { [dir] } }");
    // keywords only as a command's first word, unquoted
    expect(show(prog("echo for if 'done'"))).toBe("[echo for if 'done']");
  });

  it("says what is wrong, with where", () => {
    // a pipe is the Console's own (backlog row 127): only an empty side is a mistake
    expect(err("ls |")).toMatch(/^\| needs a command on each side/);
    expect(err("| grep x")).toMatch(/^\| needs a command on each side/);
    expect(err("dir &&")).toMatch(/at the end/);
    expect(err("&& dir")).toMatch(/needs a command before it/);
    expect(err("for f in a b; do dir")).toMatch(/done is missing/);
    expect(err("for 1 in a; do dir; done")).toMatch(/NAME is a variable's name/);
    expect(err("for cwd in a; do dir; done")).toMatch(/can't set it/);
    expect(err("for f a; do dir; done")).toMatch(/in comes after/);
    expect(err("if dir; echo x; fi")).toMatch(/expected then/);
    expect(err("done")).toMatch(/done without its for/);
    expect(err("for f in a; do; done")).toMatch(/needs a command/);
    expect(err("time")).toMatch(/time needs a command/);
    expect(parseProgram("dir | ", opts)).toMatchObject({ error: { start: 4, end: 5 } });
  });
});

describe("the page's reading of a line", () => {
  const reg = makeRegistry();
  it("parses each command in place: tokens and mistakes at their positions; keywords as commands", () => {
    const line = "for f in a b; do render ${f} --nope; done";
    const p = parseLine(line, reg, opts);
    expect(p.errors.map((e) => line.slice(e.start, e.end))).toEqual(["--nope"]);
    expect(p.tokens.filter((t) => t.kind === "subcommand").map((t) => line.slice(t.start, t.end))).toEqual(["for", "do", "done"]);
    expect(p.command?.name).toBe("render");
    // a pipe's stages each parsed in place: grep's missing TERM marked at the line's end, the filter is the command
    const piped = parseLine("dir *.exr | grep", reg, opts);
    expect([piped.command?.name, piped.errors.map((e) => e.message)]).toEqual(["grep", ["grep needs TERM"]]);
    expect(parseLine("dir | grep 'a|b'", reg, opts).errors).toEqual([]);
  });

  it("finds where the command at the cursor starts (Tab completes from there)", () => {
    expect(commandStart("dir a && ren", opts)).toBe(8);
    expect(commandStart("for f in a; do ren", opts)).toBe(14);
    expect(commandStart("time ren", opts)).toBe(4);
    expect(commandStart("tim", opts)).toBe(0);
    expect(commandStart("echo 'a;b' x", opts)).toBe(0);
  });
});

// senior review 2026-10-27 S5 (probe P10): each command's line number was counted from the start (30 000 short lines:
// 5.1 s on the main process; a 1 MiB script about a minute)
describe("a long program parses in linear time (review 2026-10-27 S5)", () => {
  it("30 000 lines in well under a second, with the right line numbers", () => {
    // loop: NOT-WORTH — the test's lines
    const src = Array.from({ length: 30_000 }, (_, i) => `echo ${i}`).join("\n");
    const t = performance.now();
    const p = parseProgram(src, { windows: false });
    const ms = performance.now() - t;
    if ("error" in p) throw new Error(p.error.message);
    expect(ms).toBeLessThan(500);
    expect(p.list.items).toHaveLength(30_000);
    expect([p.list.items[0].node, p.list.items[29_999].node]).toMatchObject([{ line: 1 }, { line: 30_000 }]);
  });
});

describe("whole review: file-name patterns", () => {
  it("a range written backwards ([z-a]) is said in words, not as the regular expression's error", () => {
    expect(() => globRegExp("sh[z-a].exr", false)).toThrow("[z-a] in sh[z-a].exr runs backwards: write the range low to high ([a-z])");
    expect(globRegExp("sh[a-z].exr", false).test("shq.exr")).toBe(true);
  });
});
