// One command's output block (Warp-style): the line as typed (a refused one marked where it is wrong), its status with
// the exit code and what it means, the CLI's progress (frames handed to the writers, from its own JSON events), what
// it printed (selectable), a folder listing, the paths it wrote (Show in folder), and Copy command / Copy output /
// Re-run (which puts the line back in the input, never runs it). An elevated block is marked.
import { memo, useEffect, useState } from "react";
import { Check, Copy, CornerDownLeft, FolderOpen, ShieldAlert } from "lucide-react";
import type { Registry } from "../../shared/console/registry";
import type { ConsoleBlock } from "../../shared/types";
import { ProgressBar } from "../ProgressBar";
import { blockStatus, blockText, duration, errorSpans, sizeText, writtenPaths } from "./model";

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

const when = (ms: number | null) => (ms === null ? "" : new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }));

export const OutputBlock = memo(function OutputBlock({ b, registry, onReinsert }: { b: ConsoleBlock; registry: Registry; onReinsert: (line: string) => void }) {
  const st = blockStatus(b);
  const took = duration(b);
  const written = b.state === "done" || b.state === "failed" || b.state === "cancelled" ? writtenPaths(b, registry) : [];
  const out = blockText(b);
  return (
    // the line is the user's own input: it labels the block, the live log announces only what the command printed
    <article className={`cblock tone-${st.tone} ${b.elevated ? "elevated" : ""} ${b.parent !== null ? "child" : ""}`} aria-label={b.line}>
      <header className="cb-head">
        <code className="cb-line" aria-hidden>
          {b.elevated && (
            <span className="cb-sudo" title="Ran elevated (sudo)">
              <ShieldAlert size={13} aria-hidden /> sudo
            </span>
          )}
          {/* loop: NOT-WORTH — a line's few spans, per block render */}
          {errorSpans(b.line, b.errors).map((sp, i) => (
            <span key={i} className={`t-${sp.kind}`} title={sp.title}>
              {sp.text}
            </span>
          ))}
        </code>
        <span className="cb-meta">
          <span className={`cb-status ${st.tone}`}>{st.word}</span>
          {st.exit && <span className="cb-exit">{st.exit}</span>}
          {took && <span className="cb-took">{took}</span>}
        </span>
        {st.meaning && <span className={`cb-why ${st.tone}`}>{st.meaning}</span>}
        <span className="cb-actions">
          <CopyButton label="Copy command" text={b.line} />
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
            {b.progress && b.status && " · "}
            {b.status}
          </span>
        </div>
      )}
      {(b.lines.length > 0 || b.linesDropped > 0) && (
        <pre className="cb-out">
          {b.linesDropped > 0 && <span className="l-info">{`… ${b.linesDropped} earlier lines not kept\n`}</span>}
          {/* loop: HOT-PATH-OK — ≤ 2000 lines, per render of a changed block (memo: others don't re-render) */}
          {b.lines.map((l, i) => (
            <span key={i} className={`l-${l.kind}`}>
              {l.text}
              {"\n"}
            </span>
          ))}
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
                <td>{e.folder ? `${e.name}/` : e.name}</td>
                <td>{e.folder ? "folder" : sizeText(e.bytes)}</td>
                <td>{when(e.modified)}</td>
              </tr>
            ))}
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
});
