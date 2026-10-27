// The Console's line editor as pure functions (backlog row 95, docs/CONSOLE.md): the keymap, completion, the fish-style
// suggestion, history and Ctrl+R live here, so every key is unit-tested without a DOM (tests/unit/consoleEditor.test.ts).
// LineEditor.tsx owns the <input>: it feeds typed text in as "input", asks this module what a key does, and carries out
// the effect (run, cancel, copy, clear) through the app's IPC. Data the keys need (the history, newest first, and the
// completion for the line as it is now) comes in with each key; nothing here waits or reads a file.
import type { ConsoleCompletion, ConsoleCompletionItem } from "../../shared/types";

export type SuggestMode = "inline" | "list";

export interface ListState {
  items: ConsoleCompletionItem[];
  /** the range the selected item replaces, in `original.line` */
  start: number;
  end: number;
  /** the selected item, or -1: none yet (the list is shown, the line unchanged) */
  index: number;
  /** the line before the list opened: Esc puts it back */
  original: { line: string; cursor: number };
}

export interface SearchState {
  query: string;
  /** how many older matches Ctrl+R has skipped */
  skip: number;
  original: { line: string; cursor: number };
  /** no line matches the query (the prompt says so) */
  failed: boolean;
}

export interface EditorState {
  line: string;
  cursor: number;
  /** the completion answered for (line, cursor), or null; a stale one is never used */
  comp: { line: string; cursor: number; data: ConsoleCompletion } | null;
  list: ListState | null;
  /** the line the last Tab left (a second Tab on it opens the list) */
  lastTab: string | null;
  /** Up/Down: the typed prefix, the history match shown (index into the filtered matches), the line typed */
  hist: { prefix: string; index: number; saved: string } | null;
  search: SearchState | null;
  mode: SuggestMode;
  autosuggest: boolean;
  /** what Ctrl+U, Ctrl+K, Ctrl+W or Alt+D cut last (Ctrl+Y puts it back) */
  kill: string;
}

export interface Key {
  key: string;
  /** the physical key (KeyboardEvent.code): Option+F on macOS has key "ƒ" but code "KeyF" */
  code?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export interface KeyContext {
  /** the lines typed before, newest first */
  history: readonly string[];
  /** text is selected in the input (Ctrl+C copies it) */
  hasSelection: boolean;
  /** a command is running (Ctrl+C stops it) */
  running: boolean;
  /** the lines the grey suggestion may come from (the page leaves out lines that wouldn't run); default: history */
  suggestFrom?: readonly string[];
}

export type Effect = { kind: "run"; line: string } | { kind: "cancel" } | { kind: "clear" } | { kind: "mode"; mode: SuggestMode };

export interface KeyResult {
  state: EditorState;
  /** false: not ours, the input does what it does by itself (typing, Backspace, ← →, Home) */
  handled: boolean;
  effect?: Effect;
}

export const initialEditor = (mode: SuggestMode = "inline", autosuggest = true): EditorState => ({
  line: "",
  cursor: 0,
  comp: null,
  list: null,
  lastTab: null,
  hist: null,
  search: null,
  mode,
  autosuggest,
  kill: "",
});

/** The history without repeats, newest first (the file keeps non-adjacent duplicates). */
export function uniqueHistory(history: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // loop: NOT-WORTH — ≤ 200 lines, once per history fetch
  for (const l of history) {
    if (l.trim() === "" || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

/** The longest prefix every string shares. */
export function commonPrefix(xs: readonly string[]): string {
  if (!xs.length) return "";
  let p = xs[0];
  // loop: NOT-WORTH — a completion's ≤ 200 items, per Tab
  for (const x of xs) {
    let i = 0;
    // loop: NOT-WORTH — the characters of two short words
    while (i < p.length && i < x.length && p[i] === x[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

/** The completion for the line as it is now, or null (none asked yet, or it answered an older line). */
export function freshCompletion(s: EditorState): ConsoleCompletion | null {
  return s.comp && s.comp.line === s.line && s.comp.cursor === s.cursor ? s.comp.data : null;
}

/** The grey suggestion after the cursor (fish): the newest history line that starts with the line, else the first
 * completion of the word being typed. Only with the cursor at the end, nothing else open. */
export function suggestion(s: EditorState, history: readonly string[]): string | null {
  if (!s.autosuggest || s.list || s.search || s.hist || s.cursor !== s.line.length || s.line.trim() === "") return null;
  // loop: HOT-PATH-OK — ≤ 200 lines, per keystroke
  const h = history.find((l) => l.length > s.line.length && l.startsWith(s.line));
  if (h) return h.slice(s.line.length);
  const c = freshCompletion(s);
  if (!c || !c.items.length || c.start >= c.end) return null;
  const typed = s.line.slice(c.start, c.end);
  const first = c.items[0].insert;
  return first.length > typed.length && first.startsWith(typed) ? first.slice(typed.length) : null;
}

/** The completions shown as a list: an open list's, or (List mode) the current word's while typing. */
export function shownItems(s: EditorState): { items: ConsoleCompletionItem[]; index: number } | null {
  if (s.search) return null;
  if (s.list) return { items: s.list.items, index: s.list.index };
  if (s.mode !== "list" || s.hist) return null;
  const c = freshCompletion(s);
  if (!c || !c.items.length || c.start >= c.end) return null;
  // the word is already exactly the one choice: nothing to offer
  if (c.items.length === 1 && c.items[0].insert === s.line.slice(c.start, c.end)) return null;
  return { items: c.items, index: -1 };
}

const at = (s: EditorState, line: string, cursor: number): EditorState => ({ ...s, line, cursor });

/** Replace start..end with `insert` (a trailing space after a finished word: not a folder, not `--flag=`). */
function insertItem(s: EditorState, line: string, start: number, end: number, insert: string, finished: boolean): EditorState {
  const after = line.slice(end);
  const space = finished && !/[/\\=]$/.test(insert) && !after.startsWith(" ") ? " " : "";
  const next = line.slice(0, start) + insert + space + after;
  return { ...at(s, next, start + insert.length + space.length), list: null };
}

/** The list's item `index` shown in the line (Tab cycles through them); -1: the line as it was. */
function preview(s: EditorState, list: ListState, index: number): EditorState {
  const { original, start, end } = list;
  if (index < 0) return { ...at(s, original.line, original.cursor), list: { ...list, index } };
  const insert = list.items[index].insert;
  const line = original.line.slice(0, start) + insert + original.line.slice(end);
  return { ...at(s, line, start + insert.length), list: { ...list, index } };
}

const listOf = (s: EditorState, c: ConsoleCompletion): ListState => ({ items: c.items, start: c.start, end: c.end, index: -1, original: { line: s.line, cursor: s.cursor } });

function openList(s: EditorState, c: ConsoleCompletion, index: number): EditorState {
  return preview({ ...s, hist: null }, listOf(s, c), index);
}

/** A click on the list's item `i`: inserted, as ↓ … Enter would. */
export function acceptItem(s: EditorState, i: number): EditorState {
  const c = freshCompletion(s);
  const list = s.list ?? (shownItems(s) && c ? listOf(s, c) : null);
  if (!list || !list.items[i]) return s;
  return { ...insertItem(s, list.original.line, list.start, list.end, list.items[i].insert, true), lastTab: null };
}

function moveList(s: EditorState, by: number): EditorState {
  const list = s.list!;
  const n = list.items.length;
  const index = list.index < 0 ? (by > 0 ? 0 : n - 1) : (list.index + by + n) % n;
  return preview(s, list, index);
}

/** Tab: one choice is inserted, several insert what they share; nothing more to add (or a second Tab) opens the list. */
function tab(s: EditorState, c: ConsoleCompletion | null): EditorState {
  if (!c || !c.items.length) return { ...s, lastTab: s.line };
  const typed = s.line.slice(c.start, c.end);
  if (c.items.length === 1) return { ...insertItem(s, s.line, c.start, c.end, c.items[0].insert, true), lastTab: null };
  // loop: NOT-WORTH — a completion's ≤ 200 items, per Tab
  const shared = commonPrefix(c.items.map((i) => i.insert));
  if (shared.length > typed.length && s.lastTab !== s.line) {
    const next = insertItem(s, s.line, c.start, c.end, shared, false);
    return { ...next, lastTab: next.line };
  }
  return { ...openList(s, c, s.mode === "list" ? 0 : -1), lastTab: null };
}

const WORD_BACK = /\S+\s*$/;
/** The start of the word before `i` (Alt+B, Ctrl+W). */
export function wordStart(line: string, i: number): number {
  const m = WORD_BACK.exec(line.slice(0, i));
  return m ? m.index : 0;
}
/** The end of the word after `i` (Alt+F). */
export function wordEnd(line: string, i: number): number {
  const m = /^\s*\S+/.exec(line.slice(i));
  return m ? i + m[0].length : line.length;
}
/** One word of a suggestion (Alt+→): to the end of its next word, or its next path part (`plates/`). */
export function firstWord(text: string): string {
  return /^\s*(?:[^\s/\\]+[/\\]?|[/\\])/.exec(text)?.[0] ?? text;
}

/** Ctrl+R's match: the `skip`-th newest line containing the query. */
function searchMatch(history: readonly string[], query: string, skip: number): string | null {
  if (!query) return null;
  const q = query.toLowerCase();
  // loop: HOT-PATH-OK — ≤ 200 lines, per Ctrl+R keystroke
  const hits = history.filter((l) => l.toLowerCase().includes(q));
  return hits[Math.min(skip, hits.length - 1)] ?? null;
}

function runSearch(s: EditorState, search: SearchState, history: readonly string[]): EditorState {
  const m = searchMatch(history, search.query, search.skip);
  // loop: HOT-PATH-OK — ≤ 200 lines, per Ctrl+R keystroke
  const count = search.query ? history.filter((l) => l.toLowerCase().includes(search.query.toLowerCase())).length : 0;
  const skip = Math.max(0, Math.min(search.skip, count - 1));
  if (m === null) return { ...s, search: { ...search, skip, failed: search.query !== "" } };
  const i = m.toLowerCase().indexOf(search.query.toLowerCase());
  return { ...at(s, m, i < 0 ? m.length : i), search: { ...search, skip, failed: false } };
}

/** Up/Down: lines that start with what was typed (all lines when nothing was), newest first. */
function historyStep(s: EditorState, history: readonly string[], by: 1 | -1): EditorState {
  const h = s.hist ?? { prefix: s.line, index: -1, saved: s.line };
  // loop: HOT-PATH-OK — ≤ 200 lines, per Up/Down
  const matches = history.filter((l) => l.startsWith(h.prefix) && l !== h.prefix);
  const index = h.index + by;
  if (index < 0) return { ...at(s, h.saved, h.saved.length), hist: null };
  if (index >= matches.length) return s.hist ? s : { ...s, hist: null };
  return { ...at(s, matches[index], matches[index].length), hist: { ...h, index }, list: null };
}

/** Typed text (the input's own editing): everything that followed the old line ends. */
export function input(s: EditorState, line: string, cursor: number): EditorState {
  if (s.search) {
    // the input is the match while searching; typing edits the line found
    return { ...at(s, line, cursor), search: null, hist: null, list: null, lastTab: null };
  }
  return { ...at(s, line, cursor), hist: null, list: null, lastTab: null };
}

/** The caret moved (click, ← →, Home, End): only the position. */
export const caret = (s: EditorState, cursor: number): EditorState => (cursor === s.cursor ? s : { ...s, cursor });

/** A completion answered for (line, cursor). */
export const completion = (s: EditorState, line: string, cursor: number, data: ConsoleCompletion): EditorState => ({ ...s, comp: { line, cursor, data } });

/** A line put in the editor from outside (History, Re-run): the cursor at its end, ready to edit. */
export const setLine = (s: EditorState, line: string): EditorState => ({ ...at(s, line, line.length), hist: null, list: null, search: null, lastTab: null });

/** Keys that need the completion for the line as it is now (the component asks first, then calls keyDown). */
export function needsCompletion(k: Key, s: EditorState): boolean {
  if (s.search || s.list) return false;
  return (k.key === "Tab" && !k.ctrl && !k.alt) || (k.ctrl && (k.key === " " || k.key === "Spacebar")) === true;
}

/** Cut from..to into the kill buffer (Ctrl+Y puts it back); an empty cut keeps the last one. */
function cut(s: EditorState, from: number, to: number): EditorState {
  const kill = to > from ? s.line.slice(from, to) : s.kill;
  return { ...at(s, s.line.slice(0, from) + s.line.slice(to), from), kill, hist: null, lastTab: null };
}

/** Text typed in at the cursor. */
function insertAt(s: EditorState, text: string): EditorState {
  if (!text) return s;
  return { ...at(s, s.line.slice(0, s.cursor) + text + s.line.slice(s.cursor), s.cursor + text.length), hist: null, list: null, lastTab: null };
}

const ok = (state: EditorState, effect?: Effect): KeyResult => ({ state, handled: true, effect });
const pass = (state: EditorState): KeyResult => ({ state, handled: false });

/** What a key does. The keymap: docs/GUIDE.md "Console" and the page's Keys section. */
export function keyDown(s0: EditorState, k: Key, ctx: KeyContext): KeyResult {
  const { history } = ctx;
  const ctrl = !!k.ctrl && !k.alt && !k.meta;
  const alt = !!k.alt && !k.ctrl && !k.meta;
  const plain = !k.ctrl && !k.alt && !k.meta;
  // an Alt combination by its physical key (macOS's Option+F types ƒ), else by the key itself
  const altKey = k.code && /^Key[A-Z]$/.test(k.code) ? k.code.slice(3).toLowerCase() : k.code === "Period" ? "." : k.key.toLowerCase();
  let s = s0;

  // --- Ctrl+R: incremental search, newest first ---
  if (s.search) {
    const search = s.search;
    if (ctrl && k.key.toLowerCase() === "r") return ok(runSearch(s, { ...search, skip: search.skip + 1 }, history));
    if ((ctrl && (k.key.toLowerCase() === "g" || k.key.toLowerCase() === "c")) || (plain && k.key === "Escape")) return ok({ ...at(s, search.original.line, search.original.cursor), search: null });
    if (plain && k.key === "Enter") {
      const line = search.failed ? search.original.line : s.line;
      if (!line.trim()) return ok({ ...s, search: null });
      return ok({ ...initialEditor(s.mode, s.autosuggest), kill: s.kill }, { kind: "run", line });
    }
    if (plain && k.key === "Backspace") return ok(runSearch(s, { ...search, query: search.query.slice(0, -1), skip: 0 }, history));
    if (!k.ctrl && !k.alt && !k.meta && k.key.length === 1) return ok(runSearch(s, { ...search, query: search.query + k.key, skip: 0 }, history));
    // any other key takes the line found and does what it does (readline)
    s = { ...s, search: null, cursor: search.failed ? s.cursor : s.line.length };
    if (plain && (k.key === "Tab" || k.key === "ArrowRight" || k.key === "ArrowLeft")) return ok(s);
  }
  if (ctrl && k.key.toLowerCase() === "r") {
    const search: SearchState = { query: "", skip: 0, original: { line: s.line, cursor: s.cursor }, failed: false };
    return ok({ ...s, search, list: null, hist: null });
  }

  // --- the completion list ---
  if (s.list) {
    const n = s.list.items.length;
    if (plain && (k.key === "ArrowDown" || (k.key === "Tab" && !k.shift))) return ok(moveList(s, 1));
    if ((plain && k.key === "ArrowUp") || (k.shift && !k.ctrl && !k.alt && k.key === "Tab")) return ok(moveList(s, -1));
    if (plain && k.key === "PageDown") return ok(moveList(s, Math.min(8, n - 1) || 1));
    if (plain && k.key === "PageUp") return ok(moveList(s, -(Math.min(8, n - 1) || 1)));
    if (plain && k.key === "Escape") return ok({ ...at(s, s.list.original.line, s.list.original.cursor), list: null });
    if (plain && k.key === "Enter") {
      if (s.list.index < 0) return ok({ ...s, list: null });
      const { original, start, end, items, index } = s.list;
      return ok(insertItem(s, original.line, start, end, items[index].insert, true));
    }
  }
  // List mode: the list shown while typing is entered with ↓ or Tab
  const shown = shownItems(s);
  if (!s.list && shown && plain && (k.key === "ArrowDown" || (k.key === "Tab" && !k.shift))) {
    const c = freshCompletion(s)!;
    return ok(openList(s, c, 0));
  }
  if (!s.list && shown && plain && k.key === "Escape") return ok({ ...s, comp: null });

  // --- completion ---
  if (k.key === "Tab" && !k.ctrl && !k.alt && !k.meta) {
    if (k.shift && !s.list) {
      const c = freshCompletion(s);
      return ok(c && c.items.length ? openList(s, c, c.items.length - 1) : s);
    }
    return ok(tab(s, freshCompletion(s)));
  }
  if (ctrl && (k.key === " " || k.key === "Spacebar")) {
    const c = freshCompletion(s);
    return ok(c && c.items.length ? openList(s, c, -1) : s);
  }
  if (plain && k.key === "F2") {
    const mode: SuggestMode = s.mode === "inline" ? "list" : "inline";
    return ok({ ...s, mode, list: null }, { kind: "mode", mode });
  }

  // --- run, stop, clear ---
  if (plain && k.key === "Enter") {
    if (!s.line.trim()) return ok(at(s, "", 0));
    return ok({ ...initialEditor(s.mode, s.autosuggest), kill: s.kill }, { kind: "run", line: s.line });
  }
  if (ctrl && k.key.toLowerCase() === "c") {
    if (ctx.hasSelection) return pass(s); // the input copies it
    if (ctx.running) return ok(s, { kind: "cancel" });
    return ok({ ...initialEditor(s.mode, s.autosuggest), kill: s.kill });
  }
  // Ctrl+L; Cmd+K as in Terminal and iTerm
  if ((ctrl && k.key.toLowerCase() === "l") || (k.meta && !k.ctrl && !k.alt && k.key.toLowerCase() === "k")) return ok(s, { kind: "clear" });

  // --- the suggestion ---
  const sug = suggestion(s, ctx.suggestFrom ?? history);
  if (sug && ((plain && (k.key === "ArrowRight" || k.key === "End")) || (ctrl && k.key.toLowerCase() === "f"))) {
    const line = s.line + sug;
    return ok({ ...at(s, line, line.length), lastTab: null });
  }
  if (sug && ((alt && (k.key === "ArrowRight" || altKey === "f")) || (k.ctrl && !k.alt && k.key === "ArrowRight"))) {
    const line = s.line + firstWord(sug);
    return ok({ ...at(s, line, line.length), lastTab: null });
  }

  // --- history ---
  if (plain && k.key === "ArrowUp") return ok(historyStep(s, history, 1));
  if (plain && k.key === "ArrowDown") return s.hist ? ok(historyStep(s, history, -1)) : ok(s);

  // --- readline ---
  if (ctrl) {
    switch (k.key.toLowerCase()) {
      case "a":
        return ok(at(s, s.line, 0));
      case "e":
        return ok(at(s, s.line, s.line.length));
      case "f":
        return ok(at(s, s.line, Math.min(s.line.length, s.cursor + 1)));
      case "b":
        return ok(at(s, s.line, Math.max(0, s.cursor - 1)));
      case "u":
        return ok(cut(s, 0, s.cursor));
      case "k":
        return ok(cut(s, s.cursor, s.line.length));
      case "w":
        return ok(cut(s, wordStart(s.line, s.cursor), s.cursor));
      case "y":
        return ok(insertAt(s, s.kill));
      case "p":
        return ok(historyStep(s, history, 1));
      case "n":
        return s.hist ? ok(historyStep(s, history, -1)) : ok(s);
      case "d":
        // on an empty line: nothing (a terminal would close; the Console stays); else the character under the cursor
        return ok(s.line ? { ...at(s, s.line.slice(0, s.cursor) + s.line.slice(s.cursor + 1), s.cursor), hist: null, lastTab: null } : s);
    }
  }
  if (alt) {
    switch (k.key === "ArrowLeft" ? "b" : k.key === "ArrowRight" ? "f" : altKey) {
      case "b":
        return ok(at(s, s.line, wordStart(s.line, s.cursor)));
      case "f":
        return ok(at(s, s.line, wordEnd(s.line, s.cursor)));
      case "d":
        return ok(cut(s, s.cursor, wordEnd(s.line, s.cursor)));
      case ".":
        // the last word of the line before (the output path just used): bash's yank-last-arg
        return ok(insertAt(s, /\S+$/.exec((history[0] ?? "").trimEnd())?.[0] ?? ""));
    }
  }
  return s === s0 ? pass(s) : ok(s);
}
