# Bug hunt 2026-10: engine, app, updater, tools

_2026-10-22, branch `bughunt/2026-10` (off `feat/rust-engine` 8f34420). Mechanical and exhaustive, in the AVIEW
manner: every finding is a row with a verdict. A suspected bug became a bug only after a reproduction or a failing
test; every FIXED row names the test that fails on the old code and passes now._

## How it was run

- **Engine (CPU)**: the release engine on ONNX Runtime's CPU provider, fp32 (`2.0.0-onnx.1` op23 set and the
  `2.0.0-onnx.2` set), one engine process per batch of jobs, every run under `memrun.sh 8`. Inputs made with
  ffmpeg / cv2 into `~/.cache/claude-scratch/ck-bughunt/probe/in` (paths with spaces, unicode and quotes, odd /
  tiny / portrait sizes, 1-3 frame clips, variable frame rate MP4 and MKV, WebM, 12-bit HEVC, 12-bit ProRes 4444
  with alpha, frame folders with gaps and with mixed sizes, linear EXR with HDR values and with NaN / infinity,
  hints of other sizes and lengths, unreadable / missing inputs, an unwritable output folder, a truncated MP4).
  Every stdout line of every run was parsed (979 lines: all protocol replies).
- **Engine (GPU)**: the GPU build (ORT 1.31 dynamic + TensorRT features), CUDA fp16, `2.0.0-onnx.2`, 12 GB budget,
  under the GPU lock, the Sonata / other-GPU guard, `memrun.sh 16` and a timeout.
- **App**: vitest (the queue, settings, validation, relaunch), and isolated copies (headless KWin, private D-Bus,
  own HOME, memory-capped): `tools/update_e2e.sh` (whole self-update), `tools/two_copies_e2e.sh` (single
  instance), the AppImage without Wayland (Xvfb only, and no display).
- **Severity**: HIGH = wrong or lost output with no error, or the machine not shared (GPU / mounts held);
  MEDIUM = a job or feature fails, or an input is misread; LOW = a wrong message, a leak of small things, a
  path no caller uses today.

## Counts

| verdict | HIGH | MEDIUM | LOW | no severity | total |
|---|---|---|---|---|---|
| FIXED | 4 | 10 | 11 | | 25 |
| NOT-A-BUG | | | | 32 | 32 |
| BACKLOG | | | 6 | 1 (G4, an idea) | 7 |

N1 and C7 point at I9 and E2/E3 and are not counted twice. The portrait export (I3's cause) is backlog row 14;
the row counts once, as FIXED (the engine's clear refusal).

## 1. Engine protocol and lifetime

| id | file:line | what | how found | sev | verdict | test |
|---|---|---|---|---|---|---|
| E1 | `ck-engine/src/lib.rs` serve | A `cancel` for a waiting job was honoured only when it came before that job's `run` line: requests were read only between jobs, so `run j1, run j2, cancel j2` ran all three (protocol: "a cancel for a job still waiting removes it"). The app sends one run at a time, so it never hit this | protocol test, fake backend | LOW | FIXED: requests are read on their own thread; before a job starts the engine looks ahead for its cancel | `protocol.rs` cancel_sent_after_the_run_line_removes_the_waiting_job |
| E2 | `ck-engine/src/main.rs` | An engine whose app died kept running: it runs a job without reading stdin, in its own process group (so the app can kill it), so nothing ended it; a whole job on the GPU for nobody. Measured by hand: reparented, still running after its parent exited | reproduction (shell parent exits, engine stays) | MEDIUM | FIXED: `PR_SET_PDEATHSIG` (SIGKILL) at start; ffmpeg children end with their pipes; the app clears stale job folders at start (A2) | `tests/lifetime.rs` the_engine_ends_when_its_parent_does (real binary; fails without the fix: "outlived its parent") |
| E3 | `ck-core/src/tensorrt.rs` build_engine | `ck-trt-build` (minutes on the GPU) would outlive a killed engine: it has no pipe to lose | code reading + E2's mechanism | LOW | FIXED: the builder gets the same parent-death signal (`proc::die_with_parent`) | `proc.rs` a_child_started_to_die_with_its_parent_does |
| E4 | `ck-core/src/job.rs` parse | `hann_stride` > `hann_chunk` leaves frames no window covers: normal mode wrote 6 of 8 frames and reported success; low-VRAM rendered the uncovered frames from never-written (zero) batons. Upstream has the same gap; the app only offers valid pairs | CPU run, window 2/4, 8 frames | MEDIUM | FIXED: an `input` error | `job.rs` bad_options_are_input_errors |
| E5 | engine-wide | stdout purity: only protocol replies on stdout | all probe runs parsed: 979 lines, 0 non-protocol; ffmpeg writers' stdout is /dev/null, ffprobe / decoder / builder stdout are piped | | NOT-A-BUG | |
| E6 | `lib.rs`, `ck-core/src/lib.rs` | error codes vs the protocol | every code in the source is one of oom, input, assets, no-gpu, cancelled, engine, bad-request | | NOT-A-BUG | |
| E7 | `job.rs`, `pipeline.rs`, `writers.rs` | every documented option honoured | CPU runs: crf 30 / preset ultrafast / pix_fmt yuv420p reached the file; frame_dir_fps 30 → 30 fps; num_frames 3 → 3 frames; exr_dtype half / float → EXR pixel types half / float; despill 0 / 1 → `despill000` / `despill100`; hint_quality 0 vs 1, carry_hint on / off, carry_hint_quality 0 → mattes differ (max 0.32 / 0.79 / 0.65); vram_budget_gb taken (GPU `memory` replies: budget_cap_gb 12); tensorrt → the `provider` reply (UHD: "outside every TensorRT range") | | NOT-A-BUG | |
| E8 | `ck-core/src/writers.rs` ffmpeg_args | Output videos lost their colour tags: every alpha / fg / checker / cutout file read color_transfer=unknown, color_primaries=unknown (only color_space=bt709), and a linear cutout wasn't tagged linear: ffmpeg 8 keeps a raw input's unset tags and drops the output-side options. Also in the audit's GPU bench files | ffprobe of CPU and GPU outputs; ffmpeg experiment | MEDIUM | FIXED: the tags go on the input side too; pixels unchanged (frame md5 equal) | `writers.rs` video_files_carry_their_colour_tags |
| E9 | protocol | `quit` while a job runs is read after the job | by design: the running job can't be interrupted; the app kills the group to stop (queue.stop / shutdown) | | NOT-A-BUG | |
| E10 | `queue.ts` exited | engine crash mid-job: the job fails with the stderr tail, its temp folder goes, the next job runs on a new engine | existing vitest + A2's test | | NOT-A-BUG | `queue.test.ts` an engine crash fails the job… |
| E11 | `pipeline.rs` keying error path | a job failing mid-decode (truncated MP4) leaves no ffmpeg child or render thread behind; the engine takes the next request | CPU run: `input` error "failed decoding frame 15", no child processes of the engine afterwards | | NOT-A-BUG | |
| E12 | `pipeline.rs` | a failed / cancelled job leaves its half-written outputs in the output folder (as upstream) | CPU runs | LOW | BACKLOG (row 19): a UI decision (remove or say so) | |
| E13 | `engine/ck_engine.py` | the PyTorch engine keeps E1, E8 and I9 (it runs upstream's writer and reader unchanged) | code reading | LOW | BACKLOG (row 20): it stays as the benchmark reference (Marcy 2026-10-22) | |

## 2. Inputs

| id | file:line | what | how found | sev | verdict | test |
|---|---|---|---|---|---|---|
| I1 | `clip.rs`, `writers.rs` | paths with spaces, unicode and quotes (`dir with spaces/ünïcödé 'q"uote.mp4`) | CPU run: result, outputs named after the clip | | NOT-A-BUG | |
| I2 | `clip.rs` | sizes not a multiple of 128 (321×199), landscape and square shapes (256…3840 wide) | CPU runs, GPU UHD 3 frames (80/40 low-VRAM, CUDA) | | NOT-A-BUG | |
| I3 | `clip.rs` model_shape_supported | Portrait clips (taller than wide) failed inside C-RADIO after the RVM pass with an ONNX Runtime broadcast error. Every C-RADIO export (onnx.1, onnx.2, the TensorRT set) adds a square position grid (240 tokens against 400 at 768×1280 padded); every landscape / square shape ran | CPU fp32 (3 portrait shapes), CUDA fp16 (720×1280), the TensorRT export on ORT CPU | HIGH | FIXED in the engine: refused up front as an `input` error in words. The export itself: BACKLOG row 14 | `clip.rs` shapes_the_networks_take |
| I4 | `clip.rs` model_shape_supported | A side of ≤ 128 px (padded to 128) failed in stage 1's reflect pad with an ONNX Runtime message | CPU runs: 40×24 and 320×128 fail, 320×129 runs | LOW | FIXED: an `input` error in words | `clip.rs` shapes_the_networks_take |
| I5 | `clip.rs`, `hann.rs` | clips of 1, 2, 3 frames (shorter than any window), automatic and low-VRAM windows | CPU runs | | NOT-A-BUG | |
| I6 | `clip.rs` ffprobe | A clip whose container has no frame count (Matroska, WebM) was counted as duration × nominal rate: a variable-frame-rate MKV of 8 frames was probed as 18, the job failed "failed decoding frame 8" | CPU run; ffprobe | MEDIUM | FIXED: the packets are counted when the count is missing (the app's probe does the same) | `clip.rs` a_variable_frame_rate_mkv_counts_its_real_frames |
| I7 | `clip.rs`, `writers.rs` | variable frame rate MP4: decoded frame by frame, written at the average rate (12.8 fps), as cv2 does: the frames match the source one to one | CPU run | | NOT-A-BUG | |
| I8 | `decode.rs` | WebM, 12-bit HEVC, 12-bit ProRes 4444 with alpha (alpha dropped, as cv2) | CPU runs | | NOT-A-BUG | |
| I9 | `decode.rs` prep_frame_views, prep_hint, load_initial_hint | Three non-finite pixels in a linear EXR plate (NaN, +inf, −inf) made every pixel of every alpha and fg frame NaN (64000 / 64000), and the job reported success. Display-coded EXRs and EXR hints had the same path (`clamp` keeps NaN) | CPU run, cv2 read of the outputs | HIGH | FIXED: `color::finite_input` (NaN → 0, beyond ±1e30 → ±1e30); every finite value up to 1e30 unchanged | `decode.rs` non_finite_frame_values_reach_the_networks_finite, `color.rs` non_finite_inputs_become_finite_and_finite_ones_stay |
| I10 | `decode.rs` | frame folders with gaps in the numbering (sorted by name, as upstream); mixed sizes → `input` "frame size 160x100 differs from the first frame's 320x200" | CPU runs | | NOT-A-BUG | |
| I11 | `decode.rs` | linear EXR with HDR values (40.0 highlights) | CPU run | | NOT-A-BUG | |
| I12 | `decode.rs` HintReader, load_initial_hint | a hint video of another size (resized with Lanczos-4, as upstream); a first-frame hint of another size → `input` (as upstream); a hint video shorter than the clip → `input` "has only 4 frames…"; first-frame hint and a short hint video → the same | CPU runs | | NOT-A-BUG | |
| I13 | `pipeline.rs`, `clip.rs` | no ffmpeg → `assets` "ffmpeg binary not found"; no ffprobe → `assets` "ffprobe could not run" | CPU runs with PATH without them | | NOT-A-BUG | |
| I14 | `clip.rs`, `pipeline.rs` | unreadable input (mode 000) → `input` "Permission denied"; missing input → `input`; output folder not writable → `engine` naming the folder and "Permission denied"; temp folder is a file → `engine` "File exists" | CPU runs | | NOT-A-BUG | |
| I15 | `pipeline.rs`, `writers.rs` | disk full | not reproducible as a user (no size-limited filesystem without root); by code: temp writes fail as `engine` "temp file: …", ffmpeg's failure as `engine` "ffmpeg writer failed with exit code …" | LOW | BACKLOG (no reproduction; reasoning only) | |

## 3. Numerics

| id | file:line | what | how found | sev | verdict | test |
|---|---|---|---|---|---|---|
| N1 | `decode.rs` | NaN / infinity propagation | = I9 | HIGH | FIXED (I9) | |
| N2 | `render.rs`, `color.rs` | clamping: alpha clamped to [0, 1]; video samples `to_u16` (a NaN becomes 0: Rust's saturating cast) | code + parity tests | | NOT-A-BUG | |
| N3 | `color.rs` linear_to_asinh / asinh_to_linear | asinh at extremes: `x / knee` overflowed past 2.7e36 (now bounded by I9's ±1e30, asinh ≤ 9.0); decode `sinh(y·denom)` is finite for \|y\| ≤ 10.7, beyond the networks' outputs | code + I9's test | | NOT-A-BUG | |
| N4 | `color.rs` despill | despill at 0 (returns the input) and 1 (full): parity 0 against the Python function | parity tests | | NOT-A-BUG | |
| N5 | `runtime.rs` Data | fp16 overflow on HDR input: frames go to stage 1 / 2 as asinh-coded values (≤ 9.0 after I9), hints are in [0, 1]: no float16 overflow | code | | NOT-A-BUG | |
| N6 | `hann.rs` | Hann weights at window edges: the ramps sum to 1 across an overlap; a single window (clip ≤ window) weighs 1; the last window starts at T − chunk so every window has the full length | unit tests | | NOT-A-BUG | |
| N7 | `image.rs` reflect101 | reflect-pad when the padding exceeds the frame: steps like cv2's borderInterpolate until inside; a 40×24 frame padded to 128×128 reached stage 1 | CPU run (I4) | | NOT-A-BUG | |

## 4. Concurrency

| id | file:line | what | how found | sev | verdict | test |
|---|---|---|---|---|---|---|
| C1 | `outputs.rs` RenderWorker | render / writer threads on an error: the worker joins, the writers come back and are released (ffmpeg killed on drop) | E11's run: no child processes after the failure | | NOT-A-BUG | |
| C2 | `ahead.rs`, `decode.rs` Prefetch | look-ahead threads end when their receiver is dropped (the next send fails) | code + E11 | | NOT-A-BUG | |
| C3 | `pipeline.rs` preload / drop_pending | threaded session loads are joined when a job ends or restarts | code | | NOT-A-BUG | |
| C4 | `pipeline.rs` low-VRAM stage 2 | the producer thread is joined after its receiver is dropped | code | | NOT-A-BUG | |
| C5 | `pipeline.rs` trim_host_memory | `malloc_trim` only after unloads; preload CUDA-only (the efficiency pass's multijob: RSS flat) | efficiency pass measurement | | NOT-A-BUG | |
| C6 | `gpu.rs` visible_index | multi-GPU: NVML's index (PCI order) for CUDA_VISIBLE_DEVICES' first entry may not be CUDA's device 0; UUIDs aren't read. One card is unaffected | code reading | LOW | BACKLOG (row 17) | |
| C7 | engine | orphan engine / builder | = E2, E3 | | FIXED | |

## 5. App

| id | file:line | what | how found | sev | verdict | test |
|---|---|---|---|---|---|---|
| A1 | `electron/main/queue.ts` ensureEngine | Stop while the engine was still starting showed the engine as failed ("engine exited before answering (SIGKILL)"): the start's rejection came after stop() had reset the state | vitest | LOW | FIXED: the rejection of a replaced engine is ignored | `queue.test.ts` stop while the engine is still starting… |
| A2 | `queue.ts` finish, `index.ts` | Every finished job left an empty `jobs/<id>` folder (the engine deletes its files, not the folder); a crash or a killed engine left its files (GBs in low-VRAM) | vitest | LOW | FIXED: every job end removes the folder (on stop, after the kill); stale folders go at app start | `queue.test.ts` removes a job's temp folder…, clears job temp folders left by an earlier run |
| A3 | `index.ts` addPaths, `validate.ts` uniqueOutputDir | Two queued clips with the same name (shot.mp4 + shot.mov, or same-named clips when results go into one folder) shared `out_<name>` and the same file names: the second job overwrote the first one's results | code + clipName / engine naming | MEDIUM | FIXED: the second gets `out_<name>-2` (the same clip added again keeps its folder) | `validate.test.ts` two clips with the same name… |
| A4 | `index.ts` registerIpc | IPC handlers took their arguments as typed (job options straight to the engine, appearance values straight into the settings file, `pickRustEngine("__proto__")` threw) | code reading | MEDIUM | FIXED: every handler takes `unknown` and validates (`validate.ts`) | `validate.test.ts` |
| A5 | `settings.ts` loadSettings | settings migration: an older or hand-edited settings.json loaded unknown output names (every job then failed `input`) and half a manual window as they were | vitest | MEDIUM | FIXED: each value checked, invalid ones fall back to defaults | `validate.test.ts` a settings file from an older… |
| A6 | `index.ts` single instance | app.quit() after a failed single-instance lock doesn't stop the ready handler: a second copy still ran it (window, updater, A2's cleanup) and removed the first copy's running job folder | isolated two-copy run | MEDIUM | FIXED: the second copy returns at ready | `tools/two_copies_e2e.sh` (before: "REMOVED", now: PASS) |
| A7 | `index.ts` WAYLAND_REQUIRED | Wayland-only exit path: under X11 the "needs Wayland" dialog shows and waits for OK; with no display Chromium exits at once ("Missing X server") | isolated AppImage runs, screenshot | | NOT-A-BUG | |
| A8 | `App.tsx` onDrop, `index.ts` addPaths | drop handling: non-file drops add nothing; a clip already waiting isn't added twice; folders expand one level | code | | NOT-A-BUG | |
| A9 | `src/shared/tasks.ts` | a clip with a probe error shows its reason on the row but raises no task dot | code vs the task rule | LOW | BACKLOG (row 18): Marcy's call | |
| A10 | `src/ui/theme/useTheme.ts` | theme / Glass / desktop accent re-apply on every appearance or desktop palette change | code | | NOT-A-BUG | |
| A11 | `queue.ts` | remove / retry / stop races: a running job can't be removed; only failed / cancelled ones retry; stop then start ignores the old engine's late exit | vitest | | NOT-A-BUG | `queue.test.ts` |
| A12 | `engine.ts` | engine failing to start / protocol mismatch → the job fails, the engine card says why, the queue stops | vitest | | NOT-A-BUG | `engine.test.ts`, `queue.test.ts` |

## 6. Updater: the restart problem

**Symptom** (before the hunt): in `tools/update_e2e.sh` the old AppImage runtime stayed alive after "Restart now",
and the new copy started but never answered on its DevTools port.

**Measured** (the harness's new failure dump: each test process's state, kernel wait channel, pipes, threads):

1. The old runtime's keepalive thread sat in `anon_pipe_write`; the new copy's runtime and its Electron held
   `fd 3 -> pipe:[23655861]`, the old runtime's keepalive pipe (plus the old copy's Chromium pipes). The fallback
   `spawn("/bin/sh", …)` passes on every descriptor without close-on-exec, so the old mount lived as long as the
   new copy.
2. The new copy did start (zygotes, GPU process, renderer), but its log said `bind() failed: Address already in
   use … Cannot start http server for devtools`: `sleep 0.5` is shorter than a quit, so the new copy started while
   the old one still held the port (and, for users, both ran on one profile for a moment). A 0.2 s sampler of the
   port also showed the mount guard helper holding the old copy's descriptors.
3. The mount guard (`holdAppImageMountUntilExit`) was started after the relaunch shell, so it counted that shell
   (which becomes the new copy) as one of ours and always waited its full 5 s, holding the old mount and every
   descriptor it inherited.
4. The old harness ran on Xvfb; the app is Wayland-only, so a newer copy shows its "needs Wayland" dialog there
   (A7) instead of a window.

**Fixed**: the fallback runs bash, which closes every inherited descriptor above stderr (dash can't name
descriptors above 9) and waits for the old process to end (≤ 15 s); the mount guard starts before the new copy;
the harness runs on headless KWin, uses `--remote-debugging-port=0` + `DevToolsActivePort` (the two copies never
compete for one port), samples the mounts, and lists only processes in its own cgroup (it used to match a
CorridorKey AppImage of the user's by name and could have killed it at cleanup).

**Result**: PASS, the new copy's page up 1.0 s after "restart", the old mount gone 0.16 s after it (with the
guard after the relaunch shell: ≥ 2.9 s, until the test closed the new copy).

| id | file:line | what | how found | sev | verdict | test |
|---|---|---|---|---|---|---|
| U1 | `electron/main/relaunch.ts`, `updater.ts` relaunch | the fallback shell passed the old runtime's keepalive pipe (and every other inherited descriptor) to the new copy: the old runtime and mount lived as long as the new copy | update_e2e diagnostics | HIGH | FIXED | `relaunch.test.ts` the shell fallback (bash) waits for the old copy and drops the descriptors it inherited (fd 3 present before) |
| U2 | `relaunch.ts` | the new copy started 0.5 s after the restart, while the old one still ran (DevTools port still bound; two copies on one profile) | chromium log of the new copy | MEDIUM | FIXED: waits for the old pid (≤ 15 s) | the same test (`startedAfterOld`), and plain sh still starts it |
| U3 | `updater.ts` relaunch | the mount guard waited its full 5 s on the relaunch shell, holding the old mount and descriptors | mount sampler: ≥ 2.9 s → 0.16 s | LOW | FIXED: guard first | `tools/update_e2e.sh` (mounts.log) |
| U4 | `tools/update_e2e.sh` | ran on Xvfb (the app is Wayland-only); one fixed DevTools port for both copies; no diagnostics | the runs above | MEDIUM | FIXED: headless KWin, port 0 + DevToolsActivePort, failure dump | the harness itself (PASS) |
| U5 | `tools/update_e2e.sh` test_pids | picked processes by name (`\.mount_Corrid`): a CorridorKey AppImage of the user's matches and would be killed at cleanup | code reading (a scratch probe with the same pattern listed its own shell) | HIGH | FIXED: only processes in the harness's own cgroup | the harness |
| U6 | `updater.ts` relaunch (systemd-run path) | the normal path also starts the new copy at once, while the old one quits; it can't run in the isolation (no user manager) | code reading | LOW | BACKLOG (row 16): wrap the target in the same wait | |

## 7. Gates, builder, tools

| id | file:line | what | how found | sev | verdict | test |
|---|---|---|---|---|---|---|
| G1 | `ck-core/src/image.rs` lanczos4_coeffs | clippy error: `S45` written out (approx_constant) | cargo clippy | LOW | FIXED: `std::f64::consts::FRAC_1_SQRT_2` (the same double) | `cargo clippy -- -D warnings` |
| G2 | `ahead.rs`, `decode.rs`, `pipeline.rs`, `runtime.rs` | clippy warnings: inherent `next()` (should_implement_trait ×4), type_complexity, bool assert | cargo clippy | LOW | FIXED; `npm run check:engine` = fmt --check + clippy --all-targets -D warnings + cargo test | |
| G3 | `engine-rs/tools/trt-build/ck_trt_build.cpp` | a malformed number (`std::stoll` throws) ended in std::terminate: exit 134, a core dump, no JSON line for the engine | ran the builder with `--min "a:1xZ"` | LOW | FIXED: any exception → `{"ok":false,…}`, exit 1 | the same call after build.sh: `{"ok":false,"error":"bad argument: stoll"}` (needs the TensorRT libraries: not in cargo test) |
| G5 | `tests/unit/media.test.ts` | each test run left five `ck-media-*` folders in /tmp (RAM on this machine; ~90 had piled up) | counted: +5 per run | LOW | FIXED: removed after the file's tests | the count: +5 → +0 |
| G6 | `tools/isolated.sh` | the EXIT trap that removes the runtime folder never ran (the shell `exec`'d systemd-run): every isolated copy left a `/tmp/ck-iso-*` folder (8 there) | code + the leftovers' dates | LOW | FIXED: systemd-run runs as a child | one isolated run, closed over CDP: no folder left |
| G4 | efficiency pass #18 | one decode pass for the low-VRAM RVM + foundation phases (~1 s per job) | the efficiency pass | | BACKLOG (row 15): idea | |

## Gates and regression

All at the branch's last code commit:

- `npm run check`: typecheck, Prettier, gates (loop gate 533 rows, all with a verdict), vitest 13 files / 92 tests,
  engine tests 4: pass.
- `npm run check:engine` (new): `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` (clean; it caught
  one `useless_vec` in this hunt's own test), `cargo test` 63 tests (ck-core 46 + parity 8, protocol 8, lifetime 1):
  pass.
- CPU end-to-end parity (`engine-rs/tools/e2e_cpu.sh`, `2.0.0-onnx.2` fp32, four jobs): pass; alpha MAE 2.48e-7
  against PyTorch fp32 (as before), low-VRAM identical to normal mode.
- The inputs the fixes change, end to end (CPU): the NaN / infinity EXR plate gives no non-finite value (0 of
  512000 alpha, 0 of 1536000 fg values; against the clean plate 1.56 % of alpha pixels differ by > 1/255, the
  four changed input pixels still reach their neighbours); the variable-frame-rate MKV writes its 8 frames; portrait
  and 40×24 clips stop at once with the `input` messages; outputs carry `iec61966-2-1` / `bt709`.
- `tools/update_e2e.sh` on AppImages built from the final code: PASS (new page 1.0 s after the restart, old mount
  gone within one 0.2 s sample), no processes or mounts left. `tools/two_copies_e2e.sh`: PASS.
- **Regression bench**: `tools/engine_bench.mjs` on the six clips, CUDA fp16, `2.0.0-onnx.2`, 12 GB budget, alpha +
  fg, automatic window (guarded: GPU lock, Sonata / other-GPU check, memrun 16, timeout); outputs
  `~/.cache/claude-scratch/ck-bughunt/bench/final2`. `tools/matte_compare.py --roots` against the efficiency
  audit's `ck-audit/bench/final1`: **alpha and fg identical on all six clips (MAE 0, max 0, PSNR inf)**. The video
  files themselves now differ in their colour tags only (E8: `color_transfer` / `color_primaries` were `unknown`,
  now `iec61966-2-1` / `bt709`); no fix changed a pixel of a finite, landscape input. Totals: godiva_close 33.2 s
  (audit 33.6), locked_backdrop 17.7 (18.0), metal_glasses 25.4 (25.7), smoke 43.9 (44.4), walking_sitting 53.7
  (54.4), with_motion_blur 10.6 (10.7); peak VRAM 8.08-9.44 GB, peak RSS 3.74-5.89 GB (as before).
