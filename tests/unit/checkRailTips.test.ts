import { describe, expect, it } from "vitest";
import { checkAll, missingFromTip, railItems, sectionTitles } from "../../tools/check_rail_tips.mjs";

const SETTINGS = ["Appearance", "Results", "Console", "Graphics memory", "Updates", "Storage"];

describe("the rail tooltip gate", () => {
  it("passes on this repository", () => {
    expect(checkAll()).toEqual([]);
  });

  it("reads the rail's items and a page's sections", () => {
    expect(railItems('export const ITEMS = [\n  { id: "settings", label: "App settings", tip: "Appearance and where results go" },\n];')).toEqual([
      { id: "settings", tip: "Appearance and where results go" },
    ]);
    expect(sectionTitles('<Section id="a" icon={P} title="Appearance" status={s}>\n<Section\n  id="updates"\n  title="Updates"\n>')).toEqual(["Appearance", "Updates"]);
  });

  it("a tip that leaves out a section fails (App settings' before 2026-10-27)", () => {
    expect(missingFromTip("Appearance and where results go", SETTINGS)).toEqual(["Console", "Graphics memory", "Updates", "Storage"]);
    expect(missingFromTip("Appearance, where results go, the Console's folders, graphics memory, updates and storage", SETTINGS)).toEqual([]);
  });
});
