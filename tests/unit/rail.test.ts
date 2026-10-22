import { describe, expect, it } from "vitest";
import { initialView, isOpen, railKey, railLayout, railPress, RAIL, toggleFlags, viewReduce } from "../../src/ui/rail/railModel";

describe("rail model (the house rail)", () => {
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
  it("the page you're on toggles its panel; a task dot leads to its section", () => {
    expect(railPress("queue", "queue", true, null)).toEqual({ page: "queue", panel: "hide", section: null });
    expect(railPress("queue", "queue", false, null)).toEqual({ page: "queue", panel: "show", section: null });
    expect(railPress("engine", "queue", true, null)).toEqual({ page: "engine", panel: "keep", section: null });
    expect(railPress("engine", "engine", true, "folder")).toEqual({ page: "engine", panel: "show", section: "folder" });
  });
});
