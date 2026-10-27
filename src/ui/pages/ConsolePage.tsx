// Console (backlog row 95, docs/CONSOLE.md, docs/GUIDE.md "Console"): a command line for power users, its own
// commands, never a system shell. Main view: the output blocks in one persistent log, the input line pinned under
// them. Panel: Session (folder, elevation and its countdown, Drop elevation, the corridorkey command line), History
// (searchable; a click puts a line back), Keys, Console settings (the grey suggestion, inline or list completions).
// The main process parses and checks every line again, whatever this page showed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Keyboard, SlidersHorizontal, SquareTerminal, Square, ShieldAlert, Check, X } from "lucide-react";
import type { AppState, ConsoleHistoryEntry } from "../../shared/types";
import { makeRegistry } from "../../shared/console/registry";
import { Accordion, Row, Section, Segmented } from "../panel/Section";
import { SplitView } from "../panel/SplitView";
import { PathText } from "../PathText";
import { shortenPath } from "../paths";
import { usePref } from "../prefs";
import { LineEditor, type LineEditorHandle } from "../console/LineEditor";
import { OutputBlock } from "../console/OutputBlock";
import { uniqueHistory, type SuggestMode } from "../console/editor";
import { announcement, clearScreen, mergeBlocks, visibleBlocks, type BlockList } from "../console/model";

const registry = makeRegistry();

/** The keys, as the Keys section lists them (editor.ts does them). */
export const KEYS: [string, string][] = [
  ["Enter", "Run the line"],
  ["Tab", "Complete: what the choices share; again for the list"],
  ["Shift+Tab, ↑ ↓", "Move in the list; Enter takes, Esc puts the line back"],
  ["Ctrl+Space", "Open the list"],
  ["→, End, Ctrl+F", "Take the grey suggestion (never runs it)"],
  ["Alt+→, Alt+F", "Take one word of it (else: a word forward)"],
  ["↑ ↓, Ctrl+P Ctrl+N", "Earlier lines that start with what you typed"],
  ["Ctrl+R", "Search the history; again for older; Enter runs; Esc or Ctrl+G cancels"],
  ["Alt+.", "Insert the last word of the line before (the path you just used)"],
  ["Ctrl+A, Ctrl+E", "Start, end of the line"],
  ["Alt+B, Alt+←", "A word back (Option on a Mac)"],
  ["Ctrl+U, Ctrl+K", "Cut to the start, to the end"],
  ["Ctrl+W, Alt+D", "Cut the word before, the word after the cursor"],
  ["Ctrl+Y", "Paste back what was cut last"],
  ["Ctrl+D", "Delete the character under the cursor (on an empty line: nothing)"],
  ["Ctrl+C", "Copy the selection; else stop the command; else clear the line"],
  ["Ctrl+L, Cmd+K", "Clear the screen (cls also does)"],
  ["F2", "Completions inline or as a list"],
];

/** m:ss */
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function ConsolePage(props: {
  state: AppState;
  blocks: BlockList;
  setBlocks: (f: (old: BlockList) => BlockList) => void;
  panelShown: boolean;
  narrow: boolean;
  glass: boolean;
  focus: string | null;
  hidePanel: () => void;
}) {
  const { state, blocks, setBlocks } = props;
  const session = state.console;
  const windows = state.system.platform === "win32";
  const [mode, setMode] = usePref<SuggestMode>("ck.console.mode", "inline");
  const [autosuggest, setAutosuggest] = usePref<boolean>("ck.console.autosuggest", true);
  const [history, setHistory] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const editor = useRef<LineEditorHandle>(null);
  const out = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // loop: NOT-WORTH — ≤ 200 entries, per history fetch
  const loadHistory = useCallback(() => void window.ck.consoleHistory("").then((h) => setHistory(uniqueHistory(h.map((e) => e.line)))), []);
  useEffect(() => {
    loadHistory();
    editor.current?.focus();
  }, [loadHistory]);

  // the elevation's countdown: a tick a second, only while elevated
  const elevatedFor = session.elevatedUntil === null ? 0 : session.elevatedUntil - now;
  useEffect(() => {
    if (session.elevatedUntil === null) return;
    setNow(Date.now());
    // lifetime: OK — cleared when the elevation ends or the page closes
    // loop: NOT-WORTH — one tick a second, only while elevated (≤ 15 min)
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session.elevatedUntil]);
  const elevated = session.elevatedUntil !== null && elevatedFor > 0;

  const shown = useMemo(() => visibleBlocks(blocks), [blocks]);
  // the log follows new output while you are at its end; scrolled up, it stays where you are
  useEffect(() => {
    const el = out.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const run = useCallback(
    async (line: string) => {
      stick.current = true;
      const b = await window.ck.consoleRun(line);
      if (b) setBlocks((old) => mergeBlocks(old, [b]));
      loadHistory();
    },
    [setBlocks, loadHistory],
  );
  const runLines = useCallback(
    async (lines: string[]) => {
      stick.current = true;
      const b = await window.ck.consoleRunLines(lines);
      if (b) setBlocks((old) => mergeBlocks(old, [b]));
    },
    [setBlocks],
  );
  const reinsert = useCallback((line: string) => editor.current?.insert(line), []);
  // loop: HOT-PATH-OK — a path's few parts, per render
  const folder = session.cwd === state.system.home ? "~" : (session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd);

  const main = (
    <div className="page-body console-page">
      <div className="page-bar">
        <h1>Console</h1>
        <PathText path={session.cwd} max={60} />
        <span className="spacer" />
        {elevated && (
          <span className="chip warn" title="Commands that replace files run without asking until this ends">
            <ShieldAlert size={14} aria-hidden /> Elevated · {clock(elevatedFor)}
          </span>
        )}
        {session.running && (
          <button type="button" className="btn small" onClick={() => void window.ck.consoleCancel()} title="Stops after the current frame (Ctrl+C); again: at once">
            <Square size={13} aria-hidden /> Stop
          </button>
        )}
      </div>
      <div
        ref={out}
        className="console-out"
        role="region"
        aria-label="Console output"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {shown.length === 0 && (
          <p className="console-intro">
            CorridorKey Console. <code>help</code> lists the commands, <code>render ?</code> explains one. It reads files anywhere and writes only into the folders you chose; a command that replaces
            files runs as <code>sudo …</code>, after you confirm it.
          </p>
        )}
        {/* loop: HOT-PATH-OK — ≤ 200 blocks per render; each is memoised (only a changed block re-renders) */}
        {shown.map((b) => (
          <OutputBlock key={b.id} b={b} registry={registry} onReinsert={reinsert} />
        ))}
      </div>
      {/* the output isn't live (every streamed line and listed row would be read out): this says each command's start and end */}
      <span className="sr-only" role="status">
        {announcement(shown)}
      </span>
      <LineEditor
        ref={editor}
        registry={registry}
        windows={windows}
        history={history}
        running={session.running !== null}
        elevated={elevated}
        folder={folder}
        mode={mode}
        autosuggest={autosuggest}
        onMode={setMode}
        onRun={(line) => void run(line)}
        onRunLines={(lines) => void runLines(lines)}
        onCancel={() => void window.ck.consoleCancel()}
        onClear={() => setBlocks(clearScreen)}
      />
    </div>
  );

  const panel = (
    <Accordion page="console" focus={props.focus}>
      <Section
        id="session"
        icon={SquareTerminal}
        title="Session"
        status={session.running ? `running: ${session.running}` : elevated ? `elevated · ${clock(elevatedFor)} left` : shortenPath(session.cwd, state.system.home, 40)}
      >
        {() => (
          <>
            <Row label="Current folder" hint="cd changes it; relative paths start here">
              <PathText path={session.cwd} />
            </Row>
            <Row label="Elevation" hint="sudo: commands that replace files, after you confirm">
              {elevated ? (
                <div className="btn-row">
                  <span className="chip warn">
                    <ShieldAlert size={14} aria-hidden /> Elevated · {clock(elevatedFor)} left
                  </span>
                  <button type="button" className="btn small" onClick={() => void window.ck.consoleElevationDrop()}>
                    Drop elevation
                  </button>
                </div>
              ) : (
                <span className="hint-text">Not elevated. Elevation also ends when the screen locks, the computer sleeps, and at quit.</span>
              )}
            </Row>
            <Row label="corridorkey">
              {session.cliFound ? (
                <div className="check-line ok">
                  <Check size={15} aria-hidden /> Found: render, verify, prepare and info run here
                </div>
              ) : (
                <div className="check-line error">
                  <X size={15} aria-hidden /> Not in this copy: render, verify, prepare and info can&apos;t run (the other commands work)
                </div>
              )}
            </Row>
            {session.running && (
              <Row label="Running">
                <div className="btn-row">
                  <code className="console-code">{session.running}</code>
                  <button type="button" className="btn small" onClick={() => void window.ck.consoleCancel()}>
                    <Square size={13} aria-hidden /> Stop
                  </button>
                </div>
              </Row>
            )}
          </>
        )}
      </Section>
      <Section id="history" icon={History} title="History" status={history.length ? `${history.length} recent lines` : "nothing yet"}>
        {() => <HistoryBox onPick={reinsert} />}
      </Section>
      <Section id="keys" icon={Keyboard} title="Keys" status="Tab, →, Ctrl+R and the readline keys">
        {() => (
          <table className="console-keys">
            <tbody>
              {/* loop: NOT-WORTH — eighteen rows */}
              {KEYS.map(([k, what]) => (
                <tr key={k}>
                  <th scope="row">
                    <kbd>{k}</kbd>
                  </th>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <Section id="settings" icon={SlidersHorizontal} title="Console settings" status={`suggestions ${autosuggest ? "on" : "off"} · ${mode === "inline" ? "inline" : "list"} completions`}>
        {() => (
          <>
            <Row label="Grey suggestions" hint="From your history, then the commands; → takes one">
              <Segmented
                label="Grey suggestions"
                value={autosuggest ? "on" : "off"}
                options={[
                  ["on", "On"],
                  ["off", "Off"],
                ]}
                onChange={(v) => setAutosuggest(v === "on")}
              />
            </Row>
            <Row label="Completions" hint="Inline: Tab completes, again for the list. List: shown as you type. F2 switches">
              <Segmented
                label="Completions"
                value={mode}
                options={[
                  ["inline", "Inline"],
                  ["list", "List"],
                ]}
                onChange={setMode}
              />
            </Row>
          </>
        )}
      </Section>
    </Accordion>
  );

  return (
    <SplitView
      main={main}
      panel={panel}
      panelTitle="Console"
      panelSub="Its own commands, never a system shell"
      shown={props.panelShown}
      narrow={props.narrow}
      glass={props.glass}
      onEscape={props.hidePanel}
    />
  );
}

/** History: the lines typed before, newest first, filtered as you type (the line or its folder), each with its number
 * and how it ended (✓ / ✗ and the exit code); a click puts one in the input. */
function HistoryBox({ onPick }: { onPick: (line: string) => void }) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<ConsoleHistoryEntry[]>([]);
  useEffect(() => {
    let live = true;
    void window.ck.consoleHistory(query).then((h) => live && setEntries(h));
    return () => {
      live = false;
    };
  }, [query]);
  return (
    <>
      <input type="search" className="console-search" placeholder="Search the history" aria-label="Search the history" value={query} onChange={(e) => setQuery(e.target.value)} />
      {entries.length ? (
        <ul className="console-history">
          {/* loop: NOT-WORTH — ≤ 200 lines, per search */}
          {entries.map((e) => (
            <li key={e.n}>
              <button type="button" title={`Put this line in the input${e.cwd ? ` (typed in ${e.cwd})` : ""}`} onClick={() => onPick(e.line)}>
                <span className="ch-n">{e.n}</span>
                <span className={`ch-end ${e.state === "done" ? "ok" : e.state ? "error" : ""}`}>{historyEnd(e)}</span>
                {e.line}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint-text">{query ? "Nothing matches." : "No lines yet."}</p>
      )}
    </>
  );
}

/** ✓ (done), ✗ and the exit code (failed, refused, stopped), or nothing while unknown. */
export function historyEnd(e: Pick<ConsoleHistoryEntry, "state" | "exit">): string {
  if (e.state === null) return "";
  return e.state === "done" ? "✓" : `✗${e.exit !== null ? ` ${e.exit}` : ""}`;
}
