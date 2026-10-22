# Efficiency pass: the engine's hot paths and the app, measured

_2026-10-21, branch `audit/efficiency-loops` (off `feat/rust-engine` 47943b6). Every number below comes from a
run named here; "not measured" says why. The loop-by-loop side is [LOOP_PASS_2026-10.md](LOOP_PASS_2026-10.md)._

## How it was measured

- **Bench**: `tools/engine_bench.mjs rust`, the six clips in `~/Videos/corridorkey-tests`, CUDA fp16, the
  `2.0.0-onnx.2` models, 12 GB budget, alpha+fg, automatic window, no hint; one engine process per clip; RTX 5080,
  ORT 1.31. Guarded (GPU lock, Sonata / other-GPU check, memrun 16 GB, timeout). Totals = spawn to exit; VRAM /
  RSS = peak of the process tree sampled every 250 ms. Out folders: `~/.cache/claude-scratch/ck-audit/bench/`.
- **Before** = the branch point (47943b6) built the same way, two runs (`base1`, `base2`). **After** = the final
  branch code, two runs (`final1`, `final2`). `new1` = after the copy/conversion fixes only (before the preloads).
- **Engine's own timing line** (each job's `timing` log) splits the time per network, conversion, phase and thread.
- **Mattes**: `tools/matte_compare.py --roots` after vs before, and after vs the reference run
  `ck-speed2/bench/final-fa2`: **alpha and fg identical on all six clips (MAE 0, max 0, PSNR inf)**. Normal mode
  (manual 8/4, two clips) identical too. CPU fp32 end-to-end (`engine-rs/tools/e2e_cpu.sh`, four jobs: frame folder,
  low-VRAM, H.264 with all four outputs + first-frame hint, hint video + EXR + linear cutout): every output file
  byte-identical to before; parity with PyTorch fp32 unchanged (alpha MAE 2.48e-7).
- **Multi-job memory**: `ck-audit/scripts/multijob.mjs`, one engine process, four jobs in a row (locked_backdrop,
  with_motion_blur, locked_backdrop, metal_glasses), as the app runs a queue; RSS after each job and its peak.

## Result: the six clips

| clip | before: total (two runs) | after: total (two runs) | after / before | steady fps before → after | peak VRAM before → after | peak RSS before → after |
|---|---|---|---|---|---|---|
| godiva_close 960×720, 349 f, 80/40 low | 38.3 / 38.1 s | 33.6 / 33.6 s | 0.88 | 34.5 → 37.5 | 8.88 → 9.40 GB | 7.27 / 7.01 → 5.34 GB |
| locked_backdrop 1280×1080, 80 f, 48/24 low | 20.0 / 20.1 s | 18.0 / 18.0 s | 0.90 | 17.4 → 18.6 | 7.92 → 8.47 GB | 7.54 / 7.52 → 5.00 GB |
| metal_glasses, 139 f, 48/24 low | 29.0 / 29.2 s | 25.7 / 25.7 s | 0.88 | 17.3 → 18.6 | 7.93 → 8.47 GB | 7.88 / 8.21 → 5.50 GB |
| smoke, 250 f, 48/24 low | 50.2 / 50.3 s | 44.4 / 44.4 s | 0.88 | 17.3 → 18.4 | 7.92 → 8.47 GB | 8.34 / 8.47 → 5.84 GB |
| walking_sitting, 314 f, 48/24 low | 61.2 / 61.3 s | 54.4 / 54.4 s | 0.89 | 17.3 → 18.4 | 7.92 → 8.31 / 8.47 GB | 8.29 / 8.52 → 5.82 / 5.89 GB |
| with_motion_blur, 50 f, 80/40 low | 12.0 / 12.1 s | 10.7 / 10.7 s | 0.89 | 17.7 → 18.8 | 8.89 → 9.44 GB | 4.98 / 5.05 → 3.74 GB |

Run-to-run spread is ≤ 0.2 s before and 0.0 s after, so the 10-12 % is well outside noise. Against the PyTorch
engine (`ck-bench/pytorch12`, same options) the Rust engine now takes 0.45-0.58× its time (walking_sitting 54.4 vs
94.2 s). Peak RAM fell 1.2-2.7 GB per clip; peak VRAM rose 0.52-0.55 GB (the next phase's network loading while the
current one runs, below), still 2.6 GB under the 12 GB budget.

Normal mode (manual 8/4, not low-VRAM; `normal-base` vs `normal-default`): with_motion_blur 13.0 → 12.4 s,
locked_backdrop 18.2 → 17.1 s, peak VRAM 5.13 GB both, mattes identical.

Queue memory (multijob, four jobs in one engine process): before, resident memory after each job 4.21 → 4.64 →
4.78 → 4.94 GB, peak 9.72 GB; after, 2.00 → 2.07 → 2.16 → 2.28 GB, peak 5.64 GB. Job times 20.2 / 11.0 / 19.1 / 28.2 s
→ 18.2 / 10.1 / 17.3 / 25.2 s.

Where walking_sitting's time goes now (engine timing line, `final1`): stage 1 28.8 s run, stage 2 17.1 s, C-RADIO /
MoGe / RVM 3.1 s, conversions 1.5 s (was 3.2 s), stage-1 host inputs 0.8 s (was 3.3 s), session loads on the main
thread 0.3 s (was 3.4 s; 6.3 s now runs ahead on its own thread), render thread 1.6 s (was 4.2 s, off the card's
path either way). The card's own work (stage 1 + stage 2 + foundations + RVM ≈ 49 s) is 90 % of the 54.4 s.

## Candidates, one row each

Locations are as of the branch's commits. "Before → after" figures are walking_sitting from the engine's timing
line (`base2` → `final1`) unless the row says otherwise.

### Engine, per frame / per window

| # | Candidate | Location | Cost measured (before) | Verdict / fix | After |
|---|---|---|---|---|---|
| 1 | Stage 1's rgb converted twice (bf16 → f32 → f16) with an f32 copy of the window (48 × 3 × 1152 × 1280 × 4 B = 850 MB) | `pipeline.rs` keying, `runtime.rs` Net::run | stage-1 host inputs 3.3 s + stage-1 convert 1.4 s | FIXED: inputs keep their type (`Data`), bf16 frames → f16 in one parallel pass straight into the tensor | inputs 0.8 s, convert 1.2 s |
| 2 | Window frames deep-copied out of the reader's cache (each frame sits in two overlapping windows) | `pipeline.rs` WindowReader / HintWindows | not timed alone (on the window thread); 850 MB of copies per 48-frame window; part of RSS | FIXED: frames are `Arc`-shared (`decode.rs` Prepped) | peak RSS −1.1 to −2.1 GB on the 1280×1080 clips (`new1` vs `base1`, with #3, #4, #7) |
| 3 | Stage 1's float16 baton converted to an f32 copy of the whole window (48 × 2.95 M × 4 B = 566 MB) before the blend | `pipeline.rs`, `hann.rs` BatonBlend::add | inside stage-1 convert / after (0.9 s) | FIXED: the blend reads f16 values directly; finished frames come out as f16 (the memmap type) | after 0.7 s |
| 4 | Stage 2's f16 logits converted to f32 on the thread that feeds the card | `runtime.rs` | stage-2 convert 1.4 s (314 calls, 4.5 ms each) | FIXED: logits go to the render thread as f16; render reads them as they are (generic over the type) | stage-2 convert 0.2 s |
| 5 | Stage 2's inputs: bf16 → f32 → f16 rgb, baton rounded to f16 then converted again | `pipeline.rs` stage2_inputs | in #4's 1.4 s | FIXED: one pass (normal mode, inside the run), or on the producer thread in the type the graph takes (low-VRAM) | in #4 |
| 6 | RVM features / recurrent state: f16 → f32 → f16 per step; temp file written through a byte buffer | `pipeline.rs` RVM pass, F16File | rvm convert 0.2 s | FIXED: kept f16; file I/O straight from / into f16 buffers (bytemuck) | rvm convert 0.1 s |
| 7 | Low-VRAM foundation features stored as float32 (1.66 + 1.11 MB per frame) | `pipeline.rs` FeatFile | 870 MB written + read per walking_sitting | FIXED: stored in the network's own type (f16 for the fp16 models, exact) | half the bytes; foundations phase 3.2 → 2.3 s (with #10, #12) |
| 8 | Render: every output row in its own growing Vec, then a join copy of the frame | `render.rs` | render thread 4.2 s | FIXED: rows render in parallel straight into the outputs | render thread 1.6 s (with #9, #4) |
| 9 | Video writer: `flat_map(to_le_bytes).collect()` copy of each frame (4.1 M samples per output) | `writers.rs` write_many | in #8's render-thread time | FIXED: the u16 buffer goes to ffmpeg as its own bytes (little-endian host, enforced at compile time) | in #8 |
| 10 | Per-frame image passes on one thread: rgb8 → planar, reflect pad, area resize (C-RADIO / MoGe inputs), bilinear (RVM) | `decode.rs`, `image.rs` | RVM inputs 1.7 s, foundation inputs 2.2 s (`base1`, own threads; RVM phase is input-bound: 2.2 s phase vs 0.9 s run) | FIXED: rows in parallel (rayon, ≥ 8 rows per task) | RVM inputs 1.4 s, foundation inputs 1.2 s, decode+prep 11.1 → 9.9 s |
| 11 | `pad_reflect101` cloned the frame when no padding was needed | `decode.rs` | not measured (none of the six clips is unpadded) | FIXED: the frame is moved | — |
| 12 | Session loads in low-VRAM mode: five loads on the main thread between phases | `pipeline.rs` ensure / preload | 3.4 s per job (C-RADIO 0.75, MoGe 0.11, RVM 0.21-0.24, stage 1 1.70-1.73, stage 2 0.55-0.56 s; `loads` run) | FIXED: the next phase's networks load on their own thread while the current phase runs (CUDA only); memory: every arena limit already leaves room for all weights | main-thread loads 0.3 s on walking_sitting (stage 1's load is longer than the short foundations phase on small clips: with_motion_blur 1.9 s); peak VRAM +0.55 GB |
| 13 | Host memory left in per-thread malloc arenas after sessions are dropped | `pipeline.rs` unload → `trim_host_memory` | multijob with #12 alone: RSS after each job 3.84 → 5.59 → 7.47 → 9.09 GB, peak 12.28 GB (and the CPU end-to-end run hit its 8 GB memrun cap, a recorded stop) | FIXED: `malloc_trim(0)` after each unload; preload CUDA-only | multijob 2.00 → 2.28 GB, peak 5.64 GB |
| 14 | Stage 2's host↔device copies (CUPTI: ~5.5 ms of CUDA API time per call); pinned buffers / IOBinding | `runtime.rs` Net::run | wall per call 54.5 ms (17.1 s / 314) vs 53.4 ms of kernels (ENGINE_RUST.md, CUPTI): ≤ 1.1 ms per call is not overlapped | NOT-WORTH: ≤ 0.35 s per walking_sitting at best; the copies overlap the kernels | — |
| 15 | Arena shrinkage in normal mode (stage 1 + stage 2 loaded together) | `runtime.rs` shrinks | manual 8/4: default (both shrink) 12.4 / 17.1 s, 5.13 GB; stage 1 only 12.3 / 17.1 s, 6.13 GB; none 12.3 / 16.9 s, 6.88-7.02 GB | KEEP the default: ≤ 0.2 s for 1.75-1.9 GB of VRAM (onnx.2 models + ORT flash attention removed the old 159 ms re-allocation) | — |
| 16 | Decode/encode overlap and thread hand-offs (prefetch 8 frames, window thread 1 ahead, render queue 2, writer queue 2) | `decode.rs`, `ahead.rs`, `outputs.rs`, `writers.rs` | stage-2 main thread waiting for inputs 0.1 s, for the render thread 0.0 s; writers finish 0.5 s after the last frame | HOT-PATH-OK: the card never waits on decode, render or encode in stage 2 | same |
| 17 | ffmpeg pipe sizes (decoder: 1 MiB BufReader; writers: the default 64 KiB pipe, one 8 MB frame per write_all) | `decode.rs`, `writers.rs` | no wait observed (#16) | NOT-WORTH: the writer threads keep up with no backpressure on the render thread | — |
| 18 | Each low-VRAM phase decodes the clip again (RVM, foundations, windows, stage 2: four ffmpeg decodes) | `pipeline.rs` | decode+prep 9.9 s summed over the four passes, all on their own threads; only the RVM phase is input-bound (2.2 s phase, 1.2 s run) | NOT-WORTH now: merging the RVM and foundation passes (one decode) would save ≤ ~1 s per job and changes the staging; a backlog candidate, not built | — |
| 19 | One copy out of ORT's output buffer per call (`to_vec`) | `runtime.rs` | part of convert (0.2 s for stage 2 now) | HOT-PATH-OK: the session's outputs are freed right after; avoiding it needs IOBinding (#14) | — |
| 20 | Colour conversions per frame (sRGB → linear → asinh, display clip) | `decode.rs` prep_frame_views | inside decode+prep, own thread | HOT-PATH-OK: each done once per frame per pass, parallel | — |

### Waits (from the loop pass)

| # | Candidate | Location | Before | Fix |
|---|---|---|---|---|
| 21 | ffprobe `.output()` with no deadline | `clip.rs` | a stalled mount would hold the job | 120 s (`proc.rs` output_timeout: pipes drained on threads, kill at the deadline) |
| 22 | `ck-trt-build` `.output()` with no deadline (the GPU is held while it builds) | `tensorrt.rs` | a hung build would hold the job and the card | `CK_ENGINE_TRT_BUILD_TIMEOUT_S`, default 1800 s (measured builds 23-93 s); the network then runs on CUDA and says why |
| 23 | A writer's release: thread join + `child.wait()` on ffmpeg with no deadline | `writers.rs` | a stuck encoder would hold the job | 300 s, then ffmpeg is killed and the job fails saying so (measured finish: 0.5 s) |
| 24 | `ffmpeg -version` check | `pipeline.rs` | no deadline | 30 s |
| 25 | engine_bench: no limit on a silent engine (a profiling run hung 13 minutes holding the GPU lock) | `tools/engine_bench.mjs` | — | `--stall-s` (600 s): the engine is killed and the clip recorded as stalled; its nvidia-smi sampler has a 5 s timeout |
| 26 | `tools/drive.mjs` DevTools fetch | tools | no timeout | 2 s per ask |

### The app

| # | Candidate | Location | Cost measured | Verdict / fix |
|---|---|---|---|---|
| 27 | State pushes | `electron/main/index.ts` scheduleSend | coalesced to ≤ 10/s; replies per job 37-114 (the six bench clips' reply logs), ≤ ~2/s during a job, + GPU readout every 2 s | HOT-PATH-OK |
| 28 | State pushes while the window is hidden (the page re-rendered for nothing) | same | every push went out whatever the window's state | FIXED: held while hidden, one push when it shows |
| 29 | IPC payload size | `state()` | v8 serialize of the state (`ck-audit/app/ipc_size.mjs`, real Rust engine log): 1 / 10 / 50 jobs = 2.8 / 26.7 / 134 KiB, 0.005 / 0.031 / 0.15 ms; worst case with the PyTorch engine's 300-line logs: 35.8 KiB / 357 KiB / 1.8 MB, 0.6 ms at 50 jobs | NOT-WORTH: ≤ 2 pushes/s × 134 KiB for a 50-clip Rust queue; trimming logs out of the push would only matter for the PyTorch engine, which is being retired |
| 30 | Renders | `src/ui` | one render per push (≤ 2/s during a job, measured via #27); render cost not measured (needs the isolated app with CDP tracing) | NOT-WORTH at that rate unless a render took > 50 ms; rows are plain lists |
| 31 | GPU readout: nvidia-smi with no timeout; a slow read could overlap the next | `electron/main/gpu.ts`, `index.ts` | 2 calls every 2 s while a job runs and the window is shown | FIXED: 5 s timeout, one read at a time |
| 32 | Clip probe / thumbnails / result stills: ffprobe / ffmpeg with no timeout (a stalled one blocks every clip dropped after it) | `electron/main/media.ts` | one ffprobe + one ffmpeg per clip; four stills per finished job, cached by path + mtime | FIXED: 120 s / 60 s timeouts |
| 33 | Blocking fs calls on the main process (47 rows) | `electron/main/*` | all once per start / drop / save / update step / finished job; none per frame or per push except one `/proc/<pid>/cmdline` read per compute process every 2 s | NOT-WORTH (each row's verdict in the loop pass) |

## Not done, and why

- **IOBinding / pinned buffers** (#14): measured ≤ 1.1 ms per stage-2 call not overlapped; not worth the code.
- **One decode for the RVM and foundation passes** (#18): ≤ ~1 s per job; changes the low-VRAM staging. Backlog
  candidate for Marcy, not built.
- **Trimming logs out of state pushes** (#29): only the PyTorch engine's long logs make pushes large.
- **TensorRT**: no fix touched the TensorRT-specific code paths (ranges, builds, EPContext); the shared paths
  (Net::run, render, writers) changed and are covered by the CUDA runs above. The build deadline (#22) was tested by
  the unit test of `proc.rs` (a deadline kills a sleeping child), not with a real hung build.
