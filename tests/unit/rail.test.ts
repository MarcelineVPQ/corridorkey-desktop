import { describe, expect, it } from "vitest";
import { initialView, isOpen, isPinKey, ITEMS, railKey, railLayout, railPress, RAIL, tabStop, toggleFlags, viewReduce } from "../../src/ui/rail/railModel";

describe("rail model (the house rail)", () => {
  // review N11: the Engine tip named the runtime twice ("the engine's runtime and models … its ONNX Runtime files")
  it("the Engine tip names the runtime once", () => {
    const tip = ITEMS.find((i) => i.id === "engine")!.tip;
    expect(tip.match(/runtime/gi)).toHaveLength(1);
  });
  it("pinned takes its width only with room for the page", () => {
    expect(railLayout(1600, false)).toEqual({ mode: "collapsed", room: RAIL.collapsed });
    expect(railLayout(1600, true)).toEqual({ mode: "pinned", room: RAIL.expanded });
    expect(railLayout(1000, true)).toEqual({ mode: "floating", room: RAIL.collapsed });
  });
  it("opens on hover, closes after a pointer pick until the pointer leaves", () => {
    let v = viewReduce(initialView(), "enter");
    expect(isOpen("collapsed", v, false)).toBe(true);
    v = viewReduce(v, "pick");
    expect(isOpen("collapsed", v, false)).toBe(false);
    v = viewReduce(viewReduce(v, "leave"), "enter");
    expect(isOpen("collapsed", v, false)).toBe(true);
  });
  it("locked never opens; Esc closes keyboard focus until the next key", () => {
    const hover = viewReduce(initialView(), "enter");
    expect(isOpen("collapsed", hover, true)).toBe(false);
    let v = viewReduce(initialView(), "focus-visible");
    v = viewReduce(v, "escape");
    expect(isOpen("collapsed", v, false)).toBe(false);
    expect(isOpen("collapsed", viewReduce(v, "key"), false)).toBe(true);
    expect(isOpen("pinned", initialView(), true)).toBe(true);
  });
  it("pin and lock exclude each other", () => {
    expect(toggleFlags({ pinned: false, locked: true }, "pin")).toEqual({ pinned: true, locked: false });
    expect(toggleFlags({ pinned: true, locked: false }, "lock")).toEqual({ pinned: false, locked: true });
    expect(toggleFlags({ pinned: true, locked: false }, "pin")).toEqual({ pinned: false, locked: false });
  });
  it("keys wrap and leave modified keys alone", () => {
    expect(railKey("ArrowDown", 3, 4)).toEqual({ action: "move", index: 0 });
    expect(railKey("ArrowUp", 0, 4)).toEqual({ action: "move", index: 3 });
    expect(railKey("End", 0, 4)).toEqual({ action: "move", index: 3 });
    expect(railKey("b", 0, 4, { ctrl: true })).toBeNull();
  });
  it("whole review: Ctrl+B pins, but not when a field took it (the Console's Ctrl+B moves the cursor)", () => {
    const k = { key: "b", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false };
    expect(isPinKey(k)).toBe(true);
    expect(isPinKey({ ...k, defaultPrevented: true })).toBe(false);
  });
  it("whole review: one rail item always takes Tab, also on the setup page", () => {
    expect(tabStop("engine")).toBe("engine");
    expect(tabStop("setup")).toBe(ITEMS[0].id);
  });
  it("the page you're on toggles its panel; a task dot leads to its section", () => {
    expect(railPress("queue", "queue", true, null)).toEqual({ page: "queue", panel: "hide", section: null });
    expect(railPress("queue", "queue", false, null)).toEqual({ page: "queue", panel: "show", section: null });
    expect(railPress("engine", "queue", true, null)).toEqual({ page: "engine", panel: "show", section: null });
    expect(railPress("engine", "engine", true, "folder")).toEqual({ page: "engine", panel: "show", section: "folder" });
  });
});
