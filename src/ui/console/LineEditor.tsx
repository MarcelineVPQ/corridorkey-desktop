// The Console's input line (no dependency of its own): an <input> with a highlight layer under it, coloured from the
// shared parser's tokens (an unknown command, a bad flag or value is marked before Enter; a destructive flag reads as a
// warning), the grey suggestion after the cursor, the completion list (an ARIA combobox), Ctrl+R's search, and the
// offer to run several pasted lines as a script. What
// each key does is editor.ts (pure, unit-tested); this component feeds it and carries out its effects.
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { parseLine } from "../../shared/console/script";
import type { Registry } from "../../shared/console/registry";
import {
  acceptItem,
  caret,
  completion,
  freshCompletion,
  initialEditor,
  input,
  keyDown,
  needsCompletion,
  pasted,
  setLine,
  shownItems,
  suggestion,
  type EditorState,
  type Key,
  type SuggestMode,
} from "./editor";
import { expansionHint, highlight, lineHint } from "./model";
import type { HistoryLine } from "../../shared/console/expand";

export interface LineEditorHandle {
  /** put a line in (History, Re-run): ready to edit, never run; several lines (a pasted script's Re-run) are offered again */
  insert(line: string): void;
  focus(): void;
}

interface Props {
  registry: Registry;
  windows: boolean;
  /** lines typed before, newest first, no repeats */
  history: readonly string[];
  /** the same lines with their numbers, newest last (history shortcuts: !!, !N, !$, ^old^new) */
  past: readonly HistoryLine[];
  running: boolean;
  elevated: boolean;
  /** the current folder's last part, for the prompt */
  folder: string;
  mode: SuggestMode;
  autosuggest: boolean;
  onMode: (m: SuggestMode) => void;
  onRun: (line: string) => void;
  /** lines pasted at once, run as a script after the offer was taken */
  onRunLines: (lines: string[]) => void;
  onCancel: () => void;
  onClear: () => void;
}

// the line being typed outlives the page (a switch to the Queue and back keeps it)
let draft: EditorState | null = null;

export const LineEditor = forwardRef<LineEditorHandle, Props>(function LineEditor(props, ref) {
  const { registry, windows, history, running } = props;
  const [s, setS] = useState<EditorState>(() => (draft ? { ...draft, comp: null, list: null, search: null, paste: null } : initialEditor(props.mode, props.autosuggest)));
  const sRef = useRef(s);
  sRef.current = s;
  const inputRef = useRef<HTMLInputElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // the reducer moved the caret: the input follows once rendered
  const placeCaret = useRef(false);
  const asked = useRef(0);
  const ids = useId();
  const listId = `${ids}-list`;
  const hintId = `${ids}-hint`;
  const sugId = `${ids}-sug`;

  const apply = useCallback((next: EditorState, moved: boolean) => {
    placeCaret.current = moved;
    sRef.current = next;
    draft = next;
    setS(next);
  }, []);

  // the settings in the panel (and F2) reach the editor
  useEffect(() => {
    if (sRef.current.mode !== props.mode || sRef.current.autosuggest !== props.autosuggest) apply({ ...sRef.current, mode: props.mode, autosuggest: props.autosuggest, list: null }, false);
  }, [props.mode, props.autosuggest, apply]);

  useImperativeHandle(ref, () => ({
    insert: (line: string) => {
      apply(line.includes("\n") ? pasted(setLine(sRef.current, ""), line) : setLine(sRef.current, line), true);
      inputRef.current?.focus();
    },
    focus: () => inputRef.current?.focus(),
  }));

  // The completion for the line as it is now, asked from the main process (only an answer for the line as it still
  // is counts). One question per (line, cursor) in flight: a second Tab while the first waits shares its answer.
  const inFlight = useRef<{ line: string; cursor: number; answer: Promise<void> } | null>(null);
  const ask = useCallback(
    (line: string, cursor: number): Promise<void> => {
      const f = inFlight.current;
      if (f && f.line === line && f.cursor === cursor) return f.answer;
      const n = ++asked.current;
      const answer = window.ck.consoleComplete(line, cursor).then((data) => {
        const cur = sRef.current;
        if (n === asked.current) inFlight.current = null;
        if (cur.line === line && cur.cursor === cursor) apply(completion(cur, line, cursor, data), false);
      });
      inFlight.current = { line, cursor, answer };
      return answer;
    },
    [apply],
  );

  // the suggestion and List mode need the completion as you type (only then: a path's folder is read per ask)
  useEffect(() => {
    if (s.search || s.list || s.hist || !s.line.trim() || freshCompletion(s)) return;
    if (!(s.mode === "list" || (s.autosuggest && s.cursor === s.line.length))) return;
    void ask(s.line, s.cursor);
  }, [s, ask]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && placeCaret.current) {
      placeCaret.current = false;
      el.setSelectionRange(s.cursor, s.cursor);
    }
    if (el && layerRef.current) layerRef.current.scrollLeft = el.scrollLeft;
  }, [s]);

  // the selected item stays in view
  useLayoutEffect(() => {
    const i = s.list?.index ?? -1;
    if (i >= 0) listRef.current?.children[i]?.scrollIntoView({ block: "nearest" });
  }, [s.list?.index, s.list]);

  // the grey suggestion offers only lines that would run (a typo in the history is never suggested; ↑ and Ctrl+R
  // still find it, to fix)
  // loop: HOT-PATH-OK — ≤ 200 lines parsed once per history change
  const runnable = useMemo(() => history.filter((l) => parseLine(l, registry, { windows }).errors.length === 0), [history, registry, windows]);

  const onKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const k: Key = { key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
    const el = e.currentTarget;
    const ctx = { history, suggestFrom: runnable, hasSelection: el.selectionStart !== el.selectionEnd, running };
    let cur = sRef.current;
    if (needsCompletion(k, cur) && !freshCompletion(cur)) {
      e.preventDefault();
      await ask(cur.line, cur.cursor);
      // keys that waited on the same answer go in order, each on the line the one before left
      cur = sRef.current;
      // the line changed while it was asked: this Tab is spent
      if (needsCompletion(k, cur) && !freshCompletion(cur)) return;
    }
    const r = keyDown(cur, k, ctx);
    if (!r.handled) return;
    e.preventDefault();
    if (r.state !== cur) apply(r.state, true);
    const fx = r.effect;
    if (fx?.kind === "run") props.onRun(fx.line);
    else if (fx?.kind === "script") props.onRunLines(fx.lines);
    else if (fx?.kind === "cancel") props.onCancel();
    else if (fx?.kind === "clear") props.onClear();
    else if (fx?.kind === "mode") props.onMode(fx.mode);
  };

  const parsed = useMemo(() => parseLine(s.line, registry, { windows }), [s.line, registry, windows]);
  const expansion = useMemo(() => expansionHint(s.line, props.past, windows), [s.line, props.past, windows]);
  // a history shortcut isn't a command: the line reads plain, the hint says what Enter runs
  const spans = useMemo(() => (expansion ? [{ text: s.line, kind: "plain" as const }] : highlight(s.line, parsed)), [s.line, parsed, expansion]);
  const sug = suggestion(s, runnable);
  const shown = shownItems(s);
  const hint = s.search ? null : (expansion ?? lineHint(parsed, s.line, s.cursor, registry, Boolean(sug)));
  // the list's names in one column, as wide as the longest (capped)
  // loop: HOT-PATH-OK — ≤ 200 completions, per render while the list is open
  const nameWidth = shown ? Math.min(34, Math.max(8, ...shown.items.map((it) => it.label.length))) : 0;
  // a flag that replaces files reads as a warning in the list too
  // loop: HOT-PATH-OK — a command's ~50 flags, per render while the list is open
  const danger = (label: string) => parsed.command?.args.some((a) => a.destructive && label.startsWith(`--${a.long}`)) ?? false;
  // the offer's buttons do what their keys do
  const paste = (key: "Enter" | "Escape" | "c") => {
    const r = keyDown(sRef.current, { key, ctrl: key === "c" }, { history, hasSelection: false, running });
    apply(r.state, true);
    if (r.effect?.kind === "script") props.onRunLines(r.effect.lines);
    inputRef.current?.focus();
  };
  const pick = (i: number) => {
    apply(acceptItem(sRef.current, i), true);
    inputRef.current?.focus();
  };

  return (
    <div className={`cline ${props.elevated ? "elevated" : ""}`}>
      {shown && (
        <ul ref={listRef} id={listId} className="cline-list" role="listbox" aria-label="Completions" style={{ ["--name-w" as string]: `${nameWidth}ch` }}>
          {/* loop: HOT-PATH-OK — ≤ 200 completions, per render while the list is open */}
          {shown.items.map((it, i) => (
            <li
              key={`${it.insert}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === shown.index}
              className={`cline-opt k-${it.kind} ${danger(it.label) ? "danger" : ""} ${i === shown.index ? "on" : ""}`}
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="opt-name">{it.label}</span>
              {it.help && <span className="opt-help">{it.help}</span>}
            </li>
          ))}
        </ul>
      )}
      {s.paste && (
        <div className="cline-paste" role="group" aria-label={`${s.paste.length} lines pasted`}>
          <span role="status">{s.paste.length} lines pasted: run them in order, as a script? It stops at the first that fails.</span>
          <pre className="cp-lines">{s.paste.join("\n")}</pre>
          <span className="btn-row">
            <button type="button" className="btn small" onMouseDown={(ev) => ev.preventDefault()} onClick={() => paste("Enter")}>
              Run {s.paste.length} lines (Enter)
            </button>
            <button type="button" className="btn small" onMouseDown={(ev) => ev.preventDefault()} onClick={() => paste("Escape")}>
              Keep the first (Esc)
            </button>
            <button type="button" className="btn small" onMouseDown={(ev) => ev.preventDefault()} onClick={() => paste("c")}>
              Drop them (Ctrl+C)
            </button>
          </span>
        </div>
      )}
      {s.search && (
        <div className={`cline-search ${s.search.failed ? "failed" : ""}`} role="status">
          <span className="cs-label">History search</span>
          <span className="cs-query">{s.search.query || " "}</span>
          <span className="cs-keys">{s.search.failed ? "no match" : "Ctrl+R older · Enter runs · Esc cancels"}</span>
        </div>
      )}
      <div className="cline-row">
        <span className="cline-prompt" aria-hidden>
          {props.elevated && <span className="cline-sudo">sudo</span>}
          <span className="cline-folder">{props.folder}</span>
          <span className="cline-caret">{props.elevated ? "#" : "❯"}</span>
        </span>
        <div className="cline-field">
          <div ref={layerRef} className="cline-layer" aria-hidden>
            {/* loop: HOT-PATH-OK — the line's few spans, per keystroke */}
            {spans.map((sp, i) => (
              <span key={i} className={`t-${sp.kind}`}>
                {sp.text}
              </span>
            ))}
            {sug && <span className="t-ghost">{sug}</span>}
          </div>
          <input
            ref={inputRef}
            className="cline-input"
            type="text"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-label={props.elevated ? "Command (elevated)" : "Command"}
            role="combobox"
            aria-autocomplete="both"
            aria-expanded={Boolean(shown)}
            aria-controls={shown ? listId : undefined}
            aria-activedescendant={shown && shown.index >= 0 ? `${listId}-${shown.index}` : undefined}
            aria-describedby={`${hintId} ${sugId}`}
            value={s.line}
            onChange={(e) => apply(input(sRef.current, e.target.value, e.target.selectionStart ?? e.target.value.length), false)}
            onSelect={(e) => {
              const el = e.currentTarget;
              if (layerRef.current) layerRef.current.scrollLeft = el.scrollLeft;
              // a key just moved the caret (placed once rendered): this event saw the input before that
              if (placeCaret.current || el.value !== sRef.current.line) return;
              if (el.selectionStart === el.selectionEnd && el.selectionStart !== null) apply(caret(sRef.current, el.selectionStart), false);
            }}
            onScroll={(e) => layerRef.current && (layerRef.current.scrollLeft = e.currentTarget.scrollLeft)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              // one line: the input takes it; several: offered as a script, never joined into one line
              if (!/[\r\n]/.test(text)) return;
              e.preventDefault();
              apply(pasted(sRef.current, text), true);
            }}
            onKeyDown={(e) => void onKeyDown(e)}
          />
        </div>
      </div>
      <div id={hintId} className={`cline-hint ${hint?.error ? "error" : ""}`}>
        {hint ? hint.text : sug ? `→ takes: ${s.line + sug}` : "Tab completes · → takes the grey suggestion · Ctrl+R searches the history · help lists the commands"}
      </div>
      <span id={sugId} className="sr-only">
        {sug ? `Suggestion: ${s.line + sug}. Right arrow takes it.` : ""}
      </span>
    </div>
  );
});
