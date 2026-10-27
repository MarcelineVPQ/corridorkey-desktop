// One command's output block (Warp-style): the line as typed (a refused one marked where it is wrong), its status with
// the exit code and what it means, the CLI's progress (frames handed to the writers, from its own JSON events), what
// it printed (selectable), a folder listing, the paths it wrote (Show in folder), and Copy command / Copy output /
// Re-run (which puts the line back in the input, never runs it), shown on hover and on keyboard focus. An elevated
// block is marked; a built-in's is compact. A program's commands are one row each (a button: click or Enter shows the
// whole block; Collapse folds it again), and one that runs, failed or was refused shows whole on its own.
import { memo, useContext, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, CornerDownLeft, FolderOpen, ShieldAlert } from "lucide-react";
import type { Registry } from "../../shared/console/registry";
import type { ConsoleBlock } from "../../shared/types";
import { ProgressBar } from "../ProgressBar";
import { commandLine } from "../../shared/console/jobCommand";
import { fileSizeText } from "../../shared/units";
import {
  blockStatus,
  blockText,
  childOpens,
  childRow,
  compactBlock,
  DOCTOR_MARK,
  duration,
  entryTitle,
  errorSpans,
  isoTime,
  lineWords,
  rateText,
  sequenceCell,
  shortenKnown,
  writtenPaths,
} from "./model";
import { HomeContext } from "../PathText";

const COPIED_MS = 1500;

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    // lifetime: OK — one timer per copy, cleared on unmount or the next copy
    // loop: NOT-WORTH — one 1.5 s timer per Copy press
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button type="button" className="copy-btn" onClick={() => void window.ck.copyText(text).then(setCopied)}>
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

type BlockProps = { b: ConsoleBlock; registry: Registry; windows: boolean; onReinsert: (line: string) => void };

export const OutputBlock = memo(function OutputBlock(props: BlockProps) {
  const { b } = props;
  // a program's command: null follows childOpens (running, failed, refused), else what the user chose
  const [open, setOpen] = useState<boolean | null>(null);
  const home = useContext(HomeContext);
  if (b.parent === null) return <FullBlock {...props} onCollapse={null} />;
  if (open ?? childOpens(b)) return <FullBlock {...props} onCollapse={() => setOpen(false)} />;
  const st = blockStatus(b);
  const row = childRow(b, home);
  const took = duration(b);
  return (
    <article className={`cblock child row tone-${st.tone}`} aria-label={b.line}>
      <button type="button" className="cb-row" aria-expanded={false} title="Show the whole block" onClick={() => setOpen(true)}>
        <ChevronRight size={13} aria-hidden />
        <span className={`cb-mark ${st.tone}`} aria-hidden>
          {row.mark}
        </span>
        <span className="sr-only">{st.word}</span>
        <code className="cb-row-line">{b.line}</code>
        {row.source !== null && <span className="cb-row-from">{row.source}</span>}
        {took && <span className="cb-took">{took}</span>}
        {row.last !== null && (
          <span className="cb-row-last" title={row.last !== row.full ? (row.full ?? undefined) : undefined}>
            {row.last}
          </span>
        )}
      </button>
    </article>
  );
});

function FullBlock({ b, registry, windows, onReinsert, onCollapse }: BlockProps & { onCollapse: (() => void) | null }) {
  const st = blockStatus(b);
  // the corridorkey line this block ran, for a terminal or a farm task (the Console's own flags left out)
  const farm = b.command ? commandLine(b.command, windows) : null;
  const took = duration(b);
  const written = b.state === "done" || b.state === "failed" || b.state === "cancelled" ? writtenPaths(b, registry) : [];
  const out = blockText(b);
  const home = useContext(HomeContext);
  return (
    // the line is the user's own input: it labels the block, the live log announces only what the command printed
    <article className={`cblock tone-${st.tone} ${b.elevated ? "elevated" : ""} ${b.parent !== null ? "child" : ""} ${compactBlock(b) ? "compact" : ""}`} aria-label={b.line}>
      <header className="cb-head">
        {onCollapse && (
          <button type="button" className="cb-collapse" aria-expanded={true} title="Fold this command into one row" onClick={onCollapse}>
            <ChevronDown size={13} aria-hidden />
            <span className="sr-only">Collapse</span>
          </button>
        )}
        <code className="cb-line" aria-hidden>
          {b.elevated && (
            <span className="cb-sudo" title="Ran elevated (sudo)">
              <ShieldAlert size={13} aria-hidden /> sudo
            </span>
          )}
          {/* loop: NOT-WORTH — a line's few words, per block render; it wraps only between them */}
          {lineWords(errorSpans(b.line, b.errors)).map((w, i) =>
            typeof w === "string" ? (
              w
            ) : (
              <span key={i} className="cb-word">
                {/* loop: NOT-WORTH — one word's one or two spans */}
                {w.map((sp, j) => (
                  <span key={j} className={`t-${sp.kind}`} title={sp.title}>
                    {sp.text}
                  </span>
                ))}
              </span>
            ),
          )}
        </code>
        <span className="cb-meta">
          <span className={`cb-status ${st.tone}`}>{st.word}</span>
          {st.exit && <span className="cb-exit">{st.exit}</span>}
          {took && <span className="cb-took">{took}</span>}
        </span>
        {st.meaning && <span className={`cb-why ${st.tone}`}>{st.meaning}</span>}
        {b.echo && <span className="cb-why ok">{b.echo}</span>}
        <span className="cb-actions">
          <CopyButton label="Copy command" text={b.line} />
          {farm && "line" in farm && <CopyButton label="Copy as farm line" text={farm.line} />}
          {farm && "error" in farm && (
            <button type="button" className="copy-btn" disabled title={farm.error}>
              <Copy size={13} aria-hidden /> Copy as farm line
            </button>
          )}
          {out && <CopyButton label="Copy output" text={out} />}
          <button type="button" className="copy-btn" title="Put this line back in the input to edit or run it" onClick={() => onReinsert(b.line)}>
            <CornerDownLeft size={13} aria-hidden /> Re-run
          </button>
        </span>
      </header>
      {(b.progress || (b.state === "running" && b.status)) && (
        <div className="cb-progress">
          {b.progress && <ProgressBar value={b.progress.done} max={b.progress.total} />}
          <span className="cb-phase">
            {b.progress && `${b.progress.done} / ${b.progress.total} frames · ${Math.floor(b.progress.percent)} %`}
            {b.progress && b.rate && b.state === "running" && ` · ${rateText(b.rate)}`}
            {b.progress && b.status && " · "}
            {b.status}
          </span>
        </div>
      )}
      {(b.lines.length > 0 || b.linesDropped > 0) && (
        <pre className={`cb-out ${b.nowrap ? "nowrap" : ""}`}>
          {b.linesDropped > 0 && <span className="l-info">{`… ${b.linesDropped} earlier lines not kept\n`}</span>}
          {/* loop: HOT-PATH-OK — ≤ 2000 lines, per render of a changed block (memo: others don't re-render) */}
          {b.lines.map((l, i) => {
            // a known long path (dir's folder) shown short; the whole line on hover and in Copy output
            const shown = shortenKnown(l.text, b.paths, home);
            return (
              <span key={b.linesDropped + i} className={`l-${l.kind}`} title={shown !== l.text ? l.text : undefined}>
                {shown}
                {"\n"}
              </span>
            );
          })}
        </pre>
      )}
      {b.entries && b.entries.length > 0 && (
        <table className="cb-dir">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Size</th>
              <th scope="col">Modified</th>
            </tr>
          </thead>
          <tbody>
            {/* loop: HOT-PATH-OK — ≤ 5000 rows, once per listing (memo) */}
            {b.entries.map((e) => (
              <tr key={e.name} className={e.folder ? "folder" : ""}>
                {/* one line: a long name ends in … (never broken inside a number), whole on hover; a sequence's gaps on hover */}
                <td title={entryTitle(e)}>
                  {e.folder ? `${e.name}/` : e.name}
                  {e.sequence && <span className="cb-seq">{sequenceCell(e.sequence).text}</span>}
                </td>
                <td>{e.folder ? "folder" : fileSizeText(e.bytes)}</td>
                <td>{isoTime(e.modified)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {b.doctor && b.doctor.length > 0 && (
        <table className="cb-doctor">
          <tbody>
            {/* loop: NOT-WORTH — doctor's dozen rows */}
            {b.doctor.map((r) => {
              const detail = shortenKnown(r.detail, r.path ? [r.path] : null, home);
              return (
                <tr key={r.check + r.detail} className={r.status}>
                  <td className="cbd-mark" aria-label={r.status === "ok" ? "ok" : r.status === "warn" ? "warning" : "problem"}>
                    {DOCTOR_MARK[r.status]}
                  </td>
                  <th scope="row">{r.check}</th>
                  <td title={detail !== r.detail ? r.detail : undefined}>
                    <span className="cbd-detail">{detail}</span>
                    {r.fix && r.status !== "ok" && <span className="cbd-fix">fix: {r.fix}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {written.length > 0 && (
        <div className="cb-paths">
          {/* loop: NOT-WORTH — one to three written paths */}
          {written.map((w) => (
            <button key={w.flag + w.path} type="button" className="copy-btn" title={`Show ${w.path} in the file manager`} onClick={() => void window.ck.showInFolder(w.path)}>
              <FolderOpen size={13} aria-hidden /> {w.flag} <span className="cb-path">{w.path}</span>
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
