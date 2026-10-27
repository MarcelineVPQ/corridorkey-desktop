# The Rust engine (ONNX Runtime)

`engine-rs/` is CorridorKey's engine in Rust on ONNX Runtime (Marcy 2026-10-21: Rust + ORT is the
house engine stack). It speaks [ENGINE_PROTOCOL.md](ENGINE_PROTOCOL.md) exactly like the PyTorch engine
(`tools/reference/ck_engine.py`, not part of the app), which stays as the benchmark reference for the comparison
tools (Marcy 2026-10-22). Measured on 2026-10-21; every
number below comes from a run whose command is given or from the tests.

## Architecture

```
engine-rs/
  crates/ck-core/      the pipeline (library)
    clip.rs            probe: ffprobe read like cv2.VideoCapture, frame folders, 128 px padding
    decode.rs          ffmpeg decode with cv2's colour conversion, PNG/JPEG/EXR stills, hints, prefetch thread
    color.rs           sRGB <-> linear, signed asinh, despill, bf16/f16 rounding (color_utils.py)
    ocio.rs            colour management: OCIO configs, input/output processors, the colorspaces reply ("Colour")
    image.rs           reflect-101 pad/crop, area / bilinear (torch) and Lanczos-4 (cv2) resamplers
    hann.rs            window_starts, taper_weights, the baton blend
    vram.rs            select_vram_profile / estimate_peak_vram_gb (the upstream search and margins; the table is
                       this engine's measured ONNX Runtime peaks, BACKLOG row 41)
    runtime.rs         ORT environment, CUDA / TensorRT / CPU providers, model files, sessions
    tensorrt.rs        TensorRT shape ranges, profiles, cache folders, ck-trt-build runs
    pipeline.rs        run_inference + hann_stage1_stream (normal and staged low-VRAM paths)
    ahead.rs           work done ahead on its own thread (network inputs while the card runs)
    outputs.rs         the render thread: render + hand-off to the writers, frame counts back
    render.rs          alpha / fg / checker / cutout, video (uint16) and EXR (float) paths
    writers.rs         ffmpeg writers (lossless H.264 / DNxHR 444 / x264 CRF 12, 10-bit 4:4:4; the cutout premultiplied, no alpha) and EXR sequences
    job.rs, settings.rs  run options (ck_engine.py's defaults), <clip>_settings.txt
  crates/ck-engine/    the corridorkey-engine binary: the protocol loop (lib.rs) and main.rs
  crates/ck-cli/       the corridorkey command line for render farms and power users (docs/CLI.md): ck-core linked in
  tools/gen_fixtures.py   parity fixtures from the upstream Python functions
  tools/e2e_cpu.sh        CPU end-to-end parity check
  tools/trt-build/        ck-trt-build: strongly typed TensorRT engine builder (C++), build.sh
  vendor/ocio-sys/        OpenColorIO's Rust FFI crate with its C++ sources, patched for MinGW (vendor/README.md)
```

One job, as in `runtime.run_inference`: probe → window (automatic or the job's) → RVM prepass (one
recurrent step per frame, features as float16 in `temp_dir`) → stage 1 on Hann windows (C-RADIO and MoGe
per window, hint video / carry hint / first-frame hint, taper-weighted blend of the batons) → stage 2 per
frame as soon as its blended baton is final → render → writers. Low-VRAM mode stages it (foundations to
`temp_dir`, stage 1 batons to `temp_dir`, then stage 2) with only that phase's networks loaded; ONNX Runtime
can't chunk attention inside a graph the way PyTorch's low-VRAM mode does, so here it saves the other
networks' weights, not stage 1's activations.

Faithful to the runtime where it matters for parity: decoded frames, hints and hint quality are rounded to
bfloat16 as the runtime's tensors are; RVM features and batons to float16 as its memmaps; frames are
counted when handed to the writers; the replies, error codes and settings file are the Python engine's.

## Models

`--models DIR` (or `CK_ENGINE_MODELS`): one ONNX file per network and precision. A `models.json` in the
folder names them (`{"fp16": {"stage1": "stage1_op23fp16.onnx", …}, "fp32": {…}}`); without one, the first
existing default name is used: `<piece>_fp16.onnx`, `<piece>_op23fp16.onnx`, `<piece>.fp16.onnx` (fp32:
`<piece>_fp32.onnx`, `<piece>_op23.onnx`, `<piece>.fp32.onnx`, `<piece>.onnx`). Pieces: `cradio`, `moge`,
`rvm`, `stage1`, `stage2` (the ONNX spike's exports, `engine-rs/export`,
built from the CorridorKey2.0 clone). Precision: fp16 on the GPU, fp32 on the CPU; `CK_ENGINE_PRECISION` overrides.

Use the **`2.0.0-onnx.4`** set (the app downloads it since 2026-10-25): `2.0.0-onnx.3` with MoGe, RVM, stage 1 and
stage 2 computed under CorridorKey 2.0's own precision policy (fp16 conv/matmul/attention, fp32 norms, softmax,
exp/pow, sums and upsampling; `docs/ONNX_EXPORT.md` "Production model set"). Its fp16 stage inputs are fp16; the
engine feeds each input in its graph's declared type. `2.0.0-onnx.3` is `2.0.0-onnx.2` (stage 1 and stage 2 with
three exact graph rewrites: window pads, depatchify ConvTranspose, grouped 7×7 convs;
`engine-rs/export/speed_patches.py`) with C-RADIO re-exported so it takes portrait frames (`docs/ONNX_EXPORT.md`
"Portrait"). Same outputs as `2.0.0-onnx.1`. The engine runs all four. The current speed numbers (onnx.3, the
engine and runtime the app ships) are in the README, "Speed"; the table below is the onnx.2 run of 2026-10-21, and
onnx.3 gives identical landscape output at the same speed ("Portrait" below). The engine reads the set's version
from `manifest.json` and refuses portrait clips up front (an `input` error) only for onnx.1 / onnx.2.

## Build and run

```
cd engine-rs
CARGO_TARGET_DIR=~/.cache/claude-scratch/corridorkey-rust/target cargo test          # CPU, static ORT
cargo build --release -p ck-engine --no-default-features --features ort-dynamic,tensorrt  # GPU build
corridorkey-engine --models DIR [--ort libonnxruntime.so] [--device auto|cuda|cpu|coreml]
```

**The copy inside the app:** `npm run build:engine` (`tools/build_engine.sh`, also the first step of
`npm run dist:linux`) links it against glibc 2.28 with cargo-zigbuild, the oldest Electron supports, so it
runs on every Linux the app runs on (a plain build on this desktop needs 2.43, newer than Ubuntu 24.04 or
Debian 12 have). Same compiler and optimisation; only the glibc it links against differs. It lands in `engine-rs/target/dist/`, and
electron-builder copies it to `resources/engine/corridorkey-engine`, where the Engine page finds it
("Included with the app"). `tools/isolated.sh --packaged release/linux-unpacked` runs that packaged build.
The engine runs `ffmpeg` / `ffprobe` from the system: they are not bundled.

`npm run check:engine` (from the repository root) is the engine's gate: `cargo fmt --check`, `cargo clippy --all-targets
-- -D warnings` (no warning passes) and `cargo test`.

- Default features: pyke's static CPU ONNX Runtime (downloaded at build time), for tests.
- GPU build: ONNX Runtime loaded at run time (`--ort`, `CK_ENGINE_ORT`, `ORT_DYLIB_PATH`), measured with the
  `onnxruntime-gpu` 1.31 wheel's library (CUDA 13, needs NVIDIA driver ≥ 580). The CUDA, cuDNN and TensorRT
  libraries must be on `LD_LIBRARY_PATH`; the app adds the wheel layout's `nvidia/*/lib` and
  `tensorrt_libs` next to the ORT library it is given (`electron/main/engine.ts`, `rustEngineEnv`).
- `--device cpu` runs ONNX Runtime's CPU provider (tests). Without a usable GPU, jobs fail with `no-gpu`,
  as with the PyTorch engine.
- `--device coreml` (macOS only; elsewhere the engine stops with an error) runs ONNX Runtime's Core ML provider
  (BACKLOG row 24, phase 1): ML Program format, fp16, compute units `CK_ENGINE_COREML_UNITS` (all | cpu-gpu |
  cpu-ane | cpu; default cpu-gpu: with the Neural Engine allowed, every load of stage 2 compiled it again for ~145 s
  and its first call passed 9.7 GB on a 16 GB Mac; on CPU + GPU a 1280×1080 job peaks at 1.8-3.4 GB, "Core ML on a 16 GB
  Mac" below), compiled models cached under `CK_ENGINE_COREML_CACHE` (default `coreml` next to the
  TensorRT cache root, e.g. `~/Library/Caches/corridorkey-desktop/coreml`; one folder per ORT version, units and
  file). Core ML compiles for fixed shapes, so it runs the **Core ML set**: `coreml.json` in the models folder lists
  one file per network, padded size and frames per call (`engine-rs/export/coreml/build_coreml_models.sh`; the
  files keep their weights in the shipped `.onnx.data`; on a Mac the app's setup downloads the set into the model
  set's folder, docs/ONNX_EXPORT.md "Core ML set"). A job whose size or window the set lacks is refused
  (bad-request naming what the set has); without a window the job takes the set's smallest, low-memory. The low-memory
  prepass's last C-RADIO / MoGe chunk is padded to the fixed batch with copies of its last frame (batch items are
  independent; only its own frames are kept). Sessions are made with ORT's CPU fallback off
  (`session.disable_cpu_ep_fallback`): every node runs on Core ML or the session fails with ORT's reason; nothing
  falls back to the CPU silently. The pong says `coreml_available` (and `unavailable` when it isn't); the job's
  `provider` reply says `coreml` only once its sessions exist (`coreml.nodes` "all", `partitions` null: ORT
  doesn't report the count).
- Session settings (measured, "Speed" below): graph optimisation `ORT_ENABLE_ALL` (the `ort` crate's `Level3`
  is only `ORT_ENABLE_LAYOUT`); cuDNN convolution search heuristic; attention on ORT's own flash kernels
  (the engine sets `ORT_ENABLE_CUDNN_FLASH_ATTENTION=0` unless the environment sets it); arena shrinkage only
  while stage 1 and stage 2 are loaded together.
- Knobs: `CK_ENGINE_VRAM_BUDGET_GB` (default `vram_budget_gb`), `CK_ENGINE_ARENA_SHRINK` (all | 0 | a list of
  networks; default: only when stage 1 and 2 share the card), `CK_ENGINE_CUDNN_SEARCH` (heuristic |
  exhaustive | default), `CK_ENGINE_CUDNN_MAX_WORKSPACE`, `CK_ENGINE_GRAPH_OPT` (all | layout | extended),
  `CK_ENGINE_PROFILE=<dir>` (ORT per-node profile; on CUDA it times kernel launches, not GPU work),
  `CK_ENGINE_THREADS`; TensorRT: `CK_ENGINE_TRT_CACHE` (engine folder; the app passes its cache folder + `tensorrt`, else the system cache folder: `~/.cache`, `%LOCALAPPDATA%\corridorkey-desktop\cache`, `~/Library/Caches`), `CK_ENGINE_TRT_BUILD` (ck-trt-build,
  else next to the engine binary), `CK_ENGINE_TRT_BUILD_TIMEOUT_S` (one engine build's deadline, default 1800 s).
  Also `CK_ENGINE_DEVICE` (auto | cuda | cpu | coreml, = `--device`), `CK_ENGINE_PRECISION` (fp16 | fp32), `CK_ENGINE_MODELS`,
  `CK_ENGINE_ORT` / `ORT_DYLIB_PATH`, and `CK_ENGINE_PARENT_PID` (the app passes its pid; the engine ends with that
  process, ck-core `proc.rs`). All are read once at startup (`ck-core/src/config.rs`, `EngineConfig`; flags win
  over the environment, an empty value is unset); an unknown value stops the engine with an error naming the
  variable (it used to fall back to the default silently). The settings go to stderr at startup and into the pong
  (`config`). `ORT_ENABLE_CUDNN_FLASH_ATTENTION` stays an environment variable set first thing in `main`, before
  any thread: the CUDA provider's `sdpa_kernel` option would replace ORT's whole kernel choice, not only switch
  cuDNN's off.
- No open-ended waits: ffprobe 120 s, `ffmpeg -version` 30 s, each TensorRT build `CK_ENGINE_TRT_BUILD_TIMEOUT_S`, a
  writer finishing its file 300 s (then ffmpeg is killed and the job fails saying so) (`proc.rs`,
  docs/LOOP_PASS_2026-10.md).

## The app

The engine ships inside the AppImage (`resources/engine/`); its GPU runtime and models are downloaded on first start
into `~/.local/share/corridorkey-desktop` (`electron/main/install.ts`, Engine page, Runtime and models). The Engine
page lists every copy it finds (`electron/main/engineFind.ts`; Automatic = the newest, Browse… for anything else);
`CK_ENGINE_BIN` / `CK_ENGINE_MODELS` / `CK_ENGINE_ORT` override the lists, and `CK_ENGINE_LD_LIBRARY_PATH` (folders,
`:`-separated, `;` on Windows) adds library folders after the runtime's own (`electron/main/engine.ts`). The queue runs when the engine's program
and models are there (`electron/main/settings.ts` `checkRustEngine`); the Engine page says whether it is set up.

## Graphics memory

`vram_budget_gb` (run option) caps the job: the automatic window's budget is min(free + own, budget), and
each CUDA session's arena limit (its own weights and working memory) is the budget minus the CUDA context
(measured after the first session), the weights (size on disk) of the other networks loaded while that arena holds
working memory, and a 0.5 GiB reserve (measured: without it the process peaked 0.17-0.22 GiB over a 12 GiB budget).
In normal mode those are all four others; in low-VRAM mode its own phase's and the next phase's, loaded ahead
(`sharing` in pipeline/mod.rs: RVM with C-RADIO + MoGe, C-RADIO / MoGe with each other and stage 1, stage 1 with
stage 2, stage 2 alone). Until 2026-10-27 low-VRAM arenas left room for all five networks: at a 4 GiB budget 1/1
windows the estimate fits failed `oom` with the process at 1.33-1.78 GiB (RTX 2070 SUPER); now HD and 4K 1/1 run
at 4 GiB, peaks 1.95 and 3.19 GiB (RTX 5080). While stage 1 and stage 2 are both loaded (normal mode) their arenas give
their working memory back after every run, so their peaks don't add up; in the low-VRAM phases a network has
the card to itself and keeps its arena (a shrunk arena allocates again on the next run: with the onnx.1
models stage 2 took 159 ms per call that way, and without shrinking its ConvTranspose asked for 5.77 GB and
failed `oom`; the onnx.2 ConvTranspose rewrite removed that request). The window table below was measured
with onnx.1 and every arena shrinking.

The automatic window came from the upstream PyTorch table, as ported, until 2026-10-24; since then from this
engine's measured ONNX Runtime CUDA peaks, an upper bound at every measured point (BACKLOG row 41). With the old table:
on CUDA fp16 at 1280×1152 a 16-frame window doesn't fit 12 GB, where the table picks 48/24 low-VRAM. So an
automatic window that runs out of memory before any frame reached the writers is halved and the job
restarted; a second `memory` reply says so (`retry_after_oom`). Only an out-of-memory in the phase the window sizes
(stage 1 on the windows; in the normal mode also C-RADIO, MoGe and stage 2 inside them) is retried: one in the RVM
prepass or the low-VRAM foundations and stage-2 pass fails at once with its own cause (senior Rust review
2026-10-26 S2). Measured peaks (nvidia-smi every 250 ms, the
process tree; short peaks can be missed, the same method as the PyTorch baseline), CUDA fp16, 12 GB budget,
one window:

| padded size | 2 | 4 | 8 | 12 | 16 | 24 | 32 |
|---|---|---|---|---|---|---|---|
| 1024×768 (0.79 MP) | | 5.45 GB | 4.40 GB | 6.65 GB | 8.48 GB | 12.17 GB, later oom at the limit | oom |
| 1280×1152 (1.47 MP) | | 10.12 GB | 10.12 GB | 10.92 GB | oom | | |
| 1920×1152 (2.21 MP) | 5.47 GB | 10.80 GB | | | | | |

## Parity

Ported math against the Python functions' own outputs (`cargo test -p ck-core --test parity`; fixtures by
`tools/gen_fixtures.py` from the CorridorKey2.0 venv): max |difference|

| what | measured |
|---|---|
| sRGB→linear (relative) / linear→sRGB / linear→asinh / asinh→linear (relative) | 4.0e-7 / 4.8e-7 / 1.2e-7 / 0 |
| despill (0.3, 0.5, 1.0) | 0 |
| frame preprocessing (pad, linear, asinh, bfloat16) | 0 (identical bfloat16) |
| area resize (C-RADIO 1/4, MoGe 7/32) / bilinear down, up | 1.8e-7 / 6.0e-8, 1.2e-7 |
| cv2 Lanczos-4 up, down | 4.2e-7, 3.6e-7 |
| hint frame (gray, Lanczos, pad, bfloat16) | 1 bfloat16 step (3.9e-3) in places |
| taper weights / window starts / VRAM table (360 cases) | 3.0e-8 / identical / identical (the VRAM table compared until 2026-10-24; since then it is this engine's measured table, BACKLOG row 41) |
| render: video uint16 alpha, fg, checker, cutout, cutout linear | 0 |
| render: EXR float (relative) | ≤ 7.5e-9 |
| stills: 8- and 16-bit PNG, JPEG (libjpeg-turbo), 16-bit hint | 0 |
| video decode vs cv2 4.11 (ProRes 4444 plate, BT.709-tagged and untagged H.264, 10-bit 4:4:4) | 0 |
| default input reading vs CorridorKey 2.0's reader, bytes (12-bit ProRes 4444, 10-bit ProRes 422 HQ, 16-bit PNG RGB / RGBA / gray; `default_reading_is_corridorkey_byte_identical`, fixtures from `tools/gen_input_fixtures.py`) | 0 (identical bytes) |

Input reading (2026-10-25): by default the engine reads every input as CorridorKey 2.0's video_io does, 8 bits
through OpenCV's conversion (video at any depth, 16-bit PNG by its high byte). `input_bit_depth: "16"`
(ENGINE_PROTOCOL.md) keeps a deep source's bits instead (backlog row 27), on purpose different from the original.
The 8-bit video read asks ffmpeg for `bgr24`, as OpenCV asks swscale: with `rgb24` (before 2026-10-25) swscale's
other output writer rounded 10/12-bit 4:2:2 and 4:2:0 sources differently, by up to 4 levels on more than half the
samples (8-bit sources and 4:4:4 were identical either way).

End to end, tiny clip (320×200, 8 frames, window 4/2), against PyTorch fp32 on the CPU (the ONNX spike's
`run_parity.py torch`); fg compared after the same float16 rounding the reference was stored with:

| engine | alpha MAE | alpha max | % > 1/255 | fg PSNR (all / subject) |
|---|---|---|---|---|
| Rust, CPU fp32 (`tools/e2e_cpu.sh`) | 2.39e-7 | 1.73e-4 | 0 | 101.7 / 95.4 dB |
| Rust, CUDA fp32 | 2.56e-7 | 1.78e-4 | 0 | 101.2 / 94.9 dB |
| Rust, CUDA fp16 | 4.13e-5 | 1.03e-2 | 0.044 | 73.1 / 66.3 dB |
| PyTorch CUDA bf16 autocast (what ships) | 3.62e-4 | 2.64e-2 | 1.505 | 56.9 / 49.9 dB |

Low-VRAM staging gives identical output (max 0). On a real plate (locked_backdrop, 1280×1080, 80 frames,
window 4/2 low-VRAM, both encoded by x264 CRF 12), against the Rust engine's CUDA fp32 run: Rust fp16 alpha
MAE 3.41e-4, max 6.25e-2, 3.08 % > 1/255; PyTorch bf16 5.00e-4, 2.23e-1, 3.57 %.

## Graphics memory: the measured table (BACKLOG row 41, 2026-10-24)

**Re-measured on model set onnx.4 (2026-10-26).** This section is the onnx.3 measurement. The app ships onnx.4 since
2026-10-25; the same sweep on it (85 points: 69 ran, 16 out of memory; engine 1afed1c) found this table under the
measured peak at 31 of 69 points (up to 16 %) and 1920×1080 48/24 low-VRAM out of memory where it had run at 11.35
GiB. `vram.rs` now holds the onnx.4 table, built by the same rules (its header says how, and how the three 960×720
low-VRAM windows onnx.4 didn't measure are filled); `measured_peaks_are_bounded` holds the onnx.4 points: the estimate is
at least 0.12 GiB over every one, 6-7 % over at 48 of 69, within 15 % at 54, up to 57 % over at small windows.

**Where memory is tight: the 8 GB card (2026-10-27).** An RTX 2070 SUPER 8 GB (onnx.4, engines 1e7cf76 and
fc927ec, `tools/engine_bench.mjs` as above with a 7.0 or 7.4 GiB `vram_budget_gb`; 68 runs, 23 points that ran, 3 out
of memory) ran the windows the table fits in up to 2.7 GiB less than the table (1920×1080 8/4 normal 4.92 GiB
against 6.17; 1280×1080 24/12 low-VRAM 5.34 against 8.04, and under its own 16/8, 5.65, which is 0.14 GiB over the
table, inside the +6 %). The table holds nothing twice (it is measured peaks, not a sum of weights, context and
working memory); the 16 GB card, measured with a 14 GiB budget, simply peaked higher. Why (cuDNN's workspace, the
arenas, the architecture) isn't measured.
Every point estimated within the budget ran and every out-of-memory point was estimated above it: safe, but 8 GB
cards got 8/4 at HD. `vram.rs` now has a second table, TIGHT, the 8 GB card's highest peak per point (rounded up,
monotone; 960×720, 1280×1080 and 1920×1080; the 16 GB table's value wherever it didn't measure, and for 1920×1080
16/8 low-VRAM, which ran but took 394 s for 32 frames, 8× its 8/4's time per frame). It is read only for a job with a
graphics-memory limit (its `vram_budget_gb` or `CK_ENGINE_VRAM_BUDGET_GB`), as every run above had: without one (the
app's Auto, no arena capped) the estimate is the 16 GB table's, dev.1's windows, until Auto is measured on an 8 GB card
(senior review 2026-10-27 S2). With a limit, one formula for both:

- a window fits a budget when its TIGHT peak (+6 %) does, by the same rule as before (× 1.1 + 0.3 GiB): a window needs
  at least its highest measured peak + 16.6 % + 0.3 GiB (HD 24/12 low: measured 5.34, its 16/8's 5.65 carried up,
  needs 6.89 GiB);
- the estimate shown is the 16 GB table's peak (+6 %), no more than the budget lets a window peak once it fits
  (7.4 GiB: 6.45), else the TIGHT peak.

It rests on an assumption the runs don't show: a job that ran within 7.0-7.4 GiB runs within a larger budget and
within a smaller one its TIGHT peak plus the margin fits. Not measured: the app's Auto (no limit, the card's whole
free memory), budgets under 7.0 GiB, and a 16 GB card held to 7.4 GiB (if its peaks don't come down, the automatic
window's out-of-memory retry halves the window). Tests: `the_8_gb_cards_peaks_are_bounded_at_any_budget`,
`an_8_gb_card_gets_the_window_it_ran`, `an_8_gb_card_on_auto_keeps_the_16_gb_tables_windows`,
`larger_cards_keep_their_windows`.

| Card (budget GiB) | 1280×1080 before → after | 1920×1080 before → after | 4096×2160 |
|---|---|---|---|
| 6 GB (5.5) | 8/4 low → 8/4 normal | 2/1 low → 8/4 low | 1/1 low (same) |
| 8 GB (7.0) | 8/4 normal → 24/12 low | 8/4 low → 8/4 normal | 2/1 low (same) |
| 8 GB (7.4, measured) | 8/4 normal → 24/12 low | 8/4 low → 8/4 normal | 2/1 low (same) |
| 10 GB (9.3) | 8/4 normal → 24/12 low | 8/4 normal (same) | 2/1 low (same) |
| 12 GB (11.2) | 48/24 low (same) | 8/4 normal (same) | 4/2 low (same) |
| 16 GB (14.5) | 48/24 normal (same) | 24/12 normal (same) | 8/4 normal (same) |

The budgets are free memory as the engine reads it; only 7.0 / 7.4 (8 GB) and 14 (16 GB) were measured. 960×720 at
7.0 GiB goes from 8/4 to 24/12 normal (measured 5.39 GiB there).

| 8 GB card point | Mode | Window | Measured peak (highest) | TIGHT | 16 GB table |
|---|---|---|---|---|---|
| 960×720 | low | 1/1, 4/2 | 1.39, 1.77 | 1.39, 1.78 | 1.92, 2.61 |
| 960×720 | normal | 4/2, 8/4, 16/8, 24/12 | 3.25, 3.54, 4.38, 5.39 | 3.54, 4.38, 5.39 | 4.54, 5.09, 6.06 |
| 960×720 | normal | 48/24 | out of memory | 8.12 | 8.12 |
| 1280×1080 | low | 1/1, 2/1, 4/2, 8/4 | 1.50, 1.74, 2.26, 3.18 | 1.51, 1.75, 2.27, 3.18 | 1.92, 3.37, 3.57, 3.95 |
| 1280×1080 | low | 16/8, 24/12 | 5.65, 5.34 | 5.66, 5.66 | 5.51, 8.04 |
| 1280×1080 | normal | 1/1, 4/2, 8/4, 16/8 | 3.15, 3.51, 4.02, 5.30 | 4.03, 5.31 | 5.33, 6.29 |
| 1280×1080 | normal | 24/12 | out of memory | 8.05 | 8.05 |
| 1920×1080 | low | 1/1, 2/1, 4/2, 8/4 | 1.58, 2.07, 2.90, 4.43 | 1.59, 2.08, 2.91, 4.44 | 1.93, 4.29, 4.48, 5.15 |
| 1920×1080 | low | 16/8 | 5.45, 394 s (starved) | 7.81 | 7.81 |
| 1920×1080 | normal | 8/4 | 4.92 | 4.93 | 6.17 |
| 1920×1080 | normal | 16/8 | out of memory | 7.57 | 7.57 |

The peak estimate (`vram.rs`, one function for the automatic window, the `memory` reply and the `estimate` command)
is this engine's own measurement: peak graphics memory of the engine's process tree (nvidia-smi every 250 ms,
`tools/engine_bench.mjs`), RTX 5080 16 GB, ONNX Runtime 1.31 CUDA, a 14 GiB budget, the engine built from main that
evening; 76 short runs (enough frames for two or three windows; a 48-frame check matched the full-clip sweep within
0.5 %) plus row 37's 16 full-clip sweep runs and the README's four 4K 8/4 runs: 96 points, 81 that ran and 15 out of
memory, at six padded sizes (960×720, 1280×1080, 1920×1080 and 2560×1440 and 3200×1800 scaled from walking_sitting,
4096×2160). The table holds the highest peak per size and window, rounded up to 0.01 GiB and made monotone; an
unmeasured window takes the next measured one's peak, one past the largest that ran is proportional to the window
(at least 14 GiB where the card ran out of memory). It is read upward (the next table window and size at or above;
proportional past the largest) and gets **+6 %** on top: the largest spread between clips and runs at one point was
5.3 % (1280×1080 24/12 low: 7.04-7.38 GiB over five runs; 4096×2160 8/4 low: 9.13-9.42 GiB over six). Result: at
every measured point the estimate is at or above the real peak, by at least 0.12 GiB (`measured_peaks_are_bounded`
in vram.rs holds all 96 points); 56 of 81 are 6-7 % over, 75 within 15 %, the rest up to 70 % (small windows at
sizes where a smaller size peaks higher). Between measured sizes the bound assumes the peak grows with the size;
the measurements break that at single points (cuDNN chooses algorithms per shape: 1920×1080 at 2/1 and 4/2 low
peaks above 2560×1440), so an unmeasured size can exceed it. Linear interpolation between sizes was tried and
rejected: leaving out one size at a time, it fell up to 26 % under. TensorRT's peaks, other cards and drivers are
not in the table. The automatic window keeps the upstream margin (× 1.1 + 0.3 GiB) because a TensorRT job takes the
same window.

What it changes in the automatic window: at a 12 GiB budget the README's six HD clips and four 4K plates keep
their windows; godiva_close (960×720) keeps 80/40 but now in the normal mode (the old table put the normal mode at
12.9 GiB, measured 8.0). At a 16 GB card's ~14.5 GiB free, the 1280×1080 clips go from 48/24 low to 48/24 normal
and the 4K plates from 8/4 low to 8/4 normal (measured 10.5 and 11.0 GiB): the same windows, and low-VRAM staging
gives identical output, but TensorRT builds its engines per mode (a new one-time build, its peaks unmeasured).
A TensorRT job's automatic window therefore keeps low-VRAM mode (the same window, `select_vram_profile`'s
`low_only`; test `tensorrt_keeps_low_memory_mode`): the normal-mode peaks are measured on CUDA only, so TensorRT stays
in the mode it had before this table; the rule is lifted once TensorRT's normal-mode peaks are measured (row 54).

| Size (padded MP) | Mode | Window | Runs | Measured peak (highest) | Old estimate (PyTorch table) | New estimate | New − measured |
|---|---|---|---|---|---|---|---|
| 960×720 (0.79) | low | 1/1 | 1 | 1.90 | 2.71 (+42 %) | 2.02 | +0.12 (+6 %) |
| 960×720 (0.79) | low | 4/2 | 1 | 2.61 | 2.94 (+13 %) | 2.77 | +0.16 (+6 %) |
| 960×720 (0.79) | low | 8/4 | 1 | 2.72 | 3.25 (+19 %) | 2.89 | +0.17 (+6 %) |
| 960×720 (0.79) | low | 16/8 | 1 | 3.29 | 3.90 (+18 %) | 3.50 | +0.21 (+6 %) |
| 960×720 (0.79) | low | 24/12 | 1 | 4.38 | 4.54 (+4 %) | 4.64 | +0.26 (+6 %) |
| 960×720 (0.79) | low | 48/24 | 1 | 6.80 | 6.57 (-3 %) | 7.21 | +0.41 (+6 %) |
| 960×720 (0.79) | low | 80/40 | 1 | 9.20 | 9.50 (+3 %) | 9.75 | +0.55 (+6 %) |
| 1280×1080 (1.47) | low | 1/1 | 1 | 1.70 | 2.75 (+62 %) | 2.02 | +0.33 (+19 %) |
| 1280×1080 (1.47) | low | 2/1 | 1 | 3.37 | 2.86 (-15 %) | 3.57 | +0.21 (+6 %) |
| 1280×1080 (1.47) | low | 4/2 | 1 | 3.58 | 3.10 (-13 %) | 3.79 | +0.22 (+6 %) |
| 1280×1080 (1.47) | low | 8/4 | 4 | 3.99 | 3.60 (-10 %) | 4.24 | +0.25 (+6 %) |
| 1280×1080 (1.47) | low | 16/8 | 4 | 4.95 | 4.70 (-5 %) | 5.26 | +0.30 (+6 %) |
| 1280×1080 (1.47) | low | 24/12 | 5 | 7.38 | 5.81 (-21 %) | 7.82 | +0.44 (+6 %) |
| 1280×1080 (1.47) | low | 48/24 | 4 | 8.47 | 9.24 (+9 %) | 8.98 | +0.51 (+6 %) |
| 1280×1080 (1.47) | low | 80/40, 50-frame clip | 1 | 9.44 | 9.53 (+1 %) | 10.56 | +1.12 (+12 %) |
| 1280×1080 (1.47) | low | 56/28 | 1 | 9.96 | 10.41 (+5 %) | 10.56 | +0.60 (+6 %) |
| 1280×1080 (1.47) | low | 64/32 | 1 | 10.64 | 11.59 (+9 %) | 11.29 | +0.65 (+6 %) |
| 1280×1080 (1.47) | low | 80/40 | 1 | out of memory (14 GiB budget) | 13.95 | 14.84 | doesn't fit, as measured |
| 1920×1080 (2.21) | low | 1/1 | 1 | 1.82 | 2.80 (+54 %) | 2.02 | +0.20 (+11 %) |
| 1920×1080 (2.21) | low | 2/1 | 1 | 4.26 | 2.97 (-30 %) | 4.52 | +0.26 (+6 %) |
| 1920×1080 (2.21) | low | 4/2 | 1 | 4.50 | 3.35 (-26 %) | 4.78 | +0.28 (+6 %) |
| 1920×1080 (2.21) | low | 8/4 | 1 | 5.19 | 4.12 (-21 %) | 5.50 | +0.32 (+6 %) |
| 1920×1080 (2.21) | low | 16/8 | 1 | 6.97 | 5.91 (-15 %) | 7.40 | +0.43 (+6 %) |
| 1920×1080 (2.21) | low | 24/12 | 1 | 9.83 | 7.69 (-22 %) | 10.42 | +0.59 (+6 %) |
| 1920×1080 (2.21) | low | 48/24 | 1 | 11.35 | 13.20 (+16 %) | 12.03 | +0.68 (+6 %) |
| 1920×1080 (2.21) | low | 80/40 | 1 | out of memory (14 GiB budget) | 20.57 | 20.06 | doesn't fit, as measured |
| 2560×1440 (3.93) | low | 1/1 | 1 | 2.21 | 2.92 (+32 %) | 2.34 | +0.13 (+6 %) |
| 2560×1440 (3.93) | low | 2/1 | 1 | 2.65 | 3.23 (+22 %) | 4.52 | +1.86 (+70 %) |
| 2560×1440 (3.93) | low | 4/2 | 1 | 3.53 | 3.85 (+9 %) | 4.78 | +1.25 (+35 %) |
| 2560×1440 (3.93) | low | 8/4 | 1 | 5.44 | 5.09 (-6 %) | 5.78 | +0.34 (+6 %) |
| 2560×1440 (3.93) | low | 16/8 | 1 | 8.67 | 7.59 (-12 %) | 9.20 | +0.53 (+6 %) |
| 2560×1440 (3.93) | low | 24/12 | 1 | 8.61 | 10.10 (+17 %) | 10.42 | +1.81 (+21 %) |
| 2560×1440 (3.93) | low | 48/24 | 1 | out of memory (14 GiB budget) | 17.58 | 18.25 | doesn't fit, as measured |
| 3200×1800 (6.14) | low | 1/1 | 1 | 3.15 | 3.08 (-2 %) | 3.35 | +0.20 (+6 %) |
| 3200×1800 (6.14) | low | 2/1 | 1 | 3.72 | 3.57 (-4 %) | 4.52 | +0.79 (+21 %) |
| 3200×1800 (6.14) | low | 4/2 | 1 | 5.92 | 4.56 (-23 %) | 6.28 | +0.36 (+6 %) |
| 3200×1800 (6.14) | low | 8/4 | 1 | 9.86 | 6.73 (-32 %) | 10.46 | +0.60 (+6 %) |
| 3200×1800 (6.14) | low | 16/8 | 1 | out of memory (14 GiB budget) | 11.08 | 20.91 | doesn't fit, as measured |
| 3200×1800 (6.14) | low | 24/12 | 1 | out of memory (14 GiB budget) | 15.43 | 31.37 | doesn't fit, as measured |
| 3200×1800 (6.14) | low | 48/24 | 1 | out of memory (14 GiB budget) | 28.61 | 62.73 | doesn't fit, as measured |
| 4096×2160 (8.91) | low | 1/1 | 1 | 4.10 | 3.29 (-20 %) | 4.35 | +0.25 (+6 %) |
| 4096×2160 (8.91) | low | 2/1 | 1 | 4.44 | 4.01 (-10 %) | 4.72 | +0.27 (+6 %) |
| 4096×2160 (8.91) | low | 4/2 | 2 | 7.77 | 5.46 (-30 %) | 8.25 | +0.47 (+6 %) |
| 4096×2160 (8.91) | low | 8/4 | 6 | 9.42 | 8.79 (-7 %) | 10.46 | +1.04 (+11 %) |
| 4096×2160 (8.91) | low | 16/8 | 1 | out of memory (14 GiB budget) | 15.45 | 20.91 | doesn't fit, as measured |
| 960×720 (0.79) | normal | 4/2 | 1 | 4.17 | 6.19 (+48 %) | 4.63 | +0.46 (+11 %) |
| 960×720 (0.79) | normal | 8/4 | 1 | 4.37 | 6.19 (+42 %) | 4.63 | +0.27 (+6 %) |
| 960×720 (0.79) | normal | 16/8 | 1 | 4.75 | 6.86 (+44 %) | 5.04 | +0.29 (+6 %) |
| 960×720 (0.79) | normal | 24/12 | 1 | 5.54 | 7.52 (+36 %) | 5.88 | +0.34 (+6 %) |
| 960×720 (0.79) | normal | 48/24 | 1 | 7.10 | 9.77 (+38 %) | 7.54 | +0.44 (+6 %) |
| 960×720 (0.79) | normal | 80/40 | 1 | 7.99 | 12.89 (+61 %) | 8.48 | +0.49 (+6 %) |
| 1280×1080 (1.47) | normal | 1/1 | 1 | 3.88 | 6.72 (+73 %) | 5.44 | +1.55 (+40 %) |
| 1280×1080 (1.47) | normal | 4/2 | 1 | 4.75 | 6.72 (+42 %) | 5.44 | +0.69 (+15 %) |
| 1280×1080 (1.47) | normal | 8/4 | 2 | 5.13 | 6.72 (+31 %) | 5.44 | +0.31 (+6 %) |
| 1280×1080 (1.47) | normal | 16/8 | 1 | 5.89 | 7.88 (+34 %) | 6.25 | +0.36 (+6 %) |
| 1280×1080 (1.47) | normal | 24/12 | 2 | 7.45 | 9.05 (+21 %) | 7.91 | +0.46 (+6 %) |
| 1280×1080 (1.47) | normal | 48/24 | 2 | 10.54 | 13.34 (+27 %) | 11.17 | +0.63 (+6 %) |
| 1280×1080 (1.47) | normal | 80/40 | 1 | out of memory (14 GiB budget) | 17.71 | 18.62 | doesn't fit, as measured |
| 1920×1080 (2.21) | normal | 8/4 | 1 | 5.90 | 7.50 (+27 %) | 6.25 | +0.36 (+6 %) |
| 1920×1080 (2.21) | normal | 16/8 | 1 | 7.00 | 9.42 (+35 %) | 7.42 | +0.42 (+6 %) |
| 1920×1080 (2.21) | normal | 24/12 | 1 | 9.30 | 11.33 (+22 %) | 9.87 | +0.57 (+6 %) |
| 1920×1080 (2.21) | normal | 48/24 | 1 | out of memory (14 GiB budget) | 18.67 | 19.73 | doesn't fit, as measured |
| 1920×1080 (2.21) | normal | 80/40 | 1 | out of memory (14 GiB budget) | 24.90 | 32.87 | doesn't fit, as measured |
| 2560×1440 (3.93) | normal | 8/4 | 1 | 6.02 | 9.06 (+51 %) | 6.38 | +0.37 (+6 %) |
| 2560×1440 (3.93) | normal | 16/8 | 1 | 7.90 | 11.92 (+51 %) | 8.38 | +0.48 (+6 %) |
| 2560×1440 (3.93) | normal | 24/12 | 1 | 10.14 | 14.79 (+46 %) | 10.75 | +0.61 (+6 %) |
| 2560×1440 (3.93) | normal | 48/24 | 1 | out of memory (14 GiB budget) | 23.93 | 21.50 | doesn't fit, as measured |
| 3200×1800 (6.14) | normal | 8/4 | 1 | 9.35 | 11.50 (+23 %) | 9.91 | +0.56 (+6 %) |
| 3200×1800 (6.14) | normal | 16/8 | 1 | out of memory (14 GiB budget) | 15.93 | 19.82 | doesn't fit, as measured |
| 3200×1800 (6.14) | normal | 24/12 | 1 | out of memory (14 GiB budget) | 20.37 | 29.73 | doesn't fit, as measured |
| 3200×1800 (6.14) | normal | 48/24 | 1 | out of memory (14 GiB budget) | 34.53 | 59.46 | doesn't fit, as measured |
| 4096×2160 (8.91) | normal | 8/4 | 2 | 11.01 | 14.55 (+32 %) | 11.68 | +0.67 (+6 %) |
| 4096×2160 (8.91) | normal | 16/8 | 1 | out of memory (14 GiB budget) | 20.95 | 23.35 | doesn't fit, as measured |

## Core ML on a 16 GB Mac (2026-10-27, Mac mini M6, macOS 27.0.1)

Every run under `tools/mac_memgate.c` (phys_footprint of the job's process tree, swap growth, memory pressure; killed
past 9 GB, +512 MB swap or pressure warn). 04_5d_hd (1280×1080, padded 1152×1280), EXR float, alpha + fg, the Core
ML set (1280×1080 clips only), Firefox and the desktop running beside it (about 12 GB available at the start).

- **Compute units `all` (the default until this date): unusable on 16 GB.** Each load of stage 2 took 145-188 s with
  ORT's compiled model already in its cache (`compiled_model.mlmodelc` untouched): Core ML compiled it for the Neural
  Engine again every time (two identical loads left two new ~0.9 GB bundles in `~/Library/Caches/<process>/
  com.apple.e5rt.e5bundlecache`), its load peaked at 5.1-5.7 GB and its first call passed 9.7 GB. Whole jobs: stage 1
  at window 4 over 12 GB (2026-10-26), at window 1 8.0 GB; the 2026-10-26 runs swapped 22.8 GB.
- **`cpu-gpu` (the default since): single networks load in 0.5-5.4 s (C-RADIO, MoGe, RVM, stage 1 up to 4
  frames, stage 2), the whole job peaks at 1.8-3.4 GB, the GPU at 95-99 % while the networks run (IOAccelerator).** Mattes against CUDA fp16, same window and frames (12, `matte_compare.py`): alpha
  max 1/255 or less, MAE 2.7-3.1e-5, 0 % of pixels over 1/255, alpha PSNR 79.1-79.7 dB, fg PSNR 74.6-74.7 dB.

| window | mode | peak footprint | 12 frames (cold / warm cache) | 120 frames |
|---|---|---|---|---|
| 1/1 | low-memory | 1.78 GB | 33.1 s | |
| 2/1 | low-memory | 1.79 GB | 39.8 s | |
| 4/2 | low-memory | 2.19-2.29 GB | 38.7 / 34.5 s | 714 s (0.17 fps) |
| 4/2 | normal | 2.49 GB | 37.8 s | |
| 8/4 | low-memory | 3.17-3.39 GB | 78.5 / 49.6 s | 491 s (0.24 fps) |

Per call (12-frame runs): stage 1 3.0 s per 4-frame window, 7-10 s per 8-frame window; stage 2 1.3 s per frame. The
120-frame runs were slower per call (stage 1 6.1 s per 4-frame window, stage 2 1.9-2.5 s per frame) with the Mac's
video wallpaper decoding beside them; not separated yet. Again on 2026-10-27 with the wallpaper switched off (WallpaperAerialsExtension and VTDecoderXPCService at
0 % CPU, sampled every minute) and the published set (`2.0.0-onnx.4-coreml` installed by the app's setup code, the
stage-1 8-frame file built the same way), cpu-gpu, alpha + fg EXR float, low-memory: 4/2 **160.2 s (0.75 fps)**, peak
2.36 GB, stage 1 1.35 s per 4-frame window, stage 2 0.56 s per frame; 8/4 **171.9 s (0.70 fps)**, peak 3.33 GB,
stage 1 2.84 s per 8-frame window, stage 2 0.57 s per frame (against 714 s / 491 s, stage 1 6.1 / 7.7 s, stage 2
2.5 / 1.9 s before). Two things changed between the runs (the wallpaper, and the set the earlier runs used), so the
gain isn't attributed to either. 4/2 is now the faster window. The 12-frame job of the published set against the
engine's CPU provider on the shipped fp16 set (same window, Linux PC): alpha max 0.0024 (under 1/255), MAE 1.1e-5,
0 % of pixels over 1/255, alpha PSNR 84.1 dB, fg PSNR 77.3 dB. The ORT cache: a warm load is 3-4x faster than a cold one
(job session loads 1.9 against 7.5 s at 4/2) and the compiled model is reused, not rewritten.

## Against the PyTorch engine (`tools/engine_bench.mjs`, 12 GB budget, alpha+fg, auto, no hint)

The current run (2026-10-24: onnx.3, the bundled engine built for glibc 2.28, the runtime the app downloads) is the
README's "Speed" table: 1.54-1.82× faster than PyTorch on every clip. The record below is the onnx.2 run it replaced.

RTX 5080, the six clips in `~/Videos/corridorkey-tests`, one engine process per clip, the same options for
both engines. Rust: CUDA fp16, the `2.0.0-onnx.2` models, two full runs on 2026-10-21 (both shown where they
differ). Total = spawn to exit. Steady fps = the engine's own `frames` replies after the first window; with
a low-VRAM window (every clip here, both engines) that is the stage-2 phase's rate, so the total is the fairer
comparison. VRAM / RAM = peak of the process tree (nvidia-smi / `/proc` every 250 ms).

| clip | PyTorch: window · total · steady fps · VRAM · RAM | Rust before (onnx.1): total · fps · VRAM · RAM | Rust now: total · fps · VRAM · RAM |
|---|---|---|---|
| godiva_close 960×720, 349 f | 80/40 low · 68.4 s · 20.04 · 9.37 · 9.93 GB | 54.9 s · 21.53 · 5.92 · 5.74 GB | **39.7 / 42.7 s** · 32.4 / 33.3 · 8.88 · 7.63 GB |
| locked_backdrop 1280×1080, 80 f | 48/24 low · 40.3 s · 8.30 · 11.97 · 9.40 GB | 36.9 s · 5.70 · 8.84 · 6.88 GB | **20.6 / 21.9 s** · 16.7 · 7.92 · 7.67 GB |
| metal_glasses, 139 f | 48/24 low · 44.7 s · 9.27 · 11.97 · 10.12 GB | 55.5 s · 5.74 · 8.84 · 6.60 GB | **30.0 / 29.9 s** · 16.6 · 7.93 · 7.95 GB |
| smoke, 250 f | 48/24 low · 76.5 s · 8.99 · 11.97 · 11.16 GB | 96.8 s · 5.60 · 8.85 · 6.79 GB | **51.8 / 51.7 s** · 16.6 · 7.92 · 8.46 GB |
| walking_sitting, 314 f | 48/24 low · 94.2 s · 9.11 · 11.97 · 11.95 GB | 116.2 s · 5.92 · 8.84 · 6.72 GB | **63.2 / 63.1 s** · 16.6 · 7.92 · 8.61 GB |
| with_motion_blur, 50 f | 80/40 low · 19.0 s · 9.82 · 12.03 · 8.74 GB | 22.7 s · 5.87 · 8.90 · 6.08 GB | **12.4 / 12.3 s** · 17.0 · 8.89 · 5.13 GB |

Both engines chose the same windows. The Rust engine now takes 0.51-0.68× PyTorch's time per job
(walking_sitting 4.98 frames/s over the whole job against 3.33), with 3.1-4.1 GB less peak VRAM on the
1280×1080 clips and less RAM on every clip. Against before, RAM grew by up to 1.9 GB (one stage-1 window
prepared ahead, the render queue; with_motion_blur 0.95 GB less), and godiva's VRAM from 5.92 to 8.88 GB
(the low-VRAM phases keep their arenas; still under the 12 GB budget).
"Before" is the previous run of the same tool on the onnx.1 set (2026-10-21,
`ck-bench/rust-prod`); a rerun of locked_backdrop before any change measured 37.4 s.

Matte agreement (`tools/matte_compare.py`, alpha and fg videos against PyTorch's from the run above):

| clip | alpha MAE vs PyTorch: before → now | alpha max: before → now | % > 1/255: before → now | fg PSNR all / subject: before → now | now vs before: alpha MAE, % > 1/255 |
|---|---|---|---|---|---|
| godiva_close | 1.57e-3 → 1.56e-3 | 0.111 → 0.115 | 14.86 → 14.79 | 45.6 / 44.2 → 45.6 / 44.2 dB | 9.61e-4, 7.40 |
| locked_backdrop | 6.12e-4 → 6.12e-4 | 0.068 → 0.064 | 3.93 → 3.93 | 49.0 / 47.5 → 49.0 / 47.5 dB | 3.99e-4, 3.49 |
| metal_glasses | 6.87e-4 → 6.86e-4 | 0.084 → 0.105 | 5.73 → 5.71 | 45.5 / 42.1 → 45.3 / 41.8 dB | 4.99e-4, 4.20 |
| smoke | 9.35e-4 → 9.36e-4 | 0.147 → 0.164 | 7.76 → 7.77 | 45.3 / 43.2 → 45.3 / 43.2 dB | 5.02e-4, 3.94 |
| walking_sitting | 2.70e-4 → 2.71e-4 | 0.333 → 0.341 | 1.80 → 1.80 | 52.0 / 43.1 → 52.0 / 43.1 dB | 1.81e-4, 1.46 |
| with_motion_blur | 2.97e-4 → 3.01e-4 | 0.081 → 0.082 | 2.13 → 2.18 | 50.5 / 44.8 → 50.9 / 45.2 dB | 2.22e-4, 1.77 |

Agreement with PyTorch is unchanged to the third digit. Now against before is the size of fp16 summation-order
changes (attention kernels, the rewritten convolutions) plus x264 at CRF 12 on both sides; the models' own
fp16 error against fp32 is unchanged (CorridorKey2.0 `docs/ONNX_EXPORT.md`, "Speed rewrites"). The CPU fp32
end-to-end check (`tools/e2e_cpu.sh`, onnx.2 set) passes: alpha MAE 2.48e-7 against PyTorch fp32, low-VRAM
identical to normal mode.

Install size (`du`): PyTorch venv 7.55 GB + weights/vfms 5.08 GB = 12.63 GB; Rust binary 2.9 MB +
ORT CUDA libraries 2.49 GB + fp16 opset-23 models 3.30 GB = 5.79 GB (TensorRT libraries +4.52 GB).

## Speed (2026-10-21): where the time went and what changed

**GPU time per network** (CUPTI kernel timeline around ORT CUDA runs, fp16, 1280×1152, steady runs, one
session per process; ORT's own per-node profile on CUDA times only kernel launches):

| network, one call | onnx.1 | onnx.2 | per output frame at window 48/24 |
|---|---|---|---|
| stage 2, B=1 | 73.5 ms | 53.4 ms | 53 ms |
| stage 1, T=24 | 1158 ms (48 ms per frame) | 915 ms (38 ms per frame; 907 ms with ORT's flash attention) | ~2 × 38-48 ms (each frame is in two windows; T=48 costs more per frame than T=24) |
| C-RADIO, N=4 | 17.0 ms | same | 4.3 ms |
| MoGe, N=4 | 4.2 ms | same | 1.1 ms |
| RVM, one step | 1.4 ms | same | 1.4 ms |

The onnx.1 stage-2 time went to ORT's generic N-d Pad kernel (15.2 ms, the Swin window pads), cuDNN's
grouped 7×7 conv (7.7 ms) and MatMul (20 ms, compute-bound); stage 1's the same way (Pad 181 ms, grouped convs
105 ms at T=24). The ConvTranspose itself was 1.2 ms. The onnx.2 rewrites are in
`docs/ONNX_EXPORT.md` ("Speed rewrites"). What is left in stage 1 at T=24: attention 213 ms, MatMul 153 ms,
convolutions 91 ms, and 1701 small element-wise / data-movement nodes 364 ms (none over 2 ms).

**In the engine** (locked_backdrop, 80 frames, 48/24 low-VRAM; the engine's `timing` log line):

| | before | now |
|---|---|---|
| stage 2 | 12.7 s run (159 ms per call: a shrunk arena allocated its buffers again every call) | 4.6 s (58 ms) |
| stage 1 | 9.1 s run (3 windows of 48) | 7.0 s |
| C-RADIO + MoGe + RVM | 1.3 s | 1.1 s |
| phases rvm / foundations / stage 1 / stage 2 | 1.1 / 2.1 / 13.5 / 15.4 s | 1.0 / 1.7 / 10.0 / 5.7 s |
| before the first phase | ~3 s (all five networks loaded, then unloaded for low-VRAM) | 0.1 s |
| total (bench) | 37.4 s | 20.6-21.9 s |

What changed in the engine, each measured on its own:
- **Arenas**: shrink only while stage 1 and stage 2 share the card (normal mode). In the low-VRAM phases a
  network keeps its arena. Together with the onnx.2 models: stage 2 159 → 64 ms per call (one run each;
  in Python a shrinking stage-2 session took 297-397 ms on some runs after a shrink, 74-76 ms otherwise).
- **Graph optimisation `ORT_ENABLE_ALL`** instead of the `ort` crate's `Level3` (= `ORT_ENABLE_LAYOUT`):
  locked_backdrop 29.6 → 27.8 s (one run each).
- **Attention on ORT's flash kernels** (`ORT_ENABLE_CUDNN_FLASH_ATTENTION=0`): with cuDNN's, every switch
  between two sessions cost 250-400 ms of host time on the next run (reproduced in Python with stage 1 and
  stage 2 sessions alternating: stage 2 54 → 257-381 ms on the first call after a stage-1 window; stage 1 at T=1
  ~420 ms). Normal mode switches every window: with_motion_blur at a manual 8/4 window 28.0 → 15.6 s (13.1 s
  with `CK_ENGINE_ARENA_SHRINK=0`, peak VRAM 5.13 → 6.88 GB). Low-VRAM: locked_backdrop 21.3-22.0 → 20.6-20.7 s.
- **cuDNN search heuristic**: same stage 1 / stage 2 run times as exhaustive, no first-call outliers: RVM's
  first call took 0.2-3.0 s over 7 exhaustive runs and 0.4 s in each of 3 heuristic runs (locked_backdrop
  21.8-22.1 s). In Python both modes gave ~0.30 s, so the outliers are not fully explained.
- **Host work off the card's path**: render and hand-off to the writers on a render thread (`outputs.rs`; the
  frame counts still come from the writers); RVM's small frames, the foundations' resized inputs, each stage-1
  window's frames / hint video / features (one window ahead) and the low-VRAM stage 2's inputs made on their
  own threads (`ahead.rs`); stage 1 loads while the first window is prepared; carry hints only for the frames
  the next window uses, in parallel; blend and state file in parallel. Per locked_backdrop job: stage-1 host
  time 2.3 → 0.8 s; the stage-2 phase beyond its `run` time 2.8 → 1.1 s.
- **No early load**: an automatic window no longer loads all five networks before the probe (setup 3.3 → 0.1 s).

Tried and not kept (measured): NHWC (`prefer_nhwc`) doubles stage 2 (147.8 ms); stage 2 batched B=2 / B=4
is slower per frame (59 / 66 ms); `cudnn_conv_use_max_workspace=0` and the search modes don't change kernel
time; capping rayon's threads doesn't change normal mode. Not done: IOBinding / pinned buffers. Stage 2's
inputs come from the host (decode, the blend on the CPU), so they cross PCIe once per call either way
(~15 MB in, ~12 MB out per frame in fp16); its copies take ~5.5 ms of CUDA API time per call (CUPTI), which
pinned buffers could shorten.

Where walking_sitting's 62.4 s go now (engine log): stage 1 29.5 s run, stage 2 17.6 s, C-RADIO / MoGe / RVM
2.8 s, session loads 3.4 s, stage-1 host inputs 3.3 s, float16 conversions 3.2 s; then the encoders finish
(0.5 s after the last frame).

## Portrait (2026-10-22)

Frames taller than wide failed in every C-RADIO export up to onnx.2: the export dropped the position grid's column
crop (a Python `if` at the landscape trace), so a portrait frame got rows × rows position tokens (400 against 240
patches at 1280×768 padded) and ONNX Runtime stopped with a broadcast error after the RVM pass. `2.0.0-onnx.3`
re-exports C-RADIO with both crops in the graph (exact; patched PyTorch = upstream PyTorch bit for bit); no padding
to square, C-RADIO sees what upstream shows it. `clip.rs` `model_shape_supported` now refuses portrait only for a
set whose `manifest.json` says onnx.1 / onnx.2 (`runtime.rs` `ModelSet::takes_portrait`; their message names
onnx.3). A side of 128 px or less is still refused: the ONNX stage 1 fails there with every set, onnx.3 included
(reflect pad on a 2-cell grid; upstream PyTorch switches to a replicate pad, a branch the export fixed).

Measured (engine built from `fix/portrait`, CUDA fp16, 12 GB budget, alpha+fg, auto window, `tools/engine_bench.mjs`;
portrait clips made from the test plates as ProRes 4444: locked_backdrop rotated 90° = 1080×1280, 80 f;
with_motion_blur cropped to 608×1080, 50 f):

| check | result |
|---|---|
| C-RADIO alone, CPU, vs upstream PyTorch fp32 (max / mean abs, features up to 26) | fp32 1.2e-5 to 3.3e-5 / 7e-7 to 1e-6 on six portrait shapes (384×256 to 1920×1152, 5:1); fp16 6.1e-3 to 7.1e-3 / 1.7e-4 to 2.0e-4; landscape the same size (fp32 ≤ 4.7e-5, fp16 ≤ 1.0e-2 / 1.8e-4) |
| landscape C-RADIO, onnx.3 vs onnx.2 (CPU, fp32 and fp16, four shapes) | bit-identical |
| six landscape clips, onnx.3 vs onnx.2 mattes (same engine binary) | alpha and fg identical on every clip (MAE 0, max 0) |
| CPU fp32 end to end (`tools/e2e_cpu.sh`), tiny clip transposed (200×320) vs PyTorch fp32 on it | alpha MAE 1.46e-7, max 3.4e-5, 0 % > 1/255, fg PSNR 103.0 / 96.1 dB; low-VRAM identical; all four jobs ran (landscape tiny with onnx.3: 2.11e-7, identical to onnx.2) |
| locked_backdrop_rot90 vs the PyTorch engine (bf16 autocast, what ships) | alpha MAE 6.86e-4, max 6.1e-2, 4.01 % > 1/255, fg PSNR 49.4 / 47.7 dB (landscape locked_backdrop: 6.12e-4, 6.4e-2, 3.93 %, 49.0 / 47.5 dB) |
| with_motion_blur_tall vs the PyTorch engine | alpha MAE 3.69e-4, max 6.5e-2, 2.86 % > 1/255, fg PSNR 52.6 / 47.2 dB (landscape with_motion_blur: 3.01e-4, 8.2e-2, 2.18 %, 50.9 / 45.2 dB) |
| onnx.2 on the two portrait clips | refused before any work: `input`, "Portrait clips … need the 2.0.0-onnx.3 models or newer" |

Portrait jobs: locked_backdrop_rot90 48/24 low, 18.3 s total, 8.33 GB VRAM, 5.36 GB RAM (PyTorch 43.6 s, 11.62 GB,
9.87 GB); with_motion_blur_tall 80/40, 9.3 s, 7.22 GB, 3.85 GB (PyTorch 13.1 s). Landscape speed, onnx.3 vs onnx.2,
one run each, same binary (total s): godiva_close 34.1 / 33.4, locked_backdrop 17.9 / 17.9, metal_glasses 25.5 /
25.6, smoke 44.3 / 44.6, walking_sitting 54.6 / 54.4, with_motion_blur 10.5 / 10.5; peak VRAM 8.07-9.44 GB both.

TensorRT: `models-trt-1`'s C-RADIO has the same fault. `models-trt-2` (scratch) is `models-trt-1` with C-RADIO
rebuilt from onnx.3's; on ONNX Runtime's CPU it takes portrait (mean 3.1e-4 to 3.4e-4 vs PyTorch, landscape 3.2e-4).
A TensorRT engine for a portrait range was not built or run on the card.

## TensorRT (opt-in, `tensorrt: true`)

OFF by default; CUDA fp16 stays the normal path. Measured 2026-10-21 (RTX 5080, driver 615, TensorRT 10.16,
ORT 1.31).

**How it runs.** The models folder carries a TensorRT-ready fp16 set next to the normal one (`models.json` keys
`tensorrt-fp16` and `tensorrt-fp16-ctx`; CorridorKey2.0 `engine-rs/export/build_trt_models.sh`, docs/ONNX_EXPORT.md
"TensorRT set"): plain attention instead of `com.microsoft::MultiHeadAttention` (no TensorRT plugin), MoGe's
antialiased resize as weight matrices, Swin regions in 7 dimensions (TensorRT allows 8), the `onnx.2` speed
rewrites, and FP32 islands for weight GEMMs and convolutions. For a clip's range, `trt_prepare` builds each
missing engine with `ck-trt-build` (`tools/trt-build/`, C++ on TensorRT's API, `build.sh` fetches the pinned
headers), one network at a time in a child process before any network is loaded, then ONNX Runtime runs the
engine through the EPContext stub copied next to it. Why not ORT's own TensorRT build: it makes weakly typed
networks, where TensorRT ignores the FP32 islands; its FP16 kernels measured 2-4× the CUDA fp16 error in every
network (stage 2 alpha MAE 1.24e-4 vs 1.58e-5). Strongly typed with the islands: 1.38e-5 (per-network table in
docs/ONNX_EXPORT.md).

**Ranges and windows (2026-10-24, step 2).** Padded H and W each fall in one of 128-512, 640-896, 1024-1280,
1408-1664, 1792-2176 (720p → h640-896 w1024-1280, 1080p → h1024-1280 w1792-2176, 1280×1080 → h1024-1280
w1024-1280), and since step 3 (2026-10-24) also 2304-2816, 2944-3456 and 3584-4096 for a side, as long as the
range's largest frame is at most 2176 × 4096 (`MAX_AREA`, the largest measured: DCI 4K and UHD → h1792-2176
w3584-4096; open gate 4096×3072 and anything over 4096 a side run on CUDA). At 4K on a 16 GB card the job's window
is 8/4 low-VRAM and all five networks build (stage 1 in 139 s with a 7.2 GiB workspace, peak 12.8 GiB on the card);
stage 1 for 16-frame windows at 4K finds no tactic within 8 GiB (it built with a 12000 MiB workspace, peak 12.7 GiB
on the card, not with 9400 MiB), so where a bigger card picks 16/8 at 4K, stage 1 runs on CUDA; on the 16 GB card
that 16/8 engine also ran out of graphics memory while keying (13.2 GiB peak), as CUDA does. At 8/4 the four Tears
of Steel 4K plates key in 111-113 s on TensorRT against 147-152 s on CUDA (steady 2.64-2.67 against 1.90-1.93 fps),
alpha MAE 3-4e-5 against CUDA (EXR, read as float). A TensorRT job takes **exactly the CUDA path's
window and low-VRAM staging** (`select_vram_profile`), so both give the same matte, and its engines are built
for that window: stage 1 for 1..window frames, the foundations for 1..4 frames in low-VRAM mode (their prepass
batch) or the whole window otherwise; the folder is `<range>_t1-<window>_f1-<batch>`. Why: at the old
memory-capped windows (12-24 frames, against CUDA's 48/80) the mattes differed from CUDA's by up to 27 % of pixels
> 1/255 (godiva_close); at CUDA's window they match within fp16 rounding (below). The builder's workspace is 60 %
of the job's budget (else of the card's free memory), at most 8 GiB: stage 1 for 48 frames at 1152×1280 needs a
6.1 GB tactic (a 4 GiB cap found none; 7 GiB built it in 138 s, peak 13.9 GB on the card, context 6.3 GiB), so it
builds on 16 GB cards; a network whose build finds no tactic runs on CUDA at the same window (`fallbacks`).
Only such deterministic failures (no tactic, a parse error, bad arguments) are remembered in `<piece>.failed`; a
timeout, a lack of memory or a busy card is tried again by the next job. One engine process builds a range at a
time (`build.lock` in the range folder; another engine waits, at most five build deadlines, and takes over a lock
not refreshed for a build deadline). ck-trt-build writes the engine and the timing cache through per-process
temporary files and replaces the old file on every system (MoveFileEx on Windows).
Before step 2: a range's longest window was the longest of 24/16/12/8/4 with window × largest frame ≤
24 × 1152 × 1280, all networks loaded together.

**One-time builds** (seconds, `build_s`; host peak of the whole bench process tree under memrun, builder
included; VRAM peak of the tree):

| range | C-RADIO | MoGe | RVM | stage 1 | stage 2 | total | host peak | VRAM peak |
|---|---|---|---|---|---|---|---|---|
| h1024-1280_w1024-1280_t1-16 | 27.2 | 22.7 | 25.0 | 88.0 | 41.3 | 204 s | 5.35 GB (both ranges, one run) | 7.53 GB |
| h640-896_w1024-1280_t1-24 | 36.1 | 23.1 | 25.6 | 93.4 | 44.0 | 222 s | | |

The earlier attempts' 9.6 GB host peak (ORT's TensorRT provider building C-RADIO in-process) is gone: the
builder is a child process, and ORT never holds the ONNX weights while it builds.

**Six clips** (`tools/engine_bench.mjs`, 12 GB budget, alpha+fg, auto window, no hint, engines already built;
`~/.cache/claude-scratch/ck-bench/rust-trt2`). CUDA fp16 = the same engine without TensorRT
(`ck-speed2/bench/final-fa2`), PyTorch = `ck-bench/pytorch12`. Totals are the fair comparison: "steady fps" counts
from the first stage-1 window, and the CUDA/PyTorch low-VRAM runs do their foundations before it.

| clip | TensorRT: window · total · VRAM · RAM | CUDA fp16: window · total · VRAM · RAM | PyTorch: window · total | TensorRT / CUDA, / PyTorch |
|---|---|---|---|---|
| godiva_close 960×720, 349 f | 24/12 · 28.8 s · 7.33 · 4.19 GB | 80/40 low · 42.7 s · 8.88 · 7.58 GB | 80/40 low · 68.4 s | 0.67, 0.42 |
| locked_backdrop 1280×1080, 80 f | 16/8 · 14.4 s · 7.36 · 5.25 GB | 48/24 low · 21.9 s · 7.92 · 7.67 GB | 48/24 low · 40.3 s | 0.66, 0.36 |
| metal_glasses, 139 f | 16/8 · 22.4 s · 7.36 · 5.67 GB | 48/24 low · 29.9 s · 7.93 · 7.95 GB | 48/24 low · 44.7 s | 0.75, 0.50 |
| smoke, 250 f | 16/8 · 37.0 s · 7.36 · 5.80 GB | 48/24 low · 51.7 s · 7.92 · 8.46 GB | 48/24 low · 76.5 s | 0.72, 0.48 |
| walking_sitting, 314 f | 16/8 · 44.6 s · 7.36 · 5.89 GB | 48/24 low · 63.1 s · 7.92 · 8.61 GB | 48/24 low · 94.2 s | 0.71, 0.47 |
| with_motion_blur, 50 f | 16/8 · 10.1 s · 7.36 · 4.43 GB | 80/40 low · 12.3 s · 8.89 · 5.06 GB | 80/40 low · 19.0 s | 0.82, 0.53 |

Load to first frame with built engines: 3.4-4.9 s (CUDA 8.2-43.6 s, which includes its low-VRAM foundations
pass). At the same window CUDA fp16 is slower still: locked_backdrop 16/8 low 23.4 s, metal_glasses 28.4 s,
godiva_close 24/12 low 34.3 s.

**Mattes** (`tools/matte_compare.py`, both x264 CRF 12). At the same window, TensorRT vs CUDA fp16:
locked_backdrop (16/8) alpha MAE 3.72e-4, max 6.6e-2, 3.32 % > 1/255; metal_glasses 5.55e-4, 9.7e-2, 4.61 %;
godiva_close (24/12) 9.82e-4, 1.1e-1, 7.92 %. For scale: CUDA fp16 vs PyTorch at their (same) auto windows
2.71e-4 to 1.56e-3 MAE (godiva 1.56e-3, 14.8 % > 1/255); Rust fp16 vs fp32 on locked_backdrop at 4/2 was 3.41e-4,
3.08 %. At the automatic windows the window dominates: TensorRT (16/8, 24/12) vs CUDA fp16 (48/24, 80/40) alpha
MAE 3.39e-4 (with_motion_blur) to 2.06e-2 (godiva_close), vs PyTorch 4.12e-4 to 2.10e-2 — the same size as
PyTorch against itself at 80/40 vs 20/10 (2.15e-2, above).

## Colour (OpenColorIO, 1.0)

Backlog row 29, phase 1 (the engine core; the study: docs/OCIO_STUDY_2026-10.md, Marcy's decisions in the row).

- **Library.** The real OpenColorIO C++ library, 2.5.2, built from source by CMake and linked in statically through
  `ocio-rs` 0.3.0 with `bundled` (feature `ocio`, on in every build the app ships). Its FFI crate `ocio-sys` is
  vendored with five MinGW cross-build fixes (`engine-rs/vendor/README.md`). Without `bundled`, `ocio-rs` is a stub
  that does no colour work: the engine refuses to start (`ocio::require_real_ocio`, and the unit test
  `ocio_is_the_real_library` fails on a stub). The pong says `"ocio": "2.5.2"`.
- **Configs.** The job's `color_config` (a path or an `ocio://` name), else `$OCIO`, else `ocio://studio-config-latest`
  resolved to its versioned name (`studio-config-v4.0.0_aces-v2.0_ocio-v2.5`). No config files ship.
- **Processors.** Input: the job's space → "Linear Rec.709 (sRGB)" of the built-in studio config, with
  `GetProcessorFromConfigs` (the two configs joined through `aces_interchange`, so a studio config needs no Rec.709
  space of its own); output: back the same way to the output space. OCIO's LOSSLESS optimisation (its default adds a
  15-bit fast pow/log), float32, on the CPU, rows in parallel (`ocio.rs`).
- **Where.** Decode → (colour-managed clips) finite → input processor → finite → the scene-linear path: the model view
  is bf16 of signed asinh, negatives kept (decision 3); the display view clips as before (`decode.rs`). After the
  networks: alpha as it is (data); the foreground decoded to linear Rec.709, despilled there (as trained), then the
  output processor; the EXR cutout premultiplied only in a linear output space (straight colour + alpha in a log or
  display one); the checker unchanged (`render.rs`). Video outputs stay display sRGB / Rec.709 (decision 2): the
  output space applies to EXR outputs; with video outputs a `log` line says so.
- **Today's behaviour kept.** No `input_colorspace` and no `output_colorspace`: no config is read and every output is
  byte-identical to the engine before (the CorridorKey 2.0 path keeps its own IEC sRGB; OCIO's sRGB curve differs in
  the toe by up to 2.5e-4, the study §2).
- **Phase 1 inputs.** EXR and 16/8-bit image sequences. A colour space on a video input is a `bad-request`: camera-log
  video must first be decoded with its tagged YCbCr matrix and range (phase 2; today's video decode copies OpenCV's
  BT.601).
- **Recorded.** `_settings.txt`: `OCIO`, `OCIO Config` (name and source), `OCIO Config Cache ID`, `Input Colorspace`,
  `Output Colorspace`, `OCIO Optimization: LOSSLESS`.

**Measured (2026-10-24).** Results in the README, Quality, "Colour management (OCIO)". How to repeat them:

```
cd engine-rs
cargo test -p ck-core --test ocio_roundtrip -- --nocapture       # test 1: every studio-config space, round trip
cargo test -p ck-core ocio render::tests                          # guard (10), output spaces never touch alpha (6)
cargo build --release -p ck-core --example ocio_apply             # the engine's processors on a float32 file
python3 -m venv V && V/bin/pip install opencolorio==2.5.2 numpy   # PyOpenColorIO at the same OCIO version
V/bin/python ../tools/ocio_compare.py --bin target/release/examples/ocio_apply --work /tmp/x --studio   # tests 2, 7
```

**Builds (2026-10-24).** Linux (`tools/build_engine.sh`, cargo-zigbuild, OCIO's CMake with Zig's C/C++): needs
GLIBC 2.28 at most, links only libc / libm / libpthread / libdl (Zig's libc++ is linked in) and exports no symbols
at all; 3.76 → 9.64 MB. Windows (`--windows`, MinGW, the vendored fixes): imports only Windows' own DLLs (kernel32,
ntdll, msvcrt, bcryptprimitives, an api-ms-win-core set, and now user32 / gdi32, used by OCIO's monitor-profile
code); 3.88 → 11.72 MB. The macOS build of OCIO is not verified (it is built only on a Mac); `npm run
check:targets` lints macOS with `ocio-rs`'s stub (the same Rust API; its C++ bridge compiled by Zig) and Windows
with the real library.

**Speed (2026-10-24, Ryzen 9 9950X3D, 32 threads; `ocio_apply` on 4096×2160 = 8.85 M pixels, the processor alone,
3 runs).** Input processor (the decoder's planar path, blocks of 16 384 pixels in parallel): ACEScg 10-11 ms, ARRI
LogC4 11 ms, S-Log3 S-Gamut3.Cine 11-12 ms; one thread 51 / 90 / 119 ms. Output processor (rows in parallel, as the
renderer): 3-4 / 6 / 6 ms; one thread 18 / 69 / 70 ms; it runs once per colour output (fg, cutout). A CPU job
(8 frames, 1024×540): 20.6 and 21.6 s with ACEScg in, 21.5 s without; decode + prep 0.1 s either way. A studio
colour space that inverts a 3D LUT is far slower: the E4 config's "Show Plate (graded LogC4)" took 1.8 s per
1.8 M pixels on the way in (LOSSLESS leaves out OCIO's fast approximate LUT inverse, LUT_INV_FAST, and evaluates the
exact inverse).

**Windows against Linux (Wine, test 8).** The Windows build's processors, on the test-2 inputs, both directions:
byte-identical for 25 spaces (all 18 scene-linear ones, Raw, and ACEScc, Apple Log, Canon Log 2 / 3 and the two PQ
spaces), and within 7.5e-7 of the pixel's largest channel for the other 30, all with a log or power curve (99.5-99.99 %
of their values identical). The differences sit in those curves, which with LOSSLESS call the platform's C library's
log / pow / exp (msvcrt against glibc); the study's harness used OCIO's default optimisation, whose
fast pow is OCIO's own code, and was byte-identical (this is the likely cause, not separately measured). For scale,
one bfloat16 step at the model's input is 3.9e-3. Real Windows (not Wine) is unmeasured.

The keying checks (tests 3, 4, 6) ran the engine on the CPU (`--device cpu`, fp16 models) on 8 frames of 04_5d
box-downscaled to 1024×540 in float32, converted to ACEScg and ACES2065-1 with PyOpenColorIO (as `ocioconvert`
does), EXR float outputs, compared with `tools/matte_compare.py` and bit for bit.

## What's left

1. **More speed**: stage 1 is now half of a job's time (walking_sitting 28.8 of 54.4 s); its remaining GPU time is
   attention, MatMul and ~1700 small element-wise nodes (fusing those needs TensorRT or custom fused ops). The
   efficiency pass (docs/EFFICIENCY_PASS_2026-10.md) removed the host-side copies and conversions around the
   networks and loads each low-VRAM phase's networks ahead; stage 2's host↔device copies measured at most
   1.1 ms of wall time per call (run 54.5 ms vs 53.4 ms of kernels), so pinned buffers / IOBinding are not worth it.
2. **An ONNX Runtime VRAM table** for the automatic window: DONE 2026-10-24 (BACKLOG row 41: 96 measured points,
   six sizes, an upper bound at each). Left: peaks read inside the engine rather than sampled, TensorRT's own peaks,
   other cards; halve-on-oom stays as the safety net.
3. **TensorRT**: (a) DONE 2026-10-24 (step 2): TensorRT takes CUDA's window. Before: the measured memory cap gave TensorRT 12-24-frame windows where CUDA's
   automatic window is 48 or 80, which changes the matte more than precision does; a low-VRAM-style staging for
   TensorRT, or stage 1 split per window half, would allow longer ones. (b) UHD (outside every range today).
   (c) Settings toggle and its explanation in the app; packaging ck-trt-build (needs the TensorRT libraries, +4.5 GB).
   (d) Ranges other than the two measured (720p/1080p-wide/portrait) are built on the same cap but not measured.
   (e) FP8 / BF16 only if they pass the matte test (weakly typed BF16 didn't build stage 1).
4. **Packaging**: the GPU build plus ORT's CUDA libraries and the models in the AppImage, the driver check.
5. A TensorRT job whose window is halved keeps its original range.
6. EXIF orientation of JPEG frames (cv2 applies it, this engine doesn't); grayscale EXR frames.
7. Portrait clips run with `2.0.0-onnx.3` ("Portrait"); the TensorRT path for portrait (`models-trt-2`) is
   unmeasured on the card. Frames with a side of 128 px or less are still refused (stage 1's reflect pad,
   docs/BUG_HUNT_2026-10.md I4): a stage-1 re-export with the replicate branch would lift it.
