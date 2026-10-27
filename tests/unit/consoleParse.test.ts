import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, quoteArg, tokenize, valueProblem } from "../../src/shared/console/parse";
import { makeRegistry, MEANINGS, own, suggest } from "../../src/shared/console/registry";
import { parseLine } from "../../src/shared/console/script";

const reg = makeRegistry();
const posix = { windows: false };
const win = { windows: true };
const values = (line: string, o = posix) => tokenize(line, o).words.map((w) => w.value);

describe("tokenize", () => {
  it("splits on spaces and tabs, keeping each word's source range", () => {
    const { words, error } = tokenize("  render\tshot.mov  -o out/ ", posix);
    expect(error).toBeNull();
    expect(words.map((w) => [w.value, w.start, w.end])).toEqual([
      ["render", 2, 8],
      ["shot.mov", 9, 17],
      ["-o", 19, 21],
      ["out/", 22, 26],
    ]);
  });

  it('takes single quotes literally and double quotes with \\" and \\\\ (Linux, macOS)', () => {
    expect(values(`'a b\\c' "d \\"e\\" \\\\ \\n"`)).toEqual(["a b\\c", 'd "e" \\ \\n']);
    expect(values(`"it's"  'say "hi"'`)).toEqual(["it's", 'say "hi"']);
    expect(values(`pre"mid dle"post`)).toEqual(["premid dlepost"]);
  });

  it("escapes the next character with a backslash outside quotes (Linux, macOS)", () => {
    expect(values("my\\ shot.mov a\\'b")).toEqual(["my shot.mov", "a'b"]);
    const w = tokenize("a\\ b", posix).words[0];
    expect([w.quoted, w.start, w.end]).toEqual([true, 0, 4]);
    // a trailing backslash escapes nothing: kept
    expect(values("a\\")).toEqual(["a\\"]);
  });

  it("keeps backslashes in Windows paths (Windows), quoted or not", () => {
    expect(values("cd C:\\shots\\sh010", win)).toEqual(["cd", "C:\\shots\\sh010"]);
    expect(values('dir "C:\\Program Files\\" \\\\server\\share', win)).toEqual(["dir", "C:\\Program Files\\", "\\\\server\\share"]);
  });

  it("reports an unterminated quote with its position, and keeps the word to the end", () => {
    const { words, error } = tokenize('render "my shot.mov', posix);
    expect(words.map((w) => w.value)).toEqual(["render", "my shot.mov"]);
    expect(error).toEqual({ message: 'unterminated " quote (close it with ")', start: 7, end: 19 });
    expect(tokenize("cd 'x", win).error?.start).toBe(3);
  });

  it("handles unicode (ranges in UTF-16 units, as the page indexes)", () => {
    const { words } = tokenize("cd 'Été 🎬/plates' ñ", posix);
    expect(words.map((w) => w.value)).toEqual(["cd", "Été 🎬/plates", "ñ"]);
    expect(words[2].start).toBe("cd 'Été 🎬/plates' ".length);
  });

  it("gives nothing for an empty or blank line", () => {
    expect(tokenize("", posix).words).toEqual([]);
    expect(tokenize(" \t ", posix).words).toEqual([]);
  });
});

describe("quoteArg", () => {
  it("leaves plain words alone and quotes the rest so tokenize gives the value back", () => {
    expect(quoteArg("plates/sh010.####.exr", posix)).toBe("plates/sh010.####.exr");
    expect(quoteArg("C:\\shots\\a", win)).toBe("C:\\shots\\a");
    // loop: NOT-WORTH — a handful of cases
    for (const v of ["my shot.mov", 'say "hi"', "a\\b c", "?", "--", "", "it's", "Été 🎬"]) {
      expect(values(quoteArg(v, posix))).toEqual([v]);
      if (!(v.includes('"') && v.includes("'"))) expect(values(quoteArg(v, win), win)).toEqual([v]);
    }
  });
});

describe("parse", () => {
  const kinds = (line: string, o = posix) => parse(line, reg, o).tokens.map((t) => `${t.kind}:${line.slice(t.start, t.end)}`);

  it("reads a corridorkey line: command, subcommand, flags, values and paths", () => {
    const p = parse("corridorkey render shot.mov -o out/ -F 1001-1100 --format=exr --linear", reg, posix);
    expect(p.errors).toEqual([]);
    expect(p.command?.name).toBe("render");
    expect(p.options.map((o) => [o.arg.id, o.value])).toEqual([
      ["output", "out/"],
      ["frames", "1001-1100"],
      ["format", "exr"],
      ["linear", null],
    ]);
    expect(p.positionals.map((x) => [x.arg.id, x.value])).toEqual([["clip", "shot.mov"]]);
    expect(kinds("corridorkey render shot.mov -o out/ --format=exr")).toEqual(["command:corridorkey", "subcommand:render", "path:shot.mov", "flag:-o", "path:out/", "flag:--format", "value:exr"]);
  });

  it("takes bare render / verify / prepare / info as corridorkey's", () => {
    const p = parse("render -i plates/ -o key.%04d.exr -s 1001 -e 1050", reg, posix);
    expect([p.command?.name, p.command?.kind, p.errors]).toEqual(["render", "cli", []]);
    expect(parse("info --json", reg, posix).command?.name).toBe("info");
  });

  it("reads short flags with attached values and combined switches", () => {
    const p = parse("render a.mov -o=out -F1001 -qv", reg, posix);
    // read as two switches (render's only short ones, which the CLI then can't take together: S3)
    expect(p.errors.map((e) => e.message)).toEqual(["-v can't be used with -q (one or the other)"]);
    expect(p.options.map((o) => [o.arg.id, o.value])).toEqual([
      ["output", "out"],
      ["frames", "1001"],
      ["quiet", null],
      ["verbose", null],
    ]);
    expect(parse("render a.mov -qo out", reg, posix).errors[0].message).toMatch(/only switches combine/);
  });

  it("takes a negative number as a value, not a flag", () => {
    expect(parse("render a.mov --brightness -0.5", reg, posix).options[0].value).toBe("-0.5");
  });

  it("ends the options at --: a clip whose name starts with -", () => {
    const p = parse("render -o out -- -weird.mov", reg, posix);
    expect(p.errors).toEqual([]);
    expect(p.positionals.map((x) => x.value)).toEqual(["-weird.mov"]);
  });

  it("asks for help with ?, -h, --help, /? or corridorkey help <command>", () => {
    // loop: NOT-WORTH — five spellings
    for (const l of ["render ?", "render -h", "render --help", "render /?", "corridorkey help render"]) {
      const p = parse(l, reg, posix);
      expect([p.help, p.command?.name], l).toEqual([true, "render"]);
    }
    expect(parse("corridorkey", reg, posix).help).toBe(true);
    // a quoted ? is a value
    expect(parse("apropos '?'", reg, posix).help).toBe(false);
  });

  it("reads sudo as a prefix, and sudo -k as sudo's own", () => {
    const p = parse("sudo render a.mov -o out --overwrite", reg, posix);
    expect([p.sudo, p.command?.name, p.errors]).toEqual([true, "render", []]);
    const k = parse("sudo -k", reg, posix);
    expect([k.sudo, k.command?.name, k.options.map((o) => o.arg.id)]).toEqual([false, "sudo", ["drop"]]);
    expect(parse("sudo", reg, posix).errors[0].message).toMatch(/sudo needs a command/);
  });

  it("flags mistakes with positions and a did-you-mean", () => {
    const l = "rendr a.mov";
    expect(parse(l, reg, posix).errors).toEqual([{ message: "unknown command 'rendr' (did you mean render?); help lists the commands", start: 0, end: 5 }]);
    const f = parse("render a.mov --frame 1001", reg, posix).errors[0];
    expect(f.message).toBe("corridorkey render has no option --frame (did you mean --frames?)");
    expect([f.start, f.end]).toEqual([13, 20]);
    expect(parse("corridorkey rendr", reg, posix).errors[0].message).toMatch(/did you mean render/);
  });

  it("checks values: enums, numbers and their range, whole numbers, frame specs", () => {
    const msg = (l: string) => parse(l, reg, posix).errors.map((e) => e.message);
    expect(msg("render a.mov --format exrr")).toEqual(["--format takes exr, video, not 'exrr' (did you mean exr?)"]);
    expect(msg("render a.mov --hint-quality 2")).toEqual(["--hint-quality must be between 0 and 1, got 2"]);
    expect(msg("render a.mov --despill abc")).toEqual(["--despill takes a number, not 'abc'"]);
    expect(msg("render a.mov -s 1.5")).toEqual(["--start takes a whole number, not '1.5'"]);
    expect(msg("render a.mov -F 1001-1100x2 -F 1001,1005")).toEqual([]);
    expect(msg("render a.mov -F 10a")).toEqual(["--frames takes frames like 1001-1100, 1001-1100x2 or 1001,1005, not '10a'"]);
    expect(msg("render a.mov --device gpu")[0]).toMatch(/takes auto, cuda, cpu, coreml/);
    // the error token covers the value
    const e = parse("render a.mov --format exrr", reg, posix).errors[0];
    expect([e.start, e.end]).toEqual([22, 26]);
  });

  it("refuses --progress-format (the Console sets it), a repeated flag, a switch with a value, extra arguments", () => {
    const msg = (l: string) => parse(l, reg, posix).errors.map((e) => e.message);
    expect(msg("render a.mov --progress-format plain")[0]).toMatch(/the Console sets it/);
    expect(msg("render a.mov -o a -o b")).toEqual(["--output is given twice"]);
    expect(msg("render a.mov --linear=yes")).toEqual(["--linear takes no value"]);
    expect(msg("render a.mov b.mov")).toEqual(["corridorkey render takes no more arguments here: 'b.mov'"]);
    expect(msg("pwd x")).toEqual(["pwd takes no arguments here: 'x'"]);
  });

  it("says a value is missing, and which flag the line ends expecting", () => {
    const p = parse("render a.mov -o ", reg, posix);
    expect(p.errors[0].message).toBe("--output needs a value (DIR|PATTERN)");
    expect(p.expecting?.id).toBe("output");
    expect(parse("render -o --linear", reg, posix).errors[0].message).toMatch(/needs a value/);
  });

  it("requires a builtin's required argument", () => {
    expect(parse("run", reg, posix).errors[0].message).toBe("run needs FILE.ckcmd");
    expect(parse("apropos", reg, posix).errors[0]).toEqual({ message: "apropos needs TERM", start: 7, end: 7 });
    expect(parse("apropos frame range", reg, posix).positionals.map((x) => x.value)).toEqual(["frame", "range"]);
  });

  it("knows aliases (ls, clear)", () => {
    expect(parse("ls plates", reg, posix).command?.name).toBe("dir");
    expect(parse("clear", reg, posix).command?.name).toBe("cls");
  });

  it("parses Windows paths as paths", () => {
    const p = parse('render C:\\shots\\a.mov -o "D:\\out dir"', reg, win);
    expect(p.errors).toEqual([]);
    expect([p.positionals[0].value, p.options[0].value]).toEqual(["C:\\shots\\a.mov", "D:\\out dir"]);
  });

  it("reports an unterminated quote as an error of the line", () => {
    expect(parse('cd "my folder', reg, posix).errors.map((e) => e.message)).toEqual(['unterminated " quote (close it with ")']);
  });

  it("never treats a quoted word as a command or flag", () => {
    expect(parse("'render' a", reg, posix).errors[0].message).toMatch(/unknown command 'render'/);
    expect(parse("apropos '--overwrite'", reg, posix).positionals[0].value).toBe("--overwrite");
  });
});

describe("registry", () => {
  it("has every CLI subcommand, marks render --overwrite destructive and the written paths", () => {
    expect(reg.cli.subcommands.map((c) => c.name)).toEqual(["render", "verify", "prepare", "info", "run"]);
    const render = reg.cli.subcommands[0];
    const a = (id: string) => render.args.find((x) => x.id === id)!;
    expect([a("overwrite").destructive, a("output").writes, a("report").writes, a("temp").writes, a("clip").writes]).toEqual([true, true, true, true, false]);
    // verify only reads its -o
    expect(reg.cli.subcommands[1].args.find((x) => x.id === "output")!.writes).toBe(false);
    expect([a("format").kind, a("format").values]).toEqual(["enum", ["exr", "video"]]);
    expect([a("frames").kind, a("start").integer, a("despill").range, a("models").kind, a("input-bit-depth").values]).toEqual(["frames", true, [0, 1], "path", ["8", "16"]]);
    expect([render.gpu, reg.cli.subcommands[1].gpu, reg.cli.subcommands[2].gpu, reg.cli.subcommands[3].gpu]).toEqual([true, false, true, false]);
  });

  it("suggests within two edits only", () => {
    expect(suggest("rendr", ["render", "verify"])).toBe("render");
    expect(suggest("xyz", ["render", "verify"])).toBeNull();
  });

  it("explains values even for an argument without a long name", () => {
    expect(
      valueProblem(
        reg.cli.subcommands[0].args.find((x) => x.id === "clip")!,
        "",
      ),
    ).toBe("INPUT needs a value, not an empty one");
  });
});

describe("review 2026-10-26 probe P10", () => {
  it("parses a line of the longest size the Console takes (8 KiB) quickly (the review measured 0.15-2.6 ms)", () => {
    const lines = ["render " + "a".repeat(8180), "render shot.mov " + "--linear ".repeat(900), `render "${"x y ".repeat(2040)}"`, "render " + "-o out/ ".repeat(1020)];
    // loop: NOT-WORTH — four lines in a test
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(8192);
      const t0 = performance.now();
      parse(line, reg, posix);
      // a generous bound (a busy test machine): a regression to quadratic work takes seconds
      expect(performance.now() - t0).toBeLessThan(100);
    }
  });
});

describe("SME review 2026-10-26", () => {
  it("M5: help -k and apropos search the help; find is reserved for files, and says what to type", () => {
    const k = parse("help -k overwrite", reg, posix);
    expect([k.errors, k.command?.name, k.options[0]?.arg.id, k.options[0]?.value]).toEqual([[], "help", "keyword", "overwrite"]);
    expect(parse("apropos frame range", reg, posix).errors).toEqual([]);
    // loop: NOT-WORTH — three spellings
    for (const l of ["find overwrite", 'find . -name "*.exr"', "find"]) {
      const p = parse(l, reg, posix);
      expect(
        p.errors.map((e) => e.message),
        l,
      ).toEqual(["find (a file search) comes in a later version; to search the commands and their options: help -k <term> (or apropos <term>)"]);
      expect(p.errors[0].start).toBe(0);
    }
  });
});

describe("SME review 2026-10-26: foreign commands (S5)", () => {
  it("answers what other command lines' names would do, instead of 'unknown command'", () => {
    const first = (l: string) => parse(l, reg, posix).errors.map((e) => e.message)[0];
    expect([first("rm -rf plates"), first("del *.exr"), first("RMDIR x")]).toEqual(Array(3).fill(expect.stringMatching(/^the Console never deletes files/)));
    expect(first("exit")).toMatch(/stays open/);
    expect(first("quit")).toMatch(/stays open/);
    // echo is a command now (Phase 4: variables)
    expect(parse("echo hi", reg, posix).command?.name).toBe("echo");
    // cat / type, head, tail are commands now (Phase 4 step 7); more and less point to them
    expect([parse("cat a.txt", reg, posix).command?.name, parse("type a.txt", reg, posix).command?.name]).toEqual(["cat", "cat"]);
    expect(first("less a.txt")).toMatch(/^cat <file> \(or type\) prints a text file/);
    expect(first("cp a b")).toMatch(/doesn't copy or move/);
  });

  it("man is its own command (the long page, backlog row 130); open and start show a folder in the file manager", () => {
    const m = parse("man render", reg, posix);
    expect([m.errors, m.command?.name, m.positionals[0]?.value]).toEqual([[], "man", "render"]);
    expect([parse("open .", reg, posix).command?.name, parse("start .", reg, win).command?.name]).toEqual(["open", "open"]);
  });
});

describe("SME review 2026-10-26: the CLI's conflicts", () => {
  it("S3: flags the CLI can't take together are marked before Enter, from the CLI's own spec", () => {
    const msg = (l: string) => parse(l, reg, posix).errors.map((e) => e.message);
    expect(msg("render a.mov -o out/ -F 1001-1100 -s 1001")).toEqual(["-s can't be used with -F (one or the other)"]);
    expect(msg("render a.mov -o out/ -e 1100 --frames 1001-1100")).toEqual(["--frames can't be used with -e (one or the other)"]);
    expect(msg("render a.mov -o out/ -q -v")).toEqual(["-v can't be used with -q (one or the other)"]);
    expect(msg("render a.mov -o out/ -qv")).toEqual(["-v can't be used with -q (one or the other)"]);
    expect(msg("sudo render a.mov -o out/ --overwrite --skip-existing")).toEqual(["--skip-existing can't be used with --overwrite (one or the other)"]);
    expect(msg("render a.mov -i b.mov -o out/")).toEqual(["-i can't be used with INPUT (one or the other)"]);
    expect(msg("render plates/ -o out/ --linear --no-linear")).toEqual(["--no-linear can't be used with --linear (one or the other)"]);
    expect(msg("render plates/ -o out/ --no-linear --linear")).toEqual(["--linear can't be used with --no-linear (one or the other)"]);
    // the error sits on the second flag
    const line = "render a.mov -o out/ -F 1001-1100 -s 1001";
    const e = parse(line, reg, posix).errors[0];
    expect(line.slice(e.start, e.end)).toBe("-s");
    // a flag and its attached value are one word: that word is marked
    const l2 = "render a.mov -o out/ -F1001 --start=1001";
    const e2 = parse(l2, reg, posix).errors[0];
    expect(l2.slice(e2.start, e2.end)).toBe("--start=1001");
    expect(msg("render a.mov -o out/ -s 1001 -e 1100")).toEqual([]);
  });

  it("S3: the conflicts come from the spec (both directions are checked)", () => {
    const render = reg.cli.subcommands.find((c) => c.name === "render")!;
    expect(render.args.find((a) => a.id === "start")!.conflicts).toEqual(["frames"]);
    expect(render.args.find((a) => a.id === "frames")!.conflicts).toEqual([]);
  });
});

describe("SME review 2026-10-26: versions", () => {
  it("S7: corridorkey --version, render --version (-V) and version ask for the version", () => {
    // loop: NOT-WORTH — a few spellings
    for (const l of ["corridorkey --version", "corridorkey -V", "render --version", "corridorkey render -V", "verify --version"]) {
      const p = parse(l, reg, posix);
      expect([p.errors, p.version], l).toEqual([[], true]);
    }
    expect(parse("version", reg, posix).command?.name).toBe("version");
    expect(parse("render a.mov", reg, posix).version).toBe(false);
  });
});

describe("SME review 2026-10-26: ls and dir flags (M3)", () => {
  it("reads -la, -1 and DOS's /w /o:d as dir's flags; a path that only starts like one stays a path", () => {
    expect(parse("ls -la", reg, posix).options.map((o) => o.arg.id)).toEqual(["long", "all"]);
    expect(parse("ls -1", reg, posix).options.map((o) => o.arg.id)).toEqual(["names"]);
    expect(parse("dir /o:-d /W", reg, posix).options.map((o) => [o.arg.id, o.value])).toEqual([
      ["order", "-d"],
      ["names", null],
    ]);
    // loop: NOT-WORTH — a few paths
    for (const l of ["dir /opt", "dir /a/b", "dir /w/x", 'dir "/w"']) expect(parse(l, reg, posix).positionals.length, l).toBe(1);
    expect(parse("dir /o:x", reg, posix).errors[0].message).toMatch(/^\/o takes n, s, d/);
    // -1 is a value where the command has no such flag
    expect(parse("render a.mov --brightness -1", reg, posix).options[0].value).toBe("-1");
  });
});

describe("SME review 2026-10-26: values by meaning (S12)", () => {
  const render = reg.cli.subcommands.find((c) => c.name === "render")!;
  const flag = (id: string) => render.args.find((a) => a.id === id)!;

  it("takes an enum's value in any case", () => {
    expect(parse("render a.mov -o out/ --format EXR --datatype Half", reg, posix).errors).toEqual([]);
    expect(valueProblem(flag("device"), "CUDA")).toBeNull();
  });

  it("suggests by meaning where a word means one of the CLI's values (gpu: auto, not cpu)", () => {
    expect(valueProblem(flag("device"), "gpu")).toBe("--device takes auto, cuda, cpu, coreml, not 'gpu' (did you mean auto?)");
    expect(valueProblem(flag("format"), "mp4")).toMatch(/did you mean video\?/);
    expect(valueProblem(flag("datatype"), "fp32")).toMatch(/did you mean float\?/);
    // a typo with no meaning in the table: the closest spelling, as before
    expect(valueProblem(flag("format"), "exe")).toMatch(/did you mean exr\?/);
  });

  it("every meaning names one of the CLI's own values for that flag (checked against the spec)", () => {
    // loop: NOT-WORTH — three flags, a few words each
    for (const [id, words] of Object.entries(MEANINGS)) {
      // loop: NOT-WORTH — as above
      for (const c of reg.cli.subcommands) {
        const a = c.args.find((x) => x.id === id);
        // loop: NOT-WORTH — as above
        if (a) for (const target of Object.values(words)) expect(a.values, `${c.name} --${id} ${target}`).toContain(target);
      }
      // loop: NOT-WORTH — as above
      expect(
        reg.cli.subcommands.some((c) => c.args.some((x) => x.id === id)),
        id,
      ).toBe(true);
    }
  });
});

describe("docs/GUIDE.md's Console examples", () => {
  it("each one parses without a mistake (the guide never shows a line the Console refuses)", () => {
    const guide = readFileSync(new URL("../../docs/GUIDE.md", import.meta.url), "utf8");
    const section = guide.slice(guide.indexOf("## Console"));
    const block = /Examples:\s*```\n([\s\S]*?)```/.exec(section)![1];
    // loop: NOT-WORTH — the guide's few examples
    const lines = block.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(5);
    // loop: NOT-WORTH — as above
    for (const l of lines) expect(parseLine(l, reg, posix).errors, l).toEqual([]);
  });
});

describe("lookups never reach Object.prototype", () => {
  it("constructor, toString, __proto__, hasOwnProperty typed as a command are unknown commands, not an answer", () => {
    // loop: NOT-WORTH — four test words
    for (const w of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      const p = parse(`${w} x`, reg, posix);
      expect(p.errors[0].message, w).toMatch(new RegExp(`^unknown command '${w}'`));
    }
  });

  it("a value named like a prototype member gets no meaning-based suggestion; own() reads own entries only", () => {
    const m = parse("render a.mov -o out/ --device constructor", reg, posix).errors.map((e) => e.message);
    expect(m).toEqual([expect.stringMatching(/^--device takes .*, not 'constructor'$/)]);
    expect(own({ a: 1 }, "a")).toBe(1);
    expect(own({ a: 1 }, "constructor")).toBeUndefined();
    expect(own({ a: 1 }, "__proto__")).toBeUndefined();
  });
});
