# Whole-code senior review (2026-10-27, main 8f70d2a)

Four independent senior reviewers, one per part, code and docs only (no test runs). Every finding is to be fixed
(Marcy: "when a senior dev gives you recommendations, you implement the recommendations").

| Part | Reviewer | Grade | MUST | SHOULD | NICE |
|---|---|---|---|---|---|
| Rust engine + CLI (engine-rs/) | senior Rust | A− | 1 | 4 | 8 |
| Electron main + Console back end (electron/) | senior Electron/security | B+ (security A−) | 0 | 8 | 8 |
| Renderer + shared code (src/) | senior front-end/a11y | B+ | 0 | 11 | 18 |
| Release, farm, tools, hooks, CI, tests, docs | senior build/release | B | 0 | 7 | 18 |

## Engine (engine-rs/)
- **MUST** gpu.rs:312-327 + :349-353, pipeline/mod.rs:792, :979 — Windows WDDM: NVML can't report the engine's own memory, so from the 2nd automatic job its own loaded sessions count as someone else's; smaller window / low-VRAM, different matte, understated `memory` reply. Fix: unload before reading the budget when own memory is unknown and networks are loaded.
- **SHOULD** clip.rs:448 → :638 (+ pipeline :874, ck-cli run.rs:279) — container `nb_frames` unbounded; a crafted header allocates GBs and aborts the engine. Fix: cap at the probe (input error).
- **SHOULD** ck-cli headless.rs:336-349 — `corridorkey run` installs no signal handling and doesn't exec; farm SIGTERM orphans the node runner and its renders; signal deaths reported as 143. Fix: exec on Unix, forward console events on Windows, 128+signal.
- **SHOULD** decode.rs:296-308, :380-392, writers.rs:445-447 — EXR data window ≠ display window keyed silently at the wrong region; autocropped sequences fail. Fix: refuse/warn until rows 30(h)/34.
- **SHOULD** ck-engine main.rs — no `SetDllDirectoryW("")`; turbojpeg/nvml/nvcuda/nvinfer by bare name from the current folder. Fix: call `no_dlls_from_current_folder()` first.
- NICE: writers.rs:522 stored output error on send race; ck-cli frames.rs:46 MAX_FRAMES overflow (checked_add/u128); run.rs:598 prepare checks ffprobe too; job.rs:335-339 bound frame_dir_fps; pipeline/mod.rs:470 Core ML clips of 1-3 frames (pad or clear message); `corridorkey run` exit status "never 1" + Windows job object for prepare's builder; trt-build wide Win32 APIs; export scripts' hard-coded scratch paths → variables + docs.

## Electron main + Console back end (electron/)
- **SHOULD** electron-builder.yml — no Electron fuses (RunAsNode, NODE_OPTIONS, --inspect on; asar integrity off) on a notarized build. Fix: electronFuses (keep RunAsNode only while headless needs it, or move headless to an app flag) + security-gate line. (Also found by the release reviewer.)
- **SHOULD** queue.ts:239-252/:314 — Stop during a finished job's promote leaves the engine running and engineEnding false. Fix: quit proc in stop() when no current job.
- **SHOULD** engine.ts:149 — no stdin 'error' listener: EPIPE after an engine death → uncaught exception dialog. Fix: listener.
- **SHOULD** updateFlow.ts:118, updateFeed.ts staleFiles — every start deletes older CorridorKey AppImages beside the running one. Fix: prune only files the updater installed (record them); say so in GUIDE.
- **SHOULD** index.ts:1054-1090 (+ trtSize remove ~:1000) — removeStorage not refused during a Console render/estimate; no try/finally (TRT build stays paused). Fix: refuse on consoleGpu, stop estimator, rename aside then delete, resumeBuild in finally.
- **SHOULD** engine.ts:189 — bare `taskkill` (current-folder lookup). Fix: System32 path, shared helper with runner.
- **SHOULD** validate.ts:134 uniqueOutputDir — case-sensitive on Windows/macOS: Plate.mov / plate.mov share a folder and overwrite. Fix: case-fold there.
- **SHOULD** index.ts:1205 — Restart (update) ignores a Console render and an install. Fix: refuse with reason.
- NICE: headless.ts:121 duplicate readRange/fs (share one); engine.ts:209 `null` reply line; trtPrebuild.ts:326 record ending before quit; estimate.ts:106 re-check card busy at run; media.ts sync fs on add (async with deadlines); index.ts:1326 clearJobTemps async; fromAppPage also checks senderFrame.url; macOS Window menu role.

## Renderer + shared (src/)
- **SHOULD** LineEditor.tsx:171 + ConsolePage.tsx:84 vs runner.ts:303 — history preview searches 200 lines, main expands over 5000: `!850` shows "no line" then runs an old (possibly sudo, elevated) line. Fix: one source of truth (preview via IPC) or main refuses beyond the shown window.
- **SHOULD** AppRail.tsx:46-56 vs editor.ts:431 — Ctrl+B moves the cursor and pins the rail. Fix: rail ignores defaultPrevented.
- **SHOULD** AppRail.tsx:118 — role="listitem" on the button (not announced as a button).
- **SHOULD** AppRail.tsx:124 — no keyboard way onto the rail from setup (all tabIndex -1).
- **SHOULD** Section.tsx:28-30 + App.tsx:83,91 — task deep links: nonce dropped, focus never cleared.
- **SHOULD** useTheme.ts:39 — re-applies ~20 properties on every state push. Fix: compare palette by value.
- **SHOULD** SetupParts.tsx:188, EnginePage.tsx:49 (trt.ts:87 buildFraction) — TensorRT build % is an estimate shown as fact. Fix: show engine-reported steps.
- **SHOULD** QueuePage.tsx:120-155 — row role=button with nested button; Space scrolls.
- **SHOULD** Section.tsx:112-121 Segmented — no radio-group arrow keys / roving tabindex.
- **SHOULD** JobSettings.tsx:233 — frame-rate field snaps to 24 while typing; range mismatch with validate.ts.
- **SHOULD** ConsolePage.tsx:395-401 — History list stale while open.
- NICE: Section aria-controls when closed; Copy disabled in locked sections; ProgressBar aria-label; disabled reasons only in title; drawer role=dialog/aria-modal; About heading ids + reduced motion; quoteArg with `${`; glob `[z-a]` raw error; Console log render cost (memo lines, content-visibility); completion debounce; manual window not in list; untraced "8 at 4K on 16 GB" prose; Accent readout under Desktop theme; paste trims leading space; setup step label sr-only; validate stored page; `!-0` message; cruft (DS5 comments, inline styles).

## Release, farm, tools, hooks, CI, tests, docs
- **SHOULD** release.sh:122 + verify-feed.mjs:96,104 — every dev release ends exit 1 (checks the non-existent stable feed; cached; no version compare); `--feeds` can't recover. Fix: verify only the released channel via the contents API, require version == $v, retry.
- **SHOULD** package.json:14-15 + release.sh:67-72 + cliSpec.test.ts:14 — dist rewrites cliSpec.json after the checks; shipped spec ≠ tagged commit. Fix: check:engine before check, drift test fails (not skips) under CK_RELEASE, fail on a dirty tree after dist.
- **SHOULD** electron fuses (as above).
- **SHOULD** farm/deadline10/CorridorKey/CorridorKey.param:25 — default executable paths wrong on all three systems.
- **SHOULD** upload_model_set.sh:56-79 — same-size replacement never repaired; notes keep old hashes. Fix: compare name+size+digest; rewrite notes every run.
- **SHOULD** macos.yml:69 + RELEASING.md:123-127 — Mac image not built from the tag; not in SUMS. Fix: --ref v$v, version check, re-hash SUMS.
- **SHOULD** Windows CI never passed (S8 still open); CHANGELOG Windows clean-stop claim.
- NICE: verify-feed fetch timeout + stale loop bound (loop gate accepts any bound text); stale CK_FEED_KEY comments; build-feed pagination + "Latest" badge on the model release; app.asar ships 46 MB of unused node_modules; prepare script `|| true`; docs-touch requires a reason; theme gate colour forms; farm-submitters gate short flags; releaseScript.test mirrors text; Windows paths in gates (or say POSIX-only); OpenCue docstring; Flamenco default `refuse` vs retries; shell farm CUDA_DEVICE_ORDER + trap timing; Deadline options Tail; farm/README stub-run contradiction; README still says dev.1 and "Mac can't key"; isolated.sh trap leaves the scope; unsigned SUMS.

## Status
All four parts fixed on main (2026-10-27; branches whole-main, whole-engine, whole-ui, whole-release rebased onto
8f70d2a in that order, no conflicts). Checks on the merged main: `tsc -b`, prettier, `npm run gates`, `cargo clippy
--all-targets -D warnings`, `tools/check_targets.sh` (Linux, Windows, macOS lint) all clean; no test runs in this pass.

**Engine**
- MUST WDDM own memory: b1bfff2. Needs hardware: Windows + NVIDIA (WDDM), two automatic jobs in a row.
- S nb_frames cap: 29a850a. S `corridorkey run` exec / Windows job object: bfd47b3 (Windows: see the VM run below).
  S EXR data window: 4e04f58. S `SetDllDirectoryW("")` in the engine: 9a235e9 (checked on Windows, below).
- NICEs: 8492795 (EXR writer error, frame-list overflow, prepare's ffprobe, fps bound), c58e288 (Core ML clips under
  the smallest window; needs a Mac), bfd47b3 (run's exit status, job object), 5efc1d9 (ck-trt-build wide Win32 paths;
  compiled only, needs Windows + NVIDIA TensorRT), 0b864e1 (export scripts' scratch variables).

**Electron main**
- Fuses: 30fcea5 (the packaged Windows app starts with them, below). Every other SHOULD and NICE: 9f512e1 (queue stop
  during promote, stdin EPIPE, updater prunes only its own AppImages, removeStorage refusals + rename aside, taskkill by
  path, case-folded output folders, Restart refused while busy; shared consoleFs, `null` reply line, prebuild ending,
  estimate re-check, async media reads, async clearJobTemps, top-frame URL check, macOS Window menu).

**Renderer + shared**
- S1 69786c7, S2-S4 49ffa08, S5 03ac63c, S6 c7c3f2d, S7 4c2bb0c, S8 9cda57b, S9 17907a4, S10 38e1c80, S11 fdd2543;
  every NICE e7452ba.

**Release, farm, tools**
- Feed verify / CLI spec / signed SUMS / Mac image from the tag: 931a865 (the Mac part needs the macOS runner).
  Fuses: 30fcea5. Deadline paths: d8a3e29. upload_model_set: 12c9a2e. Windows CI not passed: a39bb56 says so in the
  CHANGELOG / README / RELEASING (the workflow itself still has to pass on GitHub's Windows runner).
- NICEs: 931a865 (verify-feed timeout, stale bound), dcac64f (CK_FEED_KEY comments, build-feed pages, docs-touch why,
  isolated.sh scope, prepare outside git, gates POSIX-only), 3e6654f (theme gate colour forms, loop-gate bound
  constants), d8a3e29 (farm: Tail, OpenCue, Flamenco overwrite, shell CUDA_DEVICE_ORDER + trap, farm README, short-flag
  gate), 9c948bc (no node_modules in app.asar), a39bb56 (README dev.N and Mac wording).

**Loose ends after the merge** (80e9120): `.<name>.removing` leftovers swept at start (storage.ts sweepRemoving,
async after the cache check); the dead TensorRT time-weighted fraction removed (TrtPrebuild/PrebuildRange `fraction`,
overallFraction, buildFraction, MEASURED_4K_BUILD_S); runner.ts's unused `tokenize` import; releaseScript.test.ts S5 and
S6 run the script's own lines in bash with stand-ins.

**Windows VM run (win11-test, CPU only, 2026-10-27; installer built from 80e9120)**
- Install (per-user, silent), first start to the setup page on Electron 45.1.0 with the fuses: OK; quit exit 0; the
  only log lines are Chromium's GPU-less VM notices (GetGpuDriverOverlayInfo). app.asar has no node_modules.
- `corridorkey run`: a dir/echo script exits 0; a `sudo` line that replaces files, and `allow`, are refused in words,
  exit 2 (`sudo` on a read-only command runs as it is, as designed). taskkill /F of the CLI ends the app's runner at
  once (job object: the runner is in a job; gone 4 ms after).
- **Open: Ctrl+C / Ctrl+Break don't stop `corridorkey run` cleanly on Windows.** The runner (CorridorKey.exe with
  ELECTRON_RUN_AS_NODE) dies with STATUS_CONTROL_C_EXIT (0xC000013A); the CLI returns that code and nothing says the
  script stopped. A 3-line probe shows Electron 45.1.0 in run-as-node mode on Windows never calls
  `process.on("SIGINT" | "SIGBREAK")`, so headless.ts's handlers can't run there. Needs a fix that doesn't rely on
  Node's console signals (e.g. the CLI starts the runner in its own process group and asks it to stop over a pipe).
- **Open: Windows Defender quarantined resources\engine\corridorkey.exe** as Trojan:Win32/Bearfoos.A!ml (machine-
  learning heuristic, a false positive) during the Ctrl+C runs; restored for the rest of the run. Signing and a
  submission to Microsoft are the usual remedies.
- DLL lockdown: with invalid and with marker `turbojpeg.dll` / `nvml.dll` in the current folder, `corridorkey info`
  and `corridorkey-engine` start and report normally (turbojpeg not found, no GPU) and load neither; a plain test
  program in the same folder does load the marker nvml.dll (the check can see a load).
- Non-ASCII user "Zoë": `corridorkey info` as that user finds and loads the app's ONNX Runtime and model set under
  C:\Users\Zoë\AppData\Local\…; `corridorkey run` lists and reads files in "C:\Users\Zoë\Plates Zoë"; the app with
  its data folder under C:\Users\Zoë shows the path on the setup page, and its Console's cd (Tab-completed), dir, cat
  and pwd work there.
- Small findings: the headless runner says `[console] history: ENOENT … console-history-headless.jsonl` for a user who
  never started the app (its userData folder doesn't exist yet); `corridorkey info` without an ONNX Runtime names
  `libonnxruntime.so` on Windows (runtime.rs); the headless refusal reads "line that replace files" and offers the
  `-o …_v###/` hint for `allow` too; the Console prompt shows `Zoë/Plates Zoë` with `/` on Windows.
- Needs hardware still: everything that renders (no GPU, no models in the VM): job output under a non-ASCII path,
  turbojpeg decoding, the WDDM budget, ck-trt-build.
