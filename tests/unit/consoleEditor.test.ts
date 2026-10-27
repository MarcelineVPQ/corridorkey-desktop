// The Console's line editor (src/ui/console/editor.ts): every key as a pure function.
import { describe, expect, it } from "vitest";
import {
  acceptItem,
  commonPrefix,
  completion,
  firstWord,
  initialEditor,
  input,
  keyDown,
  needsCompletion,
  pasted,
  setLine,
  shownItems,
  suggestion,
  uniqueHistory,
  type EditorState,
  type Key,
  type KeyContext,
} from "../../src/ui/console/editor";
import type { ConsoleCompletion, ConsoleCompletionItem } from "../../src/shared/types";

const item = (insert: string, kind: ConsoleCompletionItem["kind"] = "flag"): ConsoleCompletionItem => ({ insert, label: insert, kind, help: "" });
const ctx = (history: string[] = [], extra: Partial<KeyContext> = {}): KeyContext => ({ history, hasSelection: false, running: false, ...extra });
const typed = (line: string, cursor = line.length, s = initialEditor()): EditorState => input(s, line, cursor);
/** the state with the completion answered for its line */
const withComp = (s: EditorState, start: number, items: ConsoleCompletionItem[]): EditorState => {
  const data: ConsoleCompletion = { start, end: s.cursor, items };
  return completion(s, s.line, s.cursor, data);
};
const press = (s: EditorState, key: string, mods: Partial<Key> = {}, c: KeyContext = ctx()) => keyDown(s, { key, ...mods }, c);

describe("completion (Tab)", () => {
  it("one choice is inserted with a space after it", () => {
    const s = withComp(typed("render --over"), 7, [item("--overwrite")]);
    const r = press(s, "Tab");
    expect(r.handled).toBe(true);
    expect(r.state.line).toBe("render --overwrite ");
    expect(r.state.cursor).toBe(19);
  });

  it("a folder or `--flag=` takes no space (the next Tab goes on inside it)", () => {
    const s = withComp(typed("cd pla"), 3, [item("plates/", "folder")]);
    expect(press(s, "Tab").state.line).toBe("cd plates/");
  });

  it("several choices insert what they share; a second Tab on the same line opens the list", () => {
    const s = withComp(typed("render --a"), 7, [item("--alpha-hint"), item("--alpha-trust")]);
    const r1 = press(s, "Tab");
    expect(r1.state.line).toBe("render --alpha-");
    expect(r1.state.list).toBeNull();
    const s2 = withComp(r1.state, 7, [item("--alpha-hint"), item("--alpha-trust")]);
    const r2 = press(s2, "Tab");
    expect(r2.state.list?.items).toHaveLength(2);
    expect(r2.state.list?.index).toBe(-1);
    expect(r2.state.line).toBe("render --alpha-");
  });

  it("nothing shared to add (ambiguity) opens the list on the first Tab", () => {
    const s = withComp(typed("render -"), 7, [item("--alpha-hint"), item("--output"), item("-q")]);
    const r = press(s, "Tab");
    expect(r.state.list?.items).toHaveLength(3);
  });

  it("Tab, Shift+Tab and ↑ ↓ move through the list and show the item in the line; Enter takes it", () => {
    let s = withComp(typed("render -"), 7, [item("--alpha-hint"), item("--output"), item("-q")]);
    s = press(s, "Tab").state;
    s = press(s, "Tab").state;
    expect(s.list?.index).toBe(0);
    expect(s.line).toBe("render --alpha-hint");
    s = press(s, "ArrowDown").state;
    expect(s.line).toBe("render --output");
    s = press(s, "Tab", { shift: true }).state;
    expect(s.list?.index).toBe(0);
    s = press(s, "ArrowUp").state; // wraps to the last
    expect(s.list?.index).toBe(2);
    expect(s.line).toBe("render -q");
    const r = press(s, "Enter");
    expect(r.effect).toBeUndefined(); // taking an item never runs the line
    expect(r.state.list).toBeNull();
    expect(r.state.line).toBe("render -q ");
  });

  it("Esc puts the original line back", () => {
    let s = withComp(typed("render -"), 7, [item("--alpha-hint"), item("--output"), item("-q")]);
    s = press(s, "Tab").state;
    s = press(s, "Tab").state;
    s = press(s, "Tab").state;
    expect(s.line).toBe("render --output");
    const r = press(s, "Escape");
    expect(r.state.line).toBe("render -");
    expect(r.state.cursor).toBe(8);
    expect(r.state.list).toBeNull();
  });

  it("Ctrl+Space opens the list even for one choice; a stale completion is never used", () => {
    const s = withComp(typed("ver"), 0, [item("verify", "command")]);
    expect(press(s, " ", { ctrl: true }).state.list?.items).toHaveLength(1);
    const stale = input(s, "veri", 4); // the line moved on: the old answer doesn't apply
    expect(press(stale, " ", { ctrl: true }).state.list).toBeNull();
    expect(needsCompletion({ key: "Tab" }, stale)).toBe(true);
    expect(needsCompletion({ key: " ", ctrl: true }, stale)).toBe(true);
    expect(needsCompletion({ key: "a" }, stale)).toBe(false);
  });

  it("a click on an item inserts it", () => {
    let s = withComp(typed("render -"), 7, [item("--alpha-hint"), item("--output"), item("-q")]);
    s = press(s, "Tab").state;
    expect(acceptItem(s, 1).line).toBe("render --output ");
  });

  it("List mode shows the choices as you type; ↓ or Tab enters them; F2 switches mode", () => {
    let s = withComp(typed("render --o", undefined, initialEditor("list")), 7, [item("--output"), item("--overwrite")]);
    expect(shownItems(s)?.items).toHaveLength(2);
    expect(shownItems(s)?.index).toBe(-1);
    const r = press(s, "ArrowDown");
    expect(r.state.list?.index).toBe(0);
    expect(r.state.line).toBe("render --output");
    s = press(s, "F2").state;
    expect(s.mode).toBe("inline");
    expect(press(withComp(typed("x"), 0, []), "F2").effect).toEqual({ kind: "mode", mode: "list" });
    expect(shownItems(s)).toBeNull();
  });

  it("commonPrefix", () => {
    expect(commonPrefix(["--alpha-hint", "--alpha-trust"])).toBe("--alpha-");
    expect(commonPrefix([])).toBe("");
    expect(commonPrefix(["a"])).toBe("a");
  });
});

describe("the grey suggestion", () => {
  const hist = ["render shot.mov -o out/", "info", "render plates/ -o out/"];

  it("comes from the history first (newest first), then the completion", () => {
    expect(suggestion(typed("ren"), hist)).toBe("der shot.mov -o out/");
    const s = withComp(typed("verif"), 0, [item("verify", "command")]);
    expect(suggestion(s, hist)).toBe("y");
  });

  it("only with the cursor at the end, and only when on", () => {
    expect(suggestion(typed("ren", 1), hist)).toBeNull();
    expect(suggestion(typed("ren", 3, initialEditor("inline", false)), hist)).toBeNull();
    expect(suggestion(typed(""), hist)).toBeNull();
  });

  it("→, End and Ctrl+F take it all; nothing runs", () => {
    // loop: NOT-WORTH — three keys in a test
    for (const k of [{ key: "ArrowRight" }, { key: "End" }, { key: "f", ctrl: true }]) {
      const r = keyDown(typed("ren"), k, ctx(hist));
      expect(r.handled).toBe(true);
      expect(r.effect).toBeUndefined();
      expect(r.state.line).toBe("render shot.mov -o out/");
    }
  });

  it("Alt+→ and Alt+F take one word (a path one part at a time)", () => {
    const r = keyDown(typed("ren"), { key: "ArrowRight", alt: true }, ctx(hist));
    expect(r.state.line).toBe("render");
    const r2 = keyDown(r.state, { key: "f", alt: true }, ctx(hist));
    expect(r2.state.line).toBe("render shot.mov");
    expect(firstWord(" plates/sh010/")).toBe(" plates/");
    expect(firstWord("/abs")).toBe("/");
  });

  it("without a suggestion → is the input's own (the cursor moves)", () => {
    expect(press(typed("zzz", 1), "ArrowRight").handled).toBe(false);
  });
});

describe("history (↑ ↓)", () => {
  const hist = ["render b.mov", "info", "render a.mov", "help"];

  it("↑ walks the lines that start with what was typed, ↓ comes back to it", () => {
    let s = typed("render");
    s = press(s, "ArrowUp", {}, ctx(hist)).state;
    expect(s.line).toBe("render b.mov");
    s = press(s, "ArrowUp", {}, ctx(hist)).state;
    expect(s.line).toBe("render a.mov");
    s = press(s, "ArrowUp", {}, ctx(hist)).state; // no older match: stays
    expect(s.line).toBe("render a.mov");
    s = press(s, "ArrowDown", {}, ctx(hist)).state;
    expect(s.line).toBe("render b.mov");
    s = press(s, "ArrowDown", {}, ctx(hist)).state;
    expect(s.line).toBe("render");
    expect(s.hist).toBeNull();
  });

  it("an empty line walks all of it", () => {
    const s = press(typed(""), "ArrowUp", {}, ctx(hist)).state;
    expect(s.line).toBe("render b.mov");
  });

  it("uniqueHistory drops repeats and blanks, newest kept", () => {
    expect(uniqueHistory(["a", "b", "a", " ", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("Ctrl+R", () => {
  const hist = ["render b.mov -o out/", "info", "render a.mov", "dir plates"];

  it("searches as you type, again for older, Enter runs the match", () => {
    let s = press(typed("x"), "r", { ctrl: true }, ctx(hist)).state;
    expect(s.search).not.toBeNull();
    // loop: NOT-WORTH — three letters
    for (const ch of "ren") s = press(s, ch, {}, ctx(hist)).state;
    expect(s.line).toBe("render b.mov -o out/");
    s = press(s, "r", { ctrl: true }, ctx(hist)).state;
    expect(s.line).toBe("render a.mov");
    s = press(s, "r", { ctrl: true }, ctx(hist)).state; // no older one: stays on the oldest
    expect(s.line).toBe("render a.mov");
    const r = press(s, "Enter", {}, ctx(hist));
    expect(r.effect).toEqual({ kind: "run", line: "render a.mov" });
    expect(r.state.line).toBe("");
  });

  it("Esc and Ctrl+G cancel back to the line typed", () => {
    let s = press(typed("dir"), "r", { ctrl: true }, ctx(hist)).state;
    s = press(s, "i", {}, ctx(hist)).state;
    expect(s.line).toBe("info");
    expect(press(s, "Escape", {}, ctx(hist)).state.line).toBe("dir");
    expect(press(s, "g", { ctrl: true }, ctx(hist)).state.line).toBe("dir");
  });

  it("no match says so; Backspace widens again; another key takes the match to edit", () => {
    let s = press(typed(""), "r", { ctrl: true }, ctx(hist)).state;
    s = press(s, "q", {}, ctx(hist)).state;
    expect(s.search?.failed).toBe(true);
    s = press(s, "Backspace", {}, ctx(hist)).state;
    s = press(s, "p", {}, ctx(hist)).state;
    expect(s.line).toBe("dir plates");
    const r = press(s, "a", { ctrl: true }, ctx(hist));
    expect(r.state.search).toBeNull();
    expect(r.state.line).toBe("dir plates");
    expect(r.state.cursor).toBe(0);
  });
});

describe("readline keys", () => {
  const s = typed("render shot.mov -o out/", 15); // cursor after "shot.mov"

  it("Ctrl+A / Ctrl+E", () => {
    expect(press(s, "a", { ctrl: true }).state.cursor).toBe(0);
    expect(press(s, "e", { ctrl: true }).state.cursor).toBe(23);
  });

  it("Ctrl+U deletes to the start, Ctrl+K to the end, Ctrl+W the word before", () => {
    expect(press(s, "u", { ctrl: true }).state).toMatchObject({ line: " -o out/", cursor: 0 });
    expect(press(s, "k", { ctrl: true }).state).toMatchObject({ line: "render shot.mov", cursor: 15 });
    expect(press(s, "w", { ctrl: true }).state).toMatchObject({ line: "render  -o out/", cursor: 7 });
  });

  it("Alt+B / Alt+F move a word", () => {
    expect(press(s, "b", { alt: true }).state.cursor).toBe(7);
    expect(press(s, "f", { alt: true }).state.cursor).toBe(18);
    expect(press(s, "ArrowLeft", { alt: true }).state.cursor).toBe(7);
  });

  it("Ctrl+L clears the screen (the line stays)", () => {
    const r = press(s, "l", { ctrl: true });
    expect(r.effect).toEqual({ kind: "clear" });
    expect(r.state.line).toBe(s.line);
  });

  it("Enter runs the line and empties the input; an empty line runs nothing", () => {
    const r = press(s, "Enter");
    expect(r.effect).toEqual({ kind: "run", line: "render shot.mov -o out/" });
    expect(r.state.line).toBe("");
    expect(press(typed("   "), "Enter").effect).toBeUndefined();
  });

  it("plain typing, Backspace and Home are the input's own", () => {
    expect(press(s, "x").handled).toBe(false);
    expect(press(s, "Backspace").handled).toBe(false);
    expect(press(s, "Home").handled).toBe(false);
  });
});

describe("Ctrl+C", () => {
  const s = typed("render shot.mov");
  it("copies a selection (the input does it)", () => {
    expect(press(s, "c", { ctrl: true }, ctx([], { hasSelection: true, running: true })).handled).toBe(false);
  });
  it("else stops the running command (the line stays)", () => {
    const r = press(s, "c", { ctrl: true }, ctx([], { running: true }));
    expect(r.effect).toEqual({ kind: "cancel" });
    expect(r.state.line).toBe("render shot.mov");
  });
  it("else clears the line", () => {
    const r = press(s, "c", { ctrl: true });
    expect(r.effect).toBeUndefined();
    expect(r.state.line).toBe("");
  });
});

describe("a line from outside", () => {
  it("History and Re-run put the line in, cursor at its end, never run", () => {
    const s = setLine(typed("x"), "info");
    expect(s).toMatchObject({ line: "info", cursor: 4, list: null, search: null });
  });
});

describe("the suggestion's source", () => {
  it("keys take the suggestion from suggestFrom when given (the page leaves out lines that wouldn't run)", () => {
    const r = keyDown(typed("ren"), { key: "ArrowRight" }, { history: ["rendr x", "render a.mov"], suggestFrom: ["render a.mov"], hasSelection: false, running: false });
    expect(r.state.line).toBe("render a.mov");
  });
});

describe("SME review 2026-10-26: readline's missing reflexes (S10)", () => {
  it("Alt+. inserts the last word of the previous line (the output path just used)", () => {
    const h = ctx(["render a.mov -o ~/renders/sh010/key.####.exr", "pwd"]);
    const r = press(typed("verify -o "), ".", { alt: true }, h);
    expect([r.handled, r.state.line, r.state.cursor]).toEqual([true, "verify -o ~/renders/sh010/key.####.exr", 38]);
    expect(press(typed(""), ".", { alt: true }, ctx()).state.line).toBe("");
  });

  it("Ctrl+U, Ctrl+K, Ctrl+W and Alt+D cut; Ctrl+Y puts the cut text back", () => {
    const cutK = press(typed("render a.mov -o out", 12), "k", { ctrl: true });
    expect(cutK.state.line).toBe("render a.mov");
    expect(press(typed("x ", 2, cutK.state), "y", { ctrl: true }).state.line).toBe("x  -o out");
    const cutW = press(typed("render a.mov"), "w", { ctrl: true });
    expect(press(cutW.state, "y", { ctrl: true }).state.line).toBe("render a.mov");
    const altD = press(typed("render a.mov -o out", 6), "d", { alt: true });
    expect([altD.state.line, altD.state.cursor]).toEqual(["render -o out", 6]);
    expect(press(altD.state, "y", { ctrl: true }).state.line).toBe("render a.mov -o out");
  });

  it("Ctrl+P and Ctrl+N walk the history as ↑ and ↓ do", () => {
    const h = ctx(["dir", "pwd"]);
    const p = press(typed(""), "p", { ctrl: true }, h);
    expect(p.state.line).toBe("dir");
    expect(press(p.state, "p", { ctrl: true }, h).state.line).toBe("pwd");
    expect(press(p.state, "n", { ctrl: true }, h).state.line).toBe("");
  });

  it("Ctrl+D on an empty line does nothing (never closes); on a line it deletes the character under the cursor", () => {
    const empty = press(typed(""), "d", { ctrl: true });
    expect([empty.handled, empty.state.line, empty.effect]).toEqual([true, "", undefined]);
    expect(press(typed("pwdx", 3), "d", { ctrl: true }).state.line).toBe("pwd");
  });

  it("macOS: Option+F / Option+B move by words from the key's code (the key itself is ƒ / ∫)", () => {
    const s = typed("render a.mov -o out", 0);
    const f = press(s, "ƒ", { alt: true, code: "KeyF" });
    expect([f.handled, f.state.line, f.state.cursor]).toEqual([true, "render a.mov -o out", 6]);
    const b = press(f.state, "∫", { alt: true, code: "KeyB" });
    expect([b.handled, b.state.cursor]).toEqual([true, 0]);
    expect(press(typed("verify "), "≥", { alt: true, code: "Period" }, ctx(["render a.mov"])).state.line).toBe("verify a.mov");
  });

  it("Cmd+K clears the screen, as in Terminal and iTerm", () => {
    expect(press(typed("pwd"), "k", { meta: true }).effect).toEqual({ kind: "clear" });
  });
});

describe("SME review 2026-10-26: pasting several lines (S2)", () => {
  it("one line goes in at the cursor (a trailing line break dropped); several are offered, never joined", () => {
    expect(pasted(typed("cd "), "plates\n").line).toBe("cd plates");
    const s = pasted(typed(""), "dir\r\ncd ..\n\npwd\n");
    expect([s.line, s.paste]).toEqual(["", ["dir", "cd ..", "pwd"]]);
  });

  it("Enter runs them as a script; Esc keeps the first; Ctrl+C drops them; other keys type nothing meanwhile", () => {
    const s = pasted(typed(""), "dir\ncd ..\npwd");
    const run = press(s, "Enter");
    expect([run.effect, run.state.paste]).toEqual([{ kind: "script", lines: ["dir", "cd ..", "pwd"] }, null]);
    const keep = press(s, "Escape");
    expect([keep.effect, keep.state.paste, keep.state.line]).toEqual([undefined, null, "dir"]);
    expect(press(s, "c", { ctrl: true }).state).toMatchObject({ paste: null, line: "" });
    const x = press(s, "x");
    expect([x.handled, x.state.paste?.length, x.effect]).toEqual([true, 3, undefined]);
  });
});
