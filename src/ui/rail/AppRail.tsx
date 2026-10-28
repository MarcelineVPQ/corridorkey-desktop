// The navigation rail (the house rail: DS5's AppRail, Sonata's rail): on the
// right edge, icons only by default, expanding over the page on hover or
// keyboard focus and closing right after a page is picked with the pointer;
// pinned open it takes its full width. Ctrl+B pins/unpins. The bottom shows
// the engine's state (a dot plus a symbol, never color alone: ✓ ready, … starting, ! failed, – idle; its words
// beside it when the rail is open, as a tooltip and to screen readers when it isn't), the graphics card while a job runs,
// the pin, and in the bottom corner the lock: locked, the rail stays
// collapsed (hover and focus no longer expand it). Pin and lock exclude each
// other; both remembered. A task waiting on a page puts a dot on its item; a
// press leads to it (tasks.ts). The behavior is railModel.ts.
// Idle cost: none (CSS states; no timers, no polling; one keydown listener).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Activity, Cpu, Info, ListVideo, Lock, LockOpen, PanelRightClose, PanelRightOpen, Settings, SquareTerminal } from "lucide-react";
import type { AppState } from "../../shared/types";
import type { PageId } from "../../shared/tasks";
import { NO_VRAM_HELD } from "../../shared/texts";
import { ITEMS, RAIL, initialView, isOpen, isPinKey, railKey, railLayout, tabStop, toggleFlags, viewReduce, type RailEvent } from "./railModel";
import { usePref } from "../prefs";
import { useGlass } from "../glass/useGlass";
import { CLEAR_GLASS_RAIL, REGULAR_GLASS } from "../glass/variants";
import { gib } from "../format";

const ICONS = { queue: ListVideo, engine: Activity, console: SquareTerminal, settings: Settings, about: Info } as const;

export function AppRail(props: { state: AppState; page: PageId; pageDots: Partial<Record<PageId, string>>; onPress: (page: PageId) => void; glass: boolean; windowWidth: number }) {
  const { state, page, pageDots, onPress, glass, windowWidth } = props;
  const [flags, setFlags] = usePref("ck.rail", { pinned: false, locked: false });
  const [view, setView] = useState(initialView);
  const send = (e: RailEvent) => setView((v) => viewReduce(v, e));
  const layout = railLayout(windowWidth, flags.pinned);
  const open = isOpen(layout.mode, view, flags.locked);
  const navRef = useRef<HTMLElement | null>(null);
  const glassRef = useGlass(glass, CLEAR_GLASS_RAIL, REGULAR_GLASS);
  // One stable ref: an inline ref re-attaches the glass every render, and with
  // Glass on that re-render loops (React error 185, found by the isolated check).
  const navCallback = useCallback(
    (n: HTMLElement | null) => {
      navRef.current = n;
      glassRef(n);
    },
    [glassRef],
  );
  const pointerDown = useRef(false);

  // Ctrl+B (⌘B on macOS) pins/unpins, from anywhere in the window (not when a field took it: isPinKey).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (isPinKey(e)) {
        e.preventDefault();
        setFlags((f) => toggleFlags(f, "pin"));
      }
    };
    // lifetime: OK — one listener, removed on unmount
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setFlags]);

  const buttons = () => [...(navRef.current?.querySelectorAll<HTMLButtonElement>("button[data-rail]") ?? [])];
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const all = buttons();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const r = railKey(e.key, at, all.length, { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
    if (!r) return;
    e.preventDefault();
    if (r.action === "escape") return send("escape");
    send("key");
    all[r.index]?.focus();
  };

  const press = (id: PageId) => {
    if (pointerDown.current) send("pick");
    onPress(id);
  };

  const e = state.engine;
  const engineLine =
    e.status === "ready"
      ? {
          cls: "ok",
          sym: "✓",
          text: "Engine ready",
          sub: `${e.pong?.engine ?? ""} · ${e.pong?.provider ?? ""} ${e.pong?.precision ?? ""}`.trim(),
        }
      : e.status === "starting"
        ? { cls: "warn", sym: "…", text: "Engine starting", sub: "starting ONNX Runtime" }
        : e.status === "failed"
          ? { cls: "error", sym: "!", text: "Engine failed", sub: "see Engine" }
          : { cls: "idle", sym: "–", text: "Engine idle", sub: NO_VRAM_HELD };
  const g = state.gpu;

  return (
    <div className={`rail-slot ${layout.mode === "pinned" ? "pinned" : ""}`} style={{ ["--rail-w-collapsed" as string]: `${RAIL.collapsed}px`, ["--rail-w-expanded" as string]: `${RAIL.expanded}px` }}>
      <nav
        ref={navCallback}
        className={`app-rail ${open ? "open" : ""} ${glass ? "glass" : ""}`}
        aria-label="CorridorKey"
        onPointerEnter={() => send("enter")}
        onPointerLeave={() => send("leave")}
        onPointerDown={() => (pointerDown.current = true)}
        // loop: NOT-WORTH — one zero-delay timer per pointer-up on the rail
        onPointerUp={() => setTimeout(() => (pointerDown.current = false))}
        onFocus={(ev) => send(ev.target.matches(":focus-visible") ? "focus-visible" : "focus-pointer")}
        onBlur={(ev) => {
          if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) send("blur");
        }}
        onKeyDown={onKeyDown}
      >
        <div className="rail-nav">
          {/* loop: HOT-PATH-OK — the rail's few items per render */}
          {ITEMS.map((it) => {
            const Icon = ICONS[it.id];
            const waiting = pageDots[it.id];
            const active = it.id === page;
            return (
              <button
                key={it.id}
                type="button"
                data-rail={it.id}
                className={`rail-link ${active ? "active" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-description={waiting ? `Waiting: ${waiting}` : undefined}
                title={waiting ? `${it.label}\n${waiting}` : open ? it.tip : it.label}
                tabIndex={it.id === tabStop(page) ? 0 : -1}
                onClick={() => press(it.id)}
              >
                <span className="rail-ic">
                  <Icon size={19} aria-hidden />
                  {waiting && <i className="task" aria-hidden />}
                </span>
                <span className="rail-label">{it.label}</span>
              </button>
            );
          })}
        </div>
        <div className="rail-footer">
          <div className={`rail-status ${engineLine.cls}`} role="status" aria-label={`${engineLine.text} · ${engineLine.sub}`} title={`${engineLine.text}\n${engineLine.sub}`}>
            <span className="rail-ic">
              <span className="rail-dot" aria-hidden>
                {engineLine.sym}
              </span>
            </span>
            <span className="rail-label rail-status-text">
              <span>{engineLine.text}</span>
              <span className="rail-status-sub">{engineLine.sub}</span>
            </span>
          </div>
          {g && state.queueRunning && (
            <div className="rail-status" title={`${g.name}: ${gib(g.usedMb)} of ${gib(g.totalMb)} used, ${g.utilization}% busy`}>
              <span className="rail-ic">
                <Cpu size={17} aria-hidden />
              </span>
              <span className="rail-label rail-status-text">
                <span>{g.name.replace(/^NVIDIA (GeForce )?/, "")}</span>
                <span className="rail-status-sub">
                  {gib(g.usedMb)} / {gib(g.totalMb)} · {g.utilization}%
                </span>
              </span>
            </div>
          )}
          <button
            type="button"
            data-rail="pin"
            className="rail-link"
            aria-pressed={flags.pinned}
            tabIndex={-1}
            title={flags.pinned ? "Collapse the rail (Ctrl+B)" : "Keep the rail open (Ctrl+B)"}
            onClick={() => setFlags((f) => toggleFlags(f, "pin"))}
          >
            <span className="rail-ic">{flags.pinned ? <PanelRightClose size={18} aria-hidden /> : <PanelRightOpen size={18} aria-hidden />}</span>
            <span className="rail-label">{flags.pinned ? "Collapse" : "Keep open"}</span>
          </button>
          <button
            type="button"
            data-rail="lock"
            className="rail-lock"
            aria-pressed={flags.locked}
            aria-label={flags.locked ? "Unlock the rail" : "Lock the rail collapsed"}
            title={flags.locked ? "Locked: icons only. Click to let it open on hover again" : "Lock it collapsed: icons only, it won't open on hover"}
            tabIndex={-1}
            onClick={() => setFlags((f) => toggleFlags(f, "lock"))}
          >
            {flags.locked ? <Lock size={13} aria-hidden /> : <LockOpen size={13} aria-hidden />}
          </button>
        </div>
      </nav>
    </div>
  );
}
