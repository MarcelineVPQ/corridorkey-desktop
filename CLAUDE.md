# corridorkey-desktop

A free Linux desktop app for CorridorKey 2.0 (Corridor Digital's AI keyer).
Built to **Marcy's 15 basic rules for programming applications** (memory
`marcys-15-basic-rules`); they are the standard here, with these specifics:

- **Engine/app contract (rule 10):** the app never imports the model. Two engines speak
  `docs/ENGINE_PROTOCOL.md` (the Sonata helper pattern): the Rust engine on ONNX Runtime
  (`engine-rs/`, docs/ENGINE_RUST.md; the default when set up) and `engine/ck_engine.py`, which runs
  the upstream runtime unchanged from a CorridorKey2.0 checkout (kept until Marcy retires it).
  Protocol changes: additive fields, bump `PROTOCOL` only for what the app must know.
- **Accuracy (rule 1):** every number on screen comes from an engine reply (frames handed to
  the writers, the window really used, the free memory it saw). Never estimate progress in the app.
- **Share the machine (rule 11):** the engine lives only while the queue runs (`quit` frees the
  model's graphics memory). GPU readout only while a job runs AND the window is shown.
  Never run GPU work while Marcy's Sonata plays (`pgrep -fai 'mount_sonata|Sonata.AppImage'`).
- **One theme (rule 2):** colors only from `src/styles/tokens.css`; gate `.hooks/check_theme_colors.mjs`.
- **Loop pass (rule 7):** `// loop: VERDICT — reason` on every loop, iterator chain, timer, wait, thread and
  main-process sync call (app, engine-rs, tools); a wait without a deadline says `[bounded: …]`. Gate
  `tools/list_loops.mjs --check`; the pass: docs/LOOP_PASS_2026-10.md, docs/EFFICIENCY_PASS_2026-10.md.
- **Isolated test copies (rule 12):** `tools/isolated.sh` (own HOME, private D-Bus, Xvfb,
  basic password store, 4 GB cap) + `tools/drive.mjs` (CDP steps + screenshots). Never the user's screen.
- **Memory caps:** every test/build/run under `systemd-run --user --scope -p MemoryMax=…`.
- **Backlog (rule 8):** `docs/BACKLOG.md`; ideas wait for Marcy's "now".
- **Licence:** CorridorKey licence (LICENSE, a CC BY-NC-SA 4.0 variant). The app stays free,
  keeps the CorridorKey name, credits Corridor Digital. No paywall, ever.
- **npm:** the system npm 9 (and npm 10) crash in peer resolution on this set; `.npmrc` has
  `legacy-peer-deps=true`. Run Electron's `node node_modules/electron/install.js` if the binary is missing.

Commands: `npm run dev` · `npm run build` · `npm run check` (typecheck, format, gates, unit + engine tests).
