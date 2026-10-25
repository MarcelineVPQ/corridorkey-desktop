// A path on screen (UI pass 2026-10-25): shortened (home as ~, the middle as …; paths.ts) to the room it has, the
// full path as its tooltip, and a Copy button that puts the full path on the clipboard and says "Copied" for a moment.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { shortenPath } from "./paths";

/** The home folder (AppState.system.home), provided once by App. */
export const HomeContext = createContext("");

/** How long the button says "Copied". */
const COPIED_MS = 1500;
/** Never shorter than this: below it a path says nothing (the line wraps instead). */
const MIN_CHARS = 16;

// the width of one character of a path's (monospace) font, per font
const charWidths = new Map<string, number>();
function charWidth(el: HTMLElement): number {
  const font = getComputedStyle(el).font;
  let w = charWidths.get(font);
  if (w === undefined) {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) ctx.font = font;
    w = ctx ? ctx.measureText("0123456789").width / 10 : 8;
    charWidths.set(font, w);
  }
  return w;
}

/** The characters that fit between the path's start and its line's end, less what follows it on the line. */
function roomFor(wrap: HTMLElement, path: HTMLElement): number {
  const line = wrap.parentElement;
  if (!line) return Infinity;
  let right = line.getBoundingClientRect().right - parseFloat(getComputedStyle(line).paddingRight || "0");
  // loop: NOT-WORTH — the few elements after a path on its line (a Copy and a Clear button), per resize
  for (let n = wrap.nextElementSibling; n; n = n.nextElementSibling) right -= n.getBoundingClientRect().width + 8;
  const button = wrap.lastElementChild as HTMLElement | null;
  const free = right - path.getBoundingClientRect().left - (button?.getBoundingClientRect().width ?? 0) - 8;
  return Math.floor(free / charWidth(path));
}

export function PathText({ path, max = 80 }: { path: string; max?: number }) {
  const home = useContext(HomeContext);
  const [copied, setCopied] = useState(false);
  const [room, setRoom] = useState(max);
  const wrap = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const w = wrap.current;
    const t = text.current;
    const line = w?.parentElement;
    if (!w || !t || !line) return;
    const fit = () => setRoom(Math.max(MIN_CHARS, Math.min(max, roomFor(w, t))));
    fit();
    // lifetime: OK — one observer per path shown, disconnected on unmount
    // loop: NOT-WORTH — fires only when the path's line changes width (a window or panel resize)
    const ro = new ResizeObserver(fit);
    ro.observe(line);
    return () => ro.disconnect();
  }, [max, path]);
  useEffect(() => {
    if (!copied) return;
    // lifetime: OK — one timer per copy, cleared on unmount or the next copy
    // loop: NOT-WORTH — one 1.5 s timer per Copy press
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <span ref={wrap} className="path-text">
      <span ref={text} className="path" title={path}>
        {shortenPath(path, home, room)}
      </span>
      <button type="button" className="copy-btn" title={`Copy the full path:\n${path}`} onClick={() => void window.ck.copyText(path).then(setCopied)}>
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </span>
  );
}
