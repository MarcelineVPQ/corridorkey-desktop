// The navigation rail's pure logic (no DOM): its sizes, open/closed state,
// keyboard map, pin/lock rules and items. Modeled on the DS5 app's AppRail and
// Sonata's rail-model.js (the house rail): right edge, icons only, expands
// over the page on hover or keyboard focus, closes right after a pointer
// pick; pinned it takes its full width (Ctrl+B). Tested in tests/unit/rail.test.ts.
import type { PageId } from "../../shared/tasks";

// DS5 density: 52 px icon column, 196 px open, 36 px rows (hit targets ≥ 32 px).
export const RAIL = { collapsed: 52, expanded: 196, minContent: 900, row: 36 } as const;

export interface RailItem {
  id: Exclude<PageId, "setup">; // the setup page opens by itself, never from the rail
  label: string;
  tip: string;
}

export const ITEMS: RailItem[] = [
  { id: "queue", label: "Queue", tip: "Your clips, their settings and results" },
  { id: "engine", label: "Engine", tip: "The engine: its ONNX Runtime and models, TensorRT, ffmpeg, its program and file locations, and the graphics card" },
  { id: "console", label: "Console", tip: "A command line for power users: its own commands, never a system shell" },
  { id: "settings", label: "App settings", tip: "Appearance, where results go, the Console's folders, graphics memory, updates and storage" },
  { id: "about", label: "About", tip: "Guide, changes, credits and licence" },
];

/** Pinned with room: full width. Pinned without room (content < minContent): it floats like unpinned. */
export function railLayout(windowWidth: number, pinned: boolean): { mode: "collapsed" | "pinned" | "floating"; room: number } {
  if (!pinned) return { mode: "collapsed", room: RAIL.collapsed };
  if (windowWidth - RAIL.expanded >= RAIL.minContent) return { mode: "pinned", room: RAIL.expanded };
  return { mode: "floating", room: RAIL.collapsed };
}

// hover: the pointer is over the rail; focusVisible: keyboard focus inside;
// picked: an item was just clicked with the pointer, so it closes like a menu
// and hover doesn't reopen it until the pointer leaves and comes back;
// dismissed: Esc closed it while focus stays inside.
export interface RailView {
  hover: boolean;
  focusVisible: boolean;
  picked: boolean;
  dismissed: boolean;
}
export const initialView = (): RailView => ({ hover: false, focusVisible: false, picked: false, dismissed: false });

export type RailEvent = "enter" | "leave" | "focus-visible" | "focus-pointer" | "blur" | "pick" | "escape" | "key";

export function viewReduce(v: RailView, type: RailEvent): RailView {
  switch (type) {
    case "enter":
      return { ...v, hover: true, dismissed: false };
    case "leave":
      return { ...v, hover: false, picked: false };
    case "focus-visible":
      return { ...v, focusVisible: true };
    case "focus-pointer":
      return { ...v, focusVisible: false };
    case "blur":
      return { ...v, focusVisible: false, dismissed: false };
    case "pick":
      return { ...v, picked: true, focusVisible: false };
    case "escape":
      return { ...v, dismissed: true };
    case "key":
      return { ...v, dismissed: false, focusVisible: true };
  }
}

/** Labels shown? Pinned with room: always. Locked: never. Else hover (unless just picked) or keyboard focus, not after Esc. */
export function isOpen(mode: "collapsed" | "pinned" | "floating", v: RailView, locked: boolean): boolean {
  if (mode === "pinned") return true;
  if (locked || v.dismissed) return false;
  return (v.hover && !v.picked) || v.focusVisible;
}

/** Roving focus between the rail's buttons. null = not ours, let the key through. */
export function railKey(key: string, index: number, count: number, mods: { ctrl?: boolean; alt?: boolean; meta?: boolean } = {}): { action: "move"; index: number } | { action: "escape" } | null {
  if (mods.ctrl || mods.alt || mods.meta || !count) return null;
  const i = Math.max(0, Math.min(count - 1, index | 0));
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return { action: "move", index: (i + 1) % count };
    case "ArrowUp":
    case "ArrowLeft":
      return { action: "move", index: (i - 1 + count) % count };
    case "Home":
      return { action: "move", index: 0 };
    case "End":
      return { action: "move", index: count - 1 };
    case "Escape":
      return { action: "escape" };
    default:
      return null;
  }
}

/** Pin and lock exclude each other: keeping it open unlocks it, locking it unpins it. */
export function toggleFlags(flags: { pinned: boolean; locked: boolean }, which: "pin" | "lock"): { pinned: boolean; locked: boolean } {
  if (which === "pin") return flags.pinned ? { pinned: false, locked: flags.locked } : { pinned: true, locked: false };
  return flags.locked ? { pinned: flags.pinned, locked: false } : { pinned: false, locked: true };
}

/**
 * A rail item pressed: the page you're on toggles its settings panel (the one
 * way to show or hide it, every page alike); another page opens with its panel
 * shown (shown is the default). A task dot leads to its section: the page opens
 * there with the panel shown.
 */
export function railPress(pressed: PageId, active: PageId, panelShown: boolean, target: string | null): { page: PageId; panel: "show" | "hide"; section: string | null } {
  if (target) return { page: pressed, panel: "show", section: target };
  if (pressed === active) return { page: active, panel: panelShown ? "hide" : "show", section: null };
  return { page: pressed, panel: "show", section: null };
}
