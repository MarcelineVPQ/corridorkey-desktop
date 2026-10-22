# The Rust engine (ONNX Runtime)

`engine-rs/` is CorridorKey's engine in Rust on ONNX Runtime (Marcy 2026-10-21: Rust + ORT is the
house engine stack). It speaks [ENGINE_PROTOCOL.md](ENGINE_PROTOCOL.md) exactly like the PyTorch engine
(`engine/ck_engine.py`), which keeps working until Marcy retires it. Measured on 2026-10-21; every
number below comes from a run whose command is given or from the tests.

## Architecture

```
engine-rs/
  crates/ck-core/      the pipeline (library)
    clip.rs            probe: ffprobe read like cv2.VideoCapture, frame folders, 128 px padding
    decode.rs          ffmpeg decode with cv2's colour conversion, PNG/JPEG/EXR stills, hints, prefetch thread
    color.rs           sRGB <-> linear, signed asinh, despill, bf16/f16 rounding (color_utils.py)
    image.rs           reflect-101 pad/crop, area / bilinear (torch) and Lanczos-4 (cv2) resamplers
    hann.rs            window_starts, taper_weights, the baton blend
    vram.rs            select_vram_profile / estimate_peak_vram_gb (same table and margins)
    runtime.rs         ORT environment, CUDA / TensorRT / CPU providers, model files, sessions
    tensorrt.rs        TensorRT shape ranges, profiles, cache folders
    pipeline.rs        run_inference + hann_stage1_stream (normal and staged low-VRAM paths)
    render.rs          alpha / fg / checker / cutout, video (uint16) and EXR (float) paths
    writers.rs         ffmpeg writers (x264 yuv444p10le CRF 12; ProRes 4444 cutout) and EXR sequences
    job.rs, settings.rs  run options (ck_engine.py's defaults), <clip>_settings.txt
  crates/ck-engine/    the corridorkey-engine binary: the protocol loop (lib.rs) and main.rs
  tools/gen_fixtures.py   parity fixtures from the upstream Python functions
  tools/e2e_cpu.sh        CPU end-to-end parity check
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
`rvm`, `stage1`, `stage2` (the ONNX spike's exports, `scripts/onnx_spike` on the CorridorKey2.0 clone's
`spike/onnx` branch). Precision: fp16 on the GPU, fp32 on the CPU; `CK_ENGINE_PRECISION` overrides.

## Build and run

```
cd engine-rs
CARGO_TARGET_DIR=~/.cache/claude-scratch/corridorkey-rust/target cargo test          # CPU, static ORT
cargo build --release -p ck-engine --no-default-features --features ort-dynamic,tensorrt  # GPU build
corridorkey-engine --models DIR [--ort libonnxruntime.so] [--device auto|cuda|cpu]
```

- Default features: pyke's static CPU ONNX Runtime (downloaded at build time), for tests.
- GPU build: ONNX Runtime loaded at run time (`--ort`, `CK_ENGINE_ORT`, `ORT_DYLIB_PATH`), measured with the
  `onnxruntime-gpu` 1.31 wheel's library (CUDA 13, needs NVIDIA driver ≥ 580). The CUDA, cuDNN and TensorRT
  libraries must be on `LD_LIBRARY_PATH`; the app adds the wheel layout's `nvidia/*/lib` and
  `tensorrt_libs` next to the ORT library it is given (`electron/main/engine.ts`, `rustEngineEnv`).
- `--device cpu` runs ONNX Runtime's CPU provider (tests). Without a usable GPU, jobs fail with `no-gpu`,
  as with the PyTorch engine.
- Knobs: `CK_ENGINE_VRAM_BUDGET_GB` (default `vram_budget_gb`), `CK_ENGINE_ARENA_SHRINK`,
  `CK_ENGINE_CUDNN_SEARCH`, `CK_ENGINE_CUDNN_MAX_WORKSPACE`, `CK_ENGINE_PROFILE=<dir>` (ORT per-node
  profile), `CK_ENGINE_THREADS`; TensorRT: `CK_ENGINE_TRT_CACHE`, `CK_ENGINE_TRT_PRECISION` (fp16 | bf16),
  `CK_ENGINE_TRT_EXCLUDE`.

## The app

The queue runs the Rust engine when its program and models folder are set up (Engine page, or
`CK_ENGINE_BIN` / `CK_ENGINE_MODELS` / `CK_ENGINE_ORT`), else the PyTorch engine from the CorridorKey
checkout (`electron/main/settings.ts` `chooseEngine`). The Engine page says which engine is in use.

## Graphics memory

`vram_budget_gb` (run option) caps the job: the automatic window's budget is min(free + own, budget), and
each CUDA session's arena limit is the budget minus the CUDA context (measured after the first session),
the other networks' weights (size on disk) and a 0.5 GiB reserve (measured: without it the process peaked
0.17-0.22 GiB over a 12 GiB budget). Arenas give their working memory back after every run (without that,
stage 2's arena can't fit its buffers next to the others: measured `oom`).

The automatic window still comes from the upstream PyTorch table, as ported. ONNX Runtime needs more:
on CUDA fp16 at 1280×1152 a 16-frame window doesn't fit 12 GB, where the table picks 48/24 low-VRAM. So an
automatic window that runs out of memory before any frame reached the writers is halved and the job
restarted; a second `memory` reply says so (`retry_after_oom`). Measured peaks (nvidia-smi every 250 ms, the
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
| taper weights / window starts / VRAM table (360 cases) | 3.0e-8 / identical / identical |
| render: video uint16 alpha, fg, checker, cutout, cutout linear | 0 |
| render: EXR float (relative) | ≤ 7.5e-9 |
| stills: 8- and 16-bit PNG, JPEG (libjpeg-turbo), 16-bit hint | 0 |
| video decode vs cv2 4.11 (ProRes 4444 plate, BT.709-tagged and untagged H.264, 10-bit 4:4:4) | 0 |

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

## Against the PyTorch engine (`tools/engine_bench.mjs`, 12 GB budget, alpha+fg, auto, no hint)

| clip | PyTorch: window · steady fps · total · VRAM · RAM | Rust CUDA fp16: window · steady fps · total · VRAM · RAM |
|---|---|---|
| godiva_close 960×720, 349 f | 80/40 low · 20.04 · 68.4 s · 9.37 · 9.93 GB | 20/10 low · 12.33 · 93.0 s · 8.44 · 4.62 GB |
| locked_backdrop 1280×1080, 80 f | 48/24 low · 8.30 · 40.3 s · 11.97 · 9.40 GB | 12/6 low · 4.94 · 58.1 s · 8.92 · 5.92 GB |
| metal_glasses, 139 f | 48/24 low · 9.27 · 44.7 s · 11.97 · 10.12 GB | 12/6 low · 4.20 · 79.5 s · 8.86 · 5.94 GB |
| smoke, 250 f | 48/24 low · 8.99 · 76.5 s · 11.97 · 11.16 GB | 12/6 low · 5.13 · 120.8 s · 8.86 · 5.85 GB |
| walking_sitting, 314 f | 48/24 low · 9.11 · 94.2 s · 11.97 · 11.95 GB | 12/6 low · 5.32 · 129.0 s · 8.86 · 5.84 GB |
| with_motion_blur, 50 f | 80/40 low · 9.82 · 19.0 s · 12.03 · 8.74 GB | 10/5 low · 5.39 · 30.7 s · 9.42 · 5.16 GB |

The Rust totals include the halving retries (80 → 40 → 20 → 12/10). The mattes differ mostly because of
the window: PyTorch against itself at 80/40 vs 20/10 (godiva) gives alpha MAE 2.15e-2, the same size as
Rust vs PyTorch at their auto windows (2.21e-2). At the same window (PyTorch run at the Rust windows):
godiva_close alpha MAE 2.03e-3 (16.8 % > 1/255, 2.5 % > 4/255), locked_backdrop 5.40e-4. At the same
window the speed is about half: locked_backdrop 12/6 low 4.94 vs 9.40 fps, 4/2 low 5.35 vs 9.90 fps.

Install size (`du`): PyTorch venv 7.55 GB + weights/vfms 5.08 GB = 12.63 GB; Rust binary 2.9 MB +
ORT CUDA libraries 2.49 GB + fp16 opset-23 models 3.30 GB = 5.79 GB (TensorRT libraries +4.52 GB).

## Where the time goes (ORT profile, 1280×1152, window 8/4)

Per frame: stage 2 186 ms (kernels 61 ms; one ConvTranspose `node_convolution` 40 ms and a 5.77 GB working
buffer that the shrinking arena allocates again every run, ~145 ms), stage 1 ~51 ms (Conv + ConvTranspose
83 % of its kernel time). Host work (decode, prep, render, conversions) is under 10 % after the prefetch
thread and parallel prep/render. cuDNN search and workspace settings made no measurable difference.

## TensorRT (opt-in, `tensorrt: true`)

Built and unit-tested: shape ranges per axis (padded H and W in 128..640, 768..1152, 1280..2176,
2304..4096; windows 1-8, 9-24, 25-48, 49-80), one cached engine set per range under
`~/.cache/corridorkey-desktop/tensorrt/<card>__drv<driver>__trt<version>__ort<version>__<precision>/`;
stale folders (driver / TensorRT / ORT changed) are removed and the `provider` reply says so; a
clip outside every range runs on CUDA; a network TensorRT can't build runs on CUDA (`fallbacks`).
Measured on the GPU (tiny clip): C-RADIO builds (31 s, 834 MB cache, 9.6 GB host peak); MoGe doesn't
(TensorRT can't parse its antialiased bilinear `Resize`); the opset-23 `Attention` op needs a strongly
typed network, which ORT's TensorRT provider doesn't make. TensorRT builds need lots of host memory: two
attempts at an 8 GB cap were killed. Stopped there.

## What's left

1. **Stage 2 speed and memory** (model side): the ConvTranspose `node_convolution` and its 5.77 GB buffer
   at 1280×1152; profile it in the export, then remeasure (`CK_ENGINE_PROFILE`).
2. **An ONNX Runtime VRAM table** for the automatic window (the measured points above, more sizes, peaks
   read inside the engine rather than sampled), replacing halve-on-oom as the normal path.
3. **TensorRT**: exports TensorRT can parse (opset-18 attention or strongly typed, MoGe's antialiased resize),
   then builds under a host-memory guard; FP8 only if it passes the matte test.
4. **Packaging**: the GPU build plus ORT's CUDA libraries and the models in the AppImage, the driver check.
5. Low-VRAM mode reloads sessions per phase (seconds per job); a TensorRT job whose window is halved keeps
   its original range.
6. EXIF orientation of JPEG frames (cv2 applies it, this engine doesn't); grayscale EXR frames.
