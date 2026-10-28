// The application menu (backlog row 117, Marcy 2026-10-27): a shipped copy has no developer tools and none of
// Electron's default menu's reload or close shortcuts (Ctrl+Shift+I, Ctrl+R, Ctrl+Shift+R, F5, Ctrl+W); `npm run dev`
// keeps Electron's default menu, so they stay there. The app has no menu of its own: on Linux and Windows a shipped
// copy has none at all (copy and paste in the page are Chromium's own keys); on macOS, where copy, paste and quit
// come from the menu, only the app and Edit menus' roles (Electron's documented Menu.setApplicationMenu), and a Window
// menu (Minimize, Zoom, Bring All to Front and the window list, as every Mac app has; review 2026-10-27) without Close.
import type { MenuItemConstructorOptions } from "electron";

/** "default": leave Electron's default menu (development); null: no menu; else the template to set. Pure. */
export function appMenu(packaged: boolean, platform: NodeJS.Platform): "default" | MenuItemConstructorOptions[] | null {
  if (!packaged) return "default";
  return platform === "darwin"
    ? [{ role: "appMenu" }, { role: "editMenu" }, { label: "Window", role: "window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] }]
    : null;
}
