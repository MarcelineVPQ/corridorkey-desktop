// The application menu (backlog row 117, Marcy 2026-10-27): no developer tools or default reload/close shortcuts in a
// shipped copy; Electron's default menu (with them) in `npm run dev`.
import { describe, expect, it } from "vitest";
import { appMenu } from "../../electron/main/appMenu";

/** Every role in a template, submenus included. */
const roles = (t: unknown): string[] =>
  // loop: NOT-WORTH — a two-item template
  Array.isArray(t) ? t.flatMap((i: { role?: string; submenu?: unknown }) => [...(i.role ? [i.role] : []), ...roles(i.submenu)]) : [];

describe("the application menu", () => {
  it("development keeps Electron's default menu (developer tools, reload) on every system", () => {
    // loop: NOT-WORTH — three systems
    for (const p of ["linux", "win32", "darwin"] as const) expect(appMenu(false, p)).toBe("default");
  });

  it("a shipped copy on Linux and Windows has no menu, so none of the default menu's shortcuts", () => {
    expect(appMenu(true, "linux")).toBeNull();
    expect(appMenu(true, "win32")).toBeNull();
  });

  it("a shipped copy on macOS keeps the app and Edit menus (quit, copy, paste), nothing that reloads, closes or opens the developer tools", () => {
    const m = appMenu(true, "darwin");
    expect(roles(m)).toEqual(["appMenu", "editMenu"]);
    // loop: NOT-WORTH — the default menu's developer roles
    for (const r of ["toggleDevTools", "reload", "forceReload", "close", "viewMenu", "windowMenu", "fileMenu"]) expect(roles(m)).not.toContain(r);
  });
});
