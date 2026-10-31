# DS5 app shell → CorridorKey Desktop (CK): feature parity

Audit 2026-10-31 (read-only): the DS5 app's shell against CorridorKey Desktop (CD).
Scope: the app shell only (window, tray, startup, updates, notices, settings, About, rail, panel, i18n, accessibility).
DS5's controller, board, firmware and Games features are out of scope and marked n.a. where they touch the shell.
"Existing CK row" = row number in CK `docs/BACKLOG.md`. Within each group: missing and partial first, the generic and high-value ones on top.

Counts: **same 37 · partial 18 · missing 30 · n.a. 12** (97 rows).

## A. Window, tray, startup, OS integration

| # | Feature | DS5 (file/where) | CK state | What CK needs (one line) | Existing CK row |
|---|---|---|---|---|---|
| 1 | Tray icon with states (no board / waiting / ok; custom drawn icon, macOS template), status tooltip | `electron/main/tray.ts`, `src/desktop/tray/trayIcon.ts` | missing | Tray icon whose state and tooltip follow the queue (idle / running x of y / done / failed) and the engine | 167, 203 |
| 2 | Close to tray (default on) | `index.ts` window `close` handler, `settings.ts` `closeToTray` | missing | Close hides the window while chosen (or while a queue runs); a way back on trayless desktops | 203 |
| 3 | Launch at login (Linux `~/.config/autostart/*.desktop`, Windows/macOS login items) | `electron/main/autostart.ts`, App settings → Startup | missing | Port `autostart.ts` and the switch | none |
| 4 | Start minimized / `--hidden` flag (also used by autostart) | `autostart.ts` `HIDDEN_FLAG`, `index.ts` `createWindow(visible)` | missing | Start hidden in the tray when chosen or launched with `--hidden` | none |
| 5 | Tray menu: Show/Hide, status line, Check for updates / Restart to update, switches (close to tray, launch at login, start minimized, check automatically), Quit | `tray.ts` `menu()` | missing | Same menu adapted (status, queue start/stop, update, switches, Quit) | 167, 203 |
| 6 | Hardware acceleration switch (Startup, "restart to apply") | `AppSettingsPage.tsx` Startup, `index.ts` `disableHardwareAcceleration` | missing | Setting + switch; applies at next start | none |
| 7 | GPU-process crash watcher: a second crash turns hardware acceleration off, notice with Turn back on | `electron/main/gpuCrash.ts`, `src/desktop/GpuNotice.tsx` | missing | Port watcher + notice (no `child-process-gone` handling in CK) | none |
| 8 | Refused reload / zoom / DevTools keys (F5, Ctrl/⌘+R, Ctrl +/−/0, Ctrl+Shift+I) via `before-input-event`; zoom pinned to 100% | `electron/main/appMenu.ts` `pageShortcut`, `index.ts` `setZoomFactor(1)` | partial | CK only drops the menu in packaged builds; add the input guard and zoom pin (Ctrl+wheel/pinch) | 117 (menu only) |
| 9 | Linux AppImage desktop integration: `.desktop` entry + icon in `~/.local/share`, stable AppImage name, `StartupWMClass` | `electron/main/integration.ts`, `desktopEntry.ts` | partial | CK repoints a stable symlink in the updater but writes no menu entry/icon; port `integration.ts` | none |
| 10 | Windows AppUserModelId (taskbar grouping, login item) | `index.ts` `app.setAppUserModelId(APP_ID)` | missing | Set it at start (needed for tray/notifications on Windows) | none |
| 11 | Lean while hidden in the tray: main sends window-visible (tray hide isn't seen by `document.hidden`), CSS animations paused via `data-window-hidden` | `index.ts` `sendVisible`, `src/desktop/useWindowShown.ts` | partial | CK uses `visibilityState` only; once a tray exists add the main-process visible signal and the CSS pause | 203 |
| 12 | External links only to an allowlist of hosts; "link couldn't open" error | `electron/main/urls.ts`, `openExternalLink` | partial | CK opens any https URL silently; add host allowlist + failure notice | none |
| 13 | Start-failure dialog in the user's language | `index.ts` catch + `mainText.ts` | partial | CK's start dialogs are English only (follows i18n, row 92) | none |
| 14 | Single instance | `index.ts` `requestSingleInstanceLock` | same | (once a tray exists, second launch must also `show()` a hidden window) | — |
| 15 | Second launch brings the window forward (restore, show, focus) | `index.ts` `showWindow` | same | Extend to the hidden-in-tray case with row 1 | — |
| 16 | Quit / restart waits for running work | `electron/main/firmwareHold.ts` | same | CK: `busy.ts` quit question and restart refusal | — |
| 17 | macOS app/edit/window menu; no menu on Linux/Windows | `appMenu.ts` `appMenuTemplate` | same | — | 117 |
| 18 | Default and minimum window size | `index.ts` `createWindow` (1100×760, min 820×560) | same | CK 1240×820, min 900×600 | — |
| 19 | AppImage mount held until all processes exit | `electron/main/appImageQuit.ts` | same | — | — |
| 20 | Session locked down (permissions denied, navigation and new windows blocked) | `index.ts` `lockDownSession`, `permissions.ts` | same | — | — |
| 21 | Wayland fractional scaling switches | `index.ts` `applyLinuxWorkarounds` | same | — | — |
| 22 | Windows desktop shortcut | tray "Create desktop shortcut" (`integration.ts`) | same | CK's installer creates it (`nsis.createDesktopShortcut`) | — |
| 23 | Install update at quit / next start | `updater.installOnQuit` | same | CK installs beside the AppImage at download; next start runs it | — |
| 24 | Windows: "now installed" notice after moving from the portable exe; Temp leftovers pruned | `windowsInstall.ts`, `portableTemp.ts` | n.a. | CK never shipped a portable exe | — |
| 25 | Skip installing during OS logout (`session-end`) | `index.ts` `sessionEnding` | n.a. | CK installs nothing at quit | — |

## B. Updates

| # | Feature | DS5 (file/where) | CK state | What CK needs (one line) | Existing CK row |
|---|---|---|---|---|---|
| 26 | Install updates automatically (background download + verify, starts next time) | `index.ts` `checkForUpdates` + `autoInstallUpdates`, App settings → Updates | missing | Setting + background install, never while a job runs | 202 |
| 27 | First-update ask "Keep the app up to date?" (after the tour or a minute in, only while shown) | `src/desktop/AutoUpdateAsk.tsx` | missing | Port the one-time ask | 202 |
| 28 | "Updated to X · See what's new" notice after an update; opens About → Changes; Changes section shows the task | `DesktopApp.tsx` `useWhatsNew`, `AboutPage.tsx` | missing | Last-seen version pref + notice + Changes deep link | none |
| 29 | Join Development dialog: what's newer, both versions, the dev release notes (Markdown) and link, a check button when automatic checks are off | `AppSettingsPage.tsx` `DevChannelDialog`, `updateFeed.ts` `devChannelPreview` | missing | Confirm dialog with the dev feed's notes before switching channel | none |
| 30 | Feed replay protection: refuse a feed older than the last seen `issued_at` per channel ("olderFeed") | `index.ts` `feedIssuedAt`, `updater.ts` | missing | Store and compare `issued_at` per channel | none |
| 31 | Self-update on Windows (silent installer) | `updater.ts`, `windowsInstall.ts` `installerArgs` | partial | CK opens the release page on Windows/macOS | 57, 28, 180 |
| 32 | Automatic check schedule (20 s after start, every 6 h) | `index.ts` `UPDATE_FIRST_CHECK_MS`, `UPDATE_INTERVAL_MS` | same | — | 13 |
| 33 | Automatic checks off = nothing online on its own | CLAUDE.md rule, `firmwareFeed`/`devChannelPreview` | same | — | 13 |
| 34 | Stable / Development channel | App settings → Updates | same | — | 13 |
| 35 | Back to stable | `backToStable` | same | — | 13 |
| 36 | Update banners: available / downloading / ready / failed, literal wording | `src/desktop/UpdateBanners.tsx` | same | CK `UpdateBanner.tsx` (ported) | 13 |
| 37 | Not now hides one step of one version; failed install shows again on the next failure | `UpdateBanners.tsx`, `notices.ts` | same | — | — |
| 38 | Restart waits for running work and says why | `firmwareHold.ts` `whenDone` | same | CK `restartRefusal` | — |
| 39 | Signed feed, size + hash check before install | `feedSignature.ts`, `download.ts` | same | — | 13 |
| 40 | Check now says what it found | `AppSettingsPage.tsx` `CheckNow` | same | — | — |
| 41 | Firmware / Proton updates from the same feed | `firmwareSource.ts`, `updateFeed.ts` | n.a. | No board or Proton in CK | — |

## C. Notices and messages

| # | Feature | DS5 (file/where) | CK state | What CK needs (one line) | Existing CK row |
|---|---|---|---|---|---|
| 42 | One notice framework: `Notice` with dismissKey (task, hidden until its reason changes), onDismiss (error), closable (info), pinned; stale keys pruned | `src/desktop/Notice.tsx`, `notices.ts`, `openTasks.ts` | partial | CK has only the update banner's own dismissals; port the framework and move every notice onto it | 204 |
| 43 | Dismissed notices list (App settings): each with Go to and Show again, Show all again | `src/desktop/DismissedNotices.tsx` | missing | Port with its App settings section | 204 |
| 44 | Damaged settings/preferences: salvage what reads, keep the damaged copy as `.corrupt-<date>`, notice says so | `persistedFile.ts`, `src/persisted.ts`, `RecoveredNotice.tsx` | missing | CK's `loadSettings` silently falls back to defaults; port salvage + notice | none |
| 45 | Main process → page notices/errors (tray actions, links, GPU off, "now installed") | `index.ts` `showMainNotice` / `showMainError`, `MAIN_*_KEYS` | missing | IPC channel for main-side messages (needed by tray and links) | none |
| 46 | Toasts: short confirmations, paused while hovered/focused/hidden, polite for screen readers | `src/desktop/toast.ts`, `Toasts.tsx` | missing | Port the toast queue (e.g. "Copied", "Queue finished") | none |
| 47 | Pinned error notice for an action that failed with no status line of its own | `src/desktop/shownError.ts` | partial | CK uses modal dialogs and inline text; add the one pinned error notice | none |
| 48 | Rail dots follow the task, not the dismissal | `notices.ts` | same | CK `tasks.ts` dots | — |
| 49 | Board busy, headset, volume restored notices | `BoardBusyNotice.tsx`, `HeadsetNotice.tsx` | n.a. | Device-specific | — |

## D. App settings

| # | Feature | DS5 (file/where) | CK state | What CK needs (one line) | Existing CK row |
|---|---|---|---|---|---|
| 50 | Startup section: close to tray, launch at login, start minimized, hardware acceleration, with a status line | `AppSettingsPage.tsx` `startup` | missing | Section with rows 2–4, 6 | 203 |
| 51 | Language section: picker (each language in its own name), the title's word in every language below it | `AppSettingsPage.tsx` `language`, `LanguageToggle.tsx` | missing | Comes with i18n (row 92) | none |
| 52 | Color vision palettes (protanopia/deuteranopia, tritanopia; Okabe–Ito) for status colors | `src/desktop/colorVision.ts` | missing | Status-token palettes + Accessibility section | none |
| 53 | Developer section (dev builds only, Ctrl+Shift+D): update-state previews for every banner, simulated devices | `devPreview.ts`, `updatePreview.ts`, `AppSettingsPage.tsx` | missing | Dev-only section with at least the update-state preview | none |
| 54 | Look knobs (card opacity, depth) | `src/desktop/lookKnobs.ts`, Appearance | missing | Optional; low value for CK | none |
| 55 | Reduce motion as an app setting (beyond the system's) | `src/desktop/motion.ts` `data-reduce-motion` | partial | CK follows the system only; add the switch | none |
| 56 | Updates section complete (auto install, Dev dialog, status) | `AppSettingsPage.tsx` `updates` | partial | Rows 26, 29 | 202 |
| 57 | Theme System/Light/Dark/Desktop | `ThemeToggle` | same | — | — |
| 58 | Glass | `glass/` | same | — | — |
| 59 | Accent (built-in / desktop) | `AccentSetting` | same | CK built-in/desktop (DS5 controller/desktop) | — |
| 60 | Desktop colors followed live (KDE scheme, portal accent) | `electron/main/desktopTheme.ts` | same | — | — |
| 61 | Section statuses summarize the choices | `AppSettingsPage.tsx` | same | — | — |
| 62 | Backdrop / game art, custom controller colors, HDR lighting | Appearance | n.a. | Controller drawing and game art only | — |
| 63 | Narrator voice and captions | `narrator.ts`, `NarratorCaption.tsx` | n.a. | Speaks through the controller's speaker | — |
| 64 | Privacy (launcher-read consent link) | `AppSettingsPage.tsx` `privacy` | n.a. | Games-specific | — |

## E. About

| # | Feature | DS5 (file/where) | CK state | What CK needs (one line) | Existing CK row |
|---|---|---|---|---|---|
| 65 | Coming soon: public roadmap board, gated against the backlog | `about/ComingSoon.tsx`, `about/roadmap.ts`, `roadmapBacklog.test.ts` | missing | Port + gate | 196 |
| 66 | Studio header card: logo, production line, developer, version, Website / GitHub / Source / Report an issue, copyright | `AboutPage.tsx` `StudioCard` | missing | Port (logo is the owner's pick) | 197 |
| 67 | Changes cut to the newest releases with "Show older" | `AboutPage.tsx` `NEWEST`, `firstChapters` | missing | Trim long changelog, button for the rest | none |
| 68 | Credits laid out ("Built on", What / Credit table) | `AboutPage.tsx` `CREDITS` | partial | CK shows plain `CREDITS.md` | 197 |
| 69 | Section lines name what's inside (chapters count, newest version) | `AboutPage.tsx` `statuses` | partial | CK says "Shown" / "Click a chapter" | 197 |
| 70 | Markdown: bundled screenshots, `#anchor` links scroll, links through the allowlist | `src/desktop/Markdown.tsx` | partial | CK opens every link in the browser, no in-doc anchors/images | none |
| 71 | Guide reader with chapters | `AboutPage.tsx` | same | — | — |
| 72 | Changes (CHANGELOG) | `AboutPage.tsx` | same | — | — |
| 73 | Replay the tour | `AboutPage.tsx` Guide | n.a. | Tour is off in DS5 (`TOUR_ENABLED = false`) | — |
| 74 | Firmware and Proton changelogs | `AboutPage.tsx` | n.a. | DS5-specific | — |

## F. Rail

| # | Feature | DS5 (file/where) | CK state | What CK needs (one line) | Existing CK row |
|---|---|---|---|---|---|
| 75 | Channel and version upright on the rail for dev builds | `AppRail.tsx`, `appVersion.ts` `isDevelopmentBuild` | missing | Port | 195 |
| 76 | Pin (Ctrl+B / ⌘B), lock, hover/focus expand, tips, roving arrow keys | `AppRail.tsx` | same | — | — |
| 77 | Status at the bottom (symbol + color, never color alone) | `AppRail.tsx` | same | CK: engine + GPU lines | 198 |
| 78 | Task dot leads to its section | `AppRail.tsx` `railSelect` | same | — | — |
| 79 | Pressing the page you're on shows/hides its panel | `Section.tsx` `togglePanel` | same | — | — |
| 80 | Board stack (several boards, identify) | `AppRail.tsx` | n.a. | Device-specific | — |

## G. Panel and accordion framework

| # | Feature | DS5 (file/where) | CK state | What CK needs (one line) | Existing CK row |
|---|---|---|---|---|---|
| 81 | Panel ⋮ menu: Collapse all, Clear pins | `accordion/Section.tsx` `PanelMenu`, `useAccordion.ts` | missing | Port | 200 |
| 82 | One popup menu component (top layer; ↓/Enter opens, arrows/Home/End, Escape back) | `src/desktop/MenuButton.tsx`, `topLayer.ts` | missing | Prerequisite of row 81 (and the language picker) | 200 |
| 83 | ⓘ InfoTip for long explanations; no folds inside sections (gated) | `controls.tsx` `InfoTip`, `noFolds.test.ts` | partial | CK uses `More.tsx` (a fold); decide whether to port DS5's no-folds rule | none |
| 84 | Deep link scrolls, flashes once, focuses the row's control | `accordion/Section.tsx` `showLinked` | partial | CK opens and scrolls only | none |
| 85 | Idle section (header and status only when nothing to do) | `Section.tsx` `idle` | partial | CK has a disabled fieldset instead | none |
| 86 | Sections: status line, pin, one open at a time, WAI-ARIA keys | `accordion/Section.tsx` | same | — | — |
| 87 | Narrow layout: panel as a drawer, Escape closes | `Section.tsx` SplitView | same | — | — |
| 88 | Readouts in the main view (MainBlock) | `accordion/MainBlock.tsx` | same | — | — |
| 89 | One save bar | `SaveBar.tsx` | n.a. | CK settings save as changed; no board | — |

## H. First run

| # | Feature | DS5 (file/where) | CK state | What CK needs (one line) | Existing CK row |
|---|---|---|---|---|---|
| 90 | Setup gate screen before the page exists | `src/desktop/SetupScreen.tsx` | same | CK `SetupPage.tsx` | — |
| 91 | Guided tour | `src/desktop/tour/Tour.tsx` | n.a. | Off in DS5 until rebuilt | — |

## I. Languages, accessibility, gates

| # | Feature | DS5 (file/where) | CK state | What CK needs (one line) | Existing CK row |
|---|---|---|---|---|---|
| 92 | 7 languages (en, de, es, fr, ja, pt-BR, zh-CN) through i18next; main-process text keyed, never English; glossary per locale | `src/i18n/locales/*.json`, `src/errorText.ts`, `mainText.ts`, `docs/GLOSSARY.md` | missing | CK strings are hard-coded English (no i18n at all); the largest port | none |
| 93 | Resource budgets gate (idle frames, CPU shown/hidden in tray, memory, soak) | `tools/check_budgets.sh`, `docs/BUDGETS.md` | missing | Port once the tray exists (hidden CPU matters then) | none |
| 94 | UI checker on an isolated copy: layout, contrast, accessible names across language × size × theme | `tools/check_ui.sh` | partial | CK has a token contrast test and `drive.mjs`; no full layout/name sweep | none |
| 95 | Live announcements for events (toasts polite, captions) | `Toasts.tsx`, `toast.ts` | partial | CK has `role="status"` texts only; comes with row 46 | none |
| 96 | Visible focus ring | `desktop.css` | same | CK `:focus-visible` | — |
| 97 | Never color alone (symbols beside status dots) | `AppRail.tsx`, `Section.tsx` | same | — | — |

## Checked, not in DS5 either (no row)

Window size/position remembered, export/import settings, reset app settings, copy diagnostics / bug-report bundle,
a keyboard-shortcut map page, an OS protocol handler (deep links from outside), file associations, OS notifications
(DS5 denies the permission), taskbar progress, sounds other than the narrator. DS5's only shell shortcuts are Ctrl+B
(rail) and Ctrl+Shift+D (Developer, dev builds); CK has Ctrl+B and the Console's own keys.
