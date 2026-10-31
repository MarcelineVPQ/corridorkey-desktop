// One page layout, one accordion (Marcy, deliberate in all her apps): every rail page is a SplitView, its main
// view on the left and its settings panel on the right, and the panel holds that page's settings as the one
// accordion (panel/Section.tsx). Every tab works and looks the same. UI pass B (97cd7fc, 2026-10-25) moved Engine
// and App settings out of the panel into a second layout; Marcy: one framework, one piece of code drives
// the accordion; it was put back. This gate fails on that code. The setup page is the one exception: it opens by
// itself, never from the rail (railModel.ts), a gate screen like the DS5 app's first-time setup.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = new URL("../../src/ui/", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(UI, rel), "utf8");

const pageIds = [...(/export type PageId = ([^;]+);/.exec(readFileSync(join(UI, "../shared/tasks.ts"), "utf8"))?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
const railPages = pageIds.filter((p) => p !== "setup");

// which component App.tsx renders for each page, and the file it comes from
const app = read("App.tsx");
const fileOf = (page: string) => {
  const comp = new RegExp(`page === "${page}" && <(\\w+)`).exec(app)?.[1];
  const from = comp && new RegExp(`import \\{ ${comp} \\} from "\\./([\\w/]+)"`).exec(app)?.[1];
  return from ? `${from}.tsx` : null;
};

// the files a page imports from src/ui (one level: the Queue's panel is JobSettings)
const localImports = (rel: string) => [...read(rel).matchAll(/from "(\.\.?\/[\w/]+)"/g)].map((m) => join(rel, "..", m[1]) + ".tsx").filter((f) => !f.startsWith(".."));

const allTsx = (dir = ""): string[] =>
  readdirSync(join(UI, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allTsx(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));

describe("one page layout, one accordion on every tab", () => {
  it("knows the rail pages", () => {
    expect(railPages).toEqual(["queue", "engine", "console", "settings", "about"]);
  });

  it("the layout module has one page layout (SplitView) and nothing else that lays out a page", () => {
    const exported = [...read("panel/SplitView.tsx").matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]);
    expect(exported).toEqual(["NARROW", "SplitView", "MainBlock"]);
  });

  it.each(railPages)("the %s page renders one SplitView with its settings in the panel", (page) => {
    const file = fileOf(page);
    expect(file, `App.tsx renders no page component for "${page}"`).not.toBeNull();
    const src = read(file!);
    expect(src.match(/<SplitView\b/g)?.length ?? 0, `${file} must render exactly one <SplitView>`).toBe(1);
    expect(src, `${file}: the SplitView needs main= and panel=`).toMatch(/<SplitView[\s\S]*?\bmain=[\s\S]*?\bpanel=/);
    // the panel's settings are the one accordion, in the page or in a component it imports (Queue → JobSettings)
    const accordion = [file!, ...localImports(file!)].some((f) => {
      try {
        return /<Accordion\b/.test(read(f));
      } catch {
        return false;
      }
    });
    expect(accordion, `${file}: its panel must hold the accordion (<Accordion> from panel/Section.tsx)`).toBe(true);
  });

  it("the accordion is rendered only by the rail pages' panels", () => {
    const allowed = new Set(railPages.flatMap((p) => [fileOf(p)!, ...localImports(fileOf(p)!)]));
    allowed.add("panel/Section.tsx");
    const users = allTsx().filter((f) => /<(Accordion|Section)\b/.test(read(f)));
    expect(users.filter((f) => !allowed.has(f))).toEqual([]);
  });

  it("no second fold mechanism (<details>) anywhere in the UI", () => {
    expect(allTsx().filter((f) => /<details\b/.test(read(f)))).toEqual([]);
  });
});
