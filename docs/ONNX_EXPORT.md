# CorridorKey v2 on ONNX Runtime: model set and contract

Scripts: `engine-rs/export/` (they load the model code and weights from the CorridorKey2.0 clone, `CK2_REPO`, default `~/projects/CorridorKey2.0`). Scratch (ONNX files, clips, results):
`CK_ONNX_SCRATCH`, default `~/.cache/claude-scratch/corridorkey-onnx/`. The scripts' other paths are variables too:
`CK_ONNX_VENV` (the Python environment `run.sh` activates, default `<scratch>/venv`), `CK_MEMRUN` (the memory-capped
runner, default `~/.cache/claude-scratch/tools/memrun.sh`), `CK_HEAVY_LOCK` (`coreml/build_coreml_models.sh`'s
one-heavy-job lock, default `~/.cache/claude-scratch/heavy.lock`) and `PY` (its Python). The engine is decided: **Rust + ONNX Runtime**
(the Electron app's `engine-rs`). This document is the single source of truth for the model files
the engine loads: names, opsets, precisions, inputs/outputs, and the host-side steps around them.

## Production model set (`2.0.0-onnx.4`, built 2026-10-25)

**`2.0.0-onnx.4`** (release `models-2.0.0-onnx.4`; local copy `~/.cache/claude-scratch/models/2.0.0-onnx.4/`) is
`2.0.0-onnx.3` with the fp16 files of MoGe, RVM, stage 1 and stage 2 exported under CorridorKey 2.0's own precision
policy, the `torch.autocast` it runs under: `export.py --amp` traces under fp16 autocast with CUDA autocast's fp32
list registered for the CPU trace (`autocast_policy.py`: norms, softmax, exp/pow, sums and upsampling in fp32;
convolutions, matrix multiplies, linear layers and attention in fp16), then `fold_casts.py` turns the weight casts
autocast leaves in front of each conv/matmul into fp16 weights (outputs bit-identical, file sizes as onnx.3).
onnx.3 exported these four from `model.half()`: residual streams, norms and resizes ran in fp16. C-RADIO's fp16
file and every fp32 file are onnx.3's, byte-identical. Inputs follow the original's types: stage 1 `rgb`, `hint`,
`hint_quality` and stage 2 `rgb` are fp16 (the original feeds bf16), the rest fp32; the engine feeds each input in
its graph's declared type (no engine change; `runtime.rs` test with a mixed set). `build_models.sh` builds onnx.4
(`CK_REUSE_FROM` copies the unchanged files; `CK_MEM_<STEP>_<piece>` caps each step). Why: parity with how
CorridorKey 2.0 computes, not a measured quality gain (README, Quality, "What we got wrong" 1). Speed and memory
against onnx.3: README, Speed, "onnx.4". Everything below about onnx.3 holds for onnx.4 except the fp16 files'
precision (per file in manifest.json, `precision_note`). The TensorRT set from it (`2.0.0-onnx.4-trt`): "TensorRT
set" below.

**`2.0.0-onnx.3`** (`~/.cache/claude-scratch/corridorkey-onnx/models-2.0.0-onnx.3/`) is `2.0.0-onnx.2` with C-RADIO
re-exported so its position grid follows the input's rows and columns: it takes portrait frames (taller than wide),
which every earlier C-RADIO export refused with an ONNX Runtime broadcast error. See "Portrait" below. Same files,
names, inputs, outputs, weights (`.onnx.data` byte-identical) and contract; MoGe, RVM, stage 1 and stage 2 are the
onnx.2 files (hard links). On landscape and square inputs the new C-RADIO is bit-identical to onnx.2's (CPU, fp32
and fp16). `build_models.sh` now builds onnx.3. Everything below about onnx.2 and onnx.1 holds for onnx.3.

**`2.0.0-onnx.2`** (`~/.cache/claude-scratch/corridorkey-onnx/models-2.0.0-onnx.2/`) is `2.0.0-onnx.1` with
stage 1 and stage 2 put through `speed_patches.py` (three exact rewrites, see "Speed rewrites" below). Same
files, names, inputs, outputs and contract; C-RADIO, MoGe and RVM are the onnx.1 files unchanged (hard links).
The manifest lists the rewrites per model. Everything below about onnx.1 holds for onnx.2.

`2.0.0-onnx.1` location: `~/.cache/claude-scratch/corridorkey-onnx/models/` (kept as it was). Built by
`engine-rs/export/build_models.sh` (CPU only, about 9 min). It contains ten models (five networks ×
fp32/fp16), each a `.onnx` plus its external weights `.onnx.data`, which must sit in the same
folder (the file name is stored inside the `.onnx`). It also contains:

- `manifest.json`: version, source checkpoint sha256, and per model the opsets, IR version,
  inputs/outputs with dims, and size + sha256 of both files.
- `models.json`: `{"fp16": {piece: file}, "fp32": {...}}`, the lookup `engine-rs` already reads.

All files: ONNX IR 10, opsets `ai.onnx` 23 + `com.microsoft` 1, ONNX Runtime ≥ 1.31.0. Every
attention is `com.microsoft::MultiHeadAttention` with no mask (see "Attention memory"). Source
checkpoint: `corridorkey_v2.safetensors` sha256 `c43596de…0590436` (full hash in the manifest).

| file | network | precision | inputs → outputs (dims as named in the file) | .data size |
|---|---|---|---|---|
| `ck2-cradio-fp32/fp16.onnx` | C-RADIOv4-SO400M | fp32 / **mixed**: fp16 compute, fp32 weights and fp32 I/O | `rgb` f32 (N,3,H4,W4) → `feat` f32 (N,1152,H4/16,W4/16) | 1.72 / 1.72 GB |
| `ck2-moge-fp32/fp16.onnx` | MoGe-2 ViT-B encoder | fp32 / fp16 | `rgb` (N,3,HM,WM) → `feat` **f32** (N,768,HM/14,WM/14) | 351 / 176 MB |
| `ck2-rvm-fp32/fp16.onnx` | RVM-small, one recurrent step | fp32 / fp16 | `frame` (1,3,H4,W4), `state` (1,NTOK,384) → `feat` **f32** (1,384,H4/16,W4/16), `new_state` (1,NTOK,384) | 133 / 67 MB |
| `ck2-stage1-fp32/fp16.onnx` | stage 1, one Hann window | fp32 / fp16 | `rgb` (1,T,3,H,W), `hint` (1,T,1,H,W), `hint_quality` (1,T), `moge` (1,T,768,H64,W64), `cradio` (1,T,1152,H64,W64), `rvm` (1,T,384,H64,W64) → `baton` (1,T,512,H/16,W/16), `aux` (1,T,4,H/2,W/2) | 1.85 GB / 924 MB |
| `ck2-stage2-fp32/fp16.onnx` | stage 2 | fp32 / fp16 | `rgb` (1,B,3,H,W), `baton` (1,B,512,H16,W16) → `logits` (1,B,4,H,W) | 808 / 404 MB |

Element type is that of the precision (fp16 files take and return fp16) except where the table
says f32. The normalisation of MoGe/RVM/C-RADIO features is inside the graph (it ends in a float
cast). Sizes: fp32 set 4.87 GB, fp16 set 3.30 GB on disk.

Dynamic axes and their contract (the engine must keep these, the graphs don't check them):

- `H`, `W`: the padded model resolution, a **multiple of 128** (upstream `shape_quantum=128`).
  Then H/16 and W/16 are multiples of 8, which the mask-free Swin graph relies on.
  `H4 = H/4`, `HM = 7H/32`, `H64 = H/64`, `H16 = H/16` (and the same for W).
  `NTOK = 1 + (H/64)·(W/64)`.
- `T`: frames in one stage-1 window, any value ≥ 1 (tested 2 to 24). Stage 1 and RVM have a
  static batch of 1.
- `N`: frames per C-RADIO/MoGe call (the window's T).
- `B`: frames per stage-2 call. Any B ≥ 1 gives the same result as B separate calls (checked at
  B = 2, 3: max diff 0). The graph is traced at B = 2. The spike's B = 1 trace was broken for B > 1.

Session options: none special. Default options (`graph_optimization_level = ALL`, CPU arena on)
are what the measurements below use. The files carry no intermediate `value_info` on purpose
(see "Attention memory"), so nothing has to be switched off in the session. Don't re-add shape
info with ORT's symbolic shape inference tool before measuring memory again.

### Host-side steps (mirror `corridorkey/runtime.py`; reference implementation `pipeline.py:run_clip`)

1. **Frame prep** per frame, as upstream `preprocess_frame_dir_path` / `preprocess_video_frame_views`:
   center-pad the frame to (H, W) (`pad_l = (W - w)//2`, `pad_t = (H - h)//2`). It yields the
   *model* view (what `rgb` of stage 1/2 takes) and the *foundation* view (display RGB in [0,1]).
2. **RVM prepass** over the whole clip, before stage 1: foundation view → bilinear
   (align_corners=False) resize to (H/4, W/4), clamp [0,1] → one `ck2-rvm` call per frame. Pass
   `new_state` back as `state` (start from zeros (1,NTOK,384)). Keep `feat` per frame; upstream
   stores it as fp16.
3. **Stage-1 windows**: `window_starts(T_all, chunk, stride)` and `taper_weights(Tc, chunk-stride,
   is_first, is_last)` from `video_io.py` (Hann ramp `0.5·(1 − cos(π·(i+1)/(overlap+1)))`). Per window:
   - foundation view → area resize to (H/4, W/4) → `ck2-cradio` (N = Tc); area resize to
     (7H/32, 7W/32) → `ck2-moge`. Reshape their outputs to (1, Tc, C, H/64, W/64).
   - `hint`/`hint_quality`: carry-hint from the previous window's `aux[:, :, 0]` upsampled
     bilinear to (H, W), clamped [0,1], with quality 0.95. Frames without a carried hint get 0,
     and if no frame in the window has one, `hint_quality` is −1 for the whole window.
   - `ck2-stage1` → `baton`, `aux`. Blend `baton` across overlapping windows with the taper
     weights (Σ w·baton / Σ w). Upstream keeps the blended baton as fp16.
4. **Stage 2** per frame (or B frames): model view + blended baton → `logits`.
5. **Render**: crop the padding, `alpha = clamp(logits[0], 0, 1)`, fg = `logits[1:4]` in asinh
   space → `color_utils.asinh_to_linear` → clamp ≥ 0 → `linear_to_srgb` → clamp [0,1].

The resize kernels (area, bilinear align_corners=False) and the asinh/sRGB transfer must match
PyTorch's; a torch-free engine needs its own parity test for them (still open).

## Attention memory (task of 2026-10-21)

### What was wrong

1. **ONNX `Attention`-23 runs unfused in ORT 1.31.** Single-op probe on the CPU (8 heads, d=64,
   S=8192): `Attention`-23 peak RSS 2.31 GB in fp32 and 5.48 GB in fp16 (it upcasts). The score matrix
   alone is 2.15 GB. `com.microsoft::MultiHeadAttention` (MHA) peaks at 0.20 / 0.23 GB on the same
   probe (fused, flash-style), and 1.20 GB with flash forced off (`ORT_DISABLE_FLASH_ATTENTION=1`).
   At stage-1 shapes (B=8,S=3840; B=15,S=2048; B=120,S=384) MHA stays fused (≤ 0.53 GB peak). On CUDA,
   ORT's MHA picks flash attention for fp16 without mask/bias, cuDNN SDPA on sm90+, and
   memory-efficient (CUTLASS) for fp32. A mask or bias disables flash, and CUDA MHA has no
   zero-batch guard (read in ORT's `multihead_attention.cc`).
2. **The spike's shifted-window masks** were (windows, 1, N, N) booleans with N = 256·T.
3. **ORT's memory-reuse planner + the exporter's `value_info`** (the real cause of the CPU OOMs at
   these sizes). The dynamo exporter writes symbolic shapes for every intermediate tensor (about
   650 to 4000 `value_info` entries per network). With them, ORT's reuse planner held about 4× the
   graph's live set. Stage 1's first encoder block alone needed 1.18 GB, against 0.28 GB with either
   `value_info` removed or `enable_mem_reuse = false`. A liveness walk of the exported graph gives at
   most 0.42 GB live at T=4. Arena, memory pattern, execution order and optimisation level made no
   difference. `enable_mem_reuse` exists only in ORT's Python binding; the C API (and so the Rust
   `ort` crate) has no setter and no config key for it. That is why the fix lives in the files.

### What changed

- **Mask-free shifted windows (`onnx_patches.py` v2).** Every Swin block uses window 16 with shift
  0 or 8, and the /16 grid is a multiple of 8. So every upstream region boundary falls on an
  8-token cell edge. Along each axis a window is either *joined* (one real region) or *split* (two
  halves in different regions, or one half padding). The joined windows are a prefix of the window
  rows/cols: `max(n−2, 0)` on a shifted axis, `H_real // 16` on an unshifted one. Each block then runs
  four mask-free SDPA batches: full windows (16×16×T), the two kinds of half window (16×8×T, 8×16×T),
  and quarters (8×8×T). Each batch gets one zero dummy region prepended and dropped again, so no
  attention call ever has batch 0 (needed for CUDA MHA). Identical attention sets for every real
  query. Padded queries are cropped as before.
- **`to_mha.py`** rewrites every mask-free 4D `Attention` node (all 137 of them across the five
  networks) to `Transpose → Reshape → MultiHeadAttention → Reshape → Transpose`. It drops all
  intermediate `value_info` and renames the dynamic axes (T, H, W, …).

### Measured, CPU

Peak RSS of one session and one `run()` (`ort_mem.py`, default session options), in GB. In
brackets: what `run()` adds on top of the loaded session (sampled every 0.5 ms; the loaded fp32
stage-1 session is 1.95 GB, stage 2 0.9 GB).

| | spike (opset 23, masks, `Attention`) | production fp32 | production fp16 |
|---|---|---|---|
| stage 1, 1280×768, T=4 | 5.32 (3.29) | **2.68 (0.65)** | 2.58 (0.46) |
| stage 1, 1280×768, T=8 | 8.68 (6.57) | **2.99 (0.87)** | 3.10 (0.94) |
| stage 1, 1920×1152, T=12 | n/m | 5.74 (3.30) | n/m |
| stage 1, 1920×1152, T=24 | n/m (masks alone ≈ 1.5 GB per block call) | **9.55 (6.63)** | n/m |
| stage 2, 1280×768, B=1 | 3.71 (2.78) | **1.27 (0.34)** | 1.25 (0.30) |

n/m = not measured. Steps, measured on stage 1 at T=8 (the engine can't use the reuse-off column):

| stage 1, 1280×768, T=8, peak RSS | spike | v2 mask-free, `Attention` | v2 + MHA | v2 + MHA, `value_info` dropped |
|---|---|---|---|---|
| default options | 8.43 | 11.53 | 9.82 | 2.99 |
| `enable_mem_reuse = false`, CPU arena off (Python only) | 6.25 | 6.26 | 2.76 | n/m |

Mask-free alone doesn't help on the CPU, because the unfused `Attention` op still builds the scores.
With the reuse planner holding tensors it is worse, because there are more and smaller tensors.
The saving comes from all three changes together.

**Full pipeline, 720p, 12 frames, window 4/2, CPU, production set, default options:** peak
**7.3 GB** in fp32 and 7.7 GB in fp16 (memrun, whole process including torch host code and frame
cache). The spike's export was OOM-killed at 16 GB on the same run, where PyTorch fp32 needed
6.94 GB.

### Parity (CPU; reference PyTorch fp32 CPU, unpatched upstream model)

Patch v2 against upstream PyTorch (`parity_patch.py`, fp32, T=2, random inputs). Sizes cover 1, 2
and 3+ windows per axis, with and without the 8-token padding:

| pixels (grid /16) | stage-1 baton max abs diff (values up to) | stage-2 max abs diff |
|---|---|---|
| 256×384 (16×24) | 1.9e-6 (3.4) | 7.2e-7 |
| 384×640 (24×40) | 1.9e-6 (3.4) | 6.3e-7 |
| 512×896 (32×56) | 2.1e-6 (3.5) | 6.3e-7 |
| 768×1280 (48×80) | 0 (bit-identical) | 0 |

Full pipeline (`run_parity.py`), production set, ORT CPU, default session options:

| test | alpha MAE | alpha max | SAD/frame | % > 1/255 | % > 4/255 | fg PSNR (all / subject) | non-finite |
|---|---|---|---|---|---|---|---|
| tiny (320×200 → 384×256), 8 frames, 4/2, prod fp32 | 2.1e-7 | 1.7e-4 | 0.014 | 0 | 0 | 102.1 / 95.7 dB | 0 |
| tiny, prod fp16 | 3.0e-5 | 1.1e-2 | 1.89 | 0.050 | 0 | 76.7 / 69.6 dB | 0 |
| gs720, 12 frames, 4/2, prod fp32 | 1.3e-7 | 1.5e-4 | 0.12 | 0 | 0 | 103.0 / 96.7 dB | 0 |
| gs720, 12 frames, 4/2, prod fp16 | 1.2e-5 | 2.7e-3 | 10.7 | 0 | 0 | 77.5 / 69.9 dB | 0 |
| *spike, tiny, opset-23 fp32* | 2.2e-7 | 1.7e-4 | 0.014 | 0 | 0 | 102.2 / 95.7 dB | 0 |
| *spike, tiny, opset-23 fp16* | 3.2e-5 | 9.4e-3 | 2.04 | 0.051 | 0 | 76.6 / 69.6 dB | 0 |
| *PyTorch bf16 autocast (what upstream ships)* | 1.9e-4 | 3.8e-2 | 12.2 | 0.96 | 0.053 | 58.8 / 52.1 dB | 0 |

Against ground truth (tiny), alpha MAE is 0.00759 for both the PyTorch reference and prod fp32,
and 0.00758 for prod fp16. On gs720 it is 0.00542 for the reference and prod fp32, and 0.00542 for
fp16. On tiny, the fp16 max error (1.1e-2, 2.8/255) is a little above the spike's (9.4e-3); MAE, SAD
and the share of pixels over 1/255 are all lower.

### GPU validation (CUDA EP, RTX 5080, 2026-10-21 20:37–20:48)

`gpu_validate.sh` on the procedural clips, 48 frames, ORT 1.31 CUDA EP with default session
options. Reference: PyTorch fp32 on CUDA, upstream model, upstream low-VRAM path (exact).
Marcy's VRAM cap was 12 GiB per process. ORT's `gpu_mem_limit` was split per session: C-RADIO
2.25, MoGe 0.75, RVM 0.5, stage 1 5.5, stage 2 2.0 GiB. Torch got an 11 GiB allocator fraction.
Peak VRAM is the process's own nvidia-smi figure, sampled every 0.2 s. "arena cap" = ORT
`BFCArena` refused an allocation over that session's limit. All failures are recorded, none were
retried.

Peak VRAM (MiB) and non-finite values in the raw outputs (rvm/foundations/stage1/stage2):

| clip, window | production fp16 | production fp32 | spike fp16 (masked `Attention`) | PyTorch fp32 reference |
|---|---|---|---|---|
| 720p, 8/4 | **5478**, 0 | 9964, 0 | 9826, 0 | 7022, 0 |
| 720p, 24/12 | **9908**, 0 | arena cap (stage 1, first MHA) | arena cap (stage 1, `Attention`) | 10256, 0 |
| 1080p, 8/4 | **7800**, 0 | 11246, 0 | arena cap (`Concat`) | 9480, 0 |
| 1080p, 24/12 | **10094**, 0 | arena cap (stage 1) | arena cap (stage 1, `Attention`) | CUDA OOM at 11 GiB |

The production fp16 set is the one that fits 24-frame windows at 1080p under 12 GiB, with no
inf/nan anywhere. Stage-2 raw |max| stayed at 1.14 to 1.17 in every run. fp32 at 24/12 doesn't fit
the 5.5 GiB stage-1 session cap; it was not tried with another split.

Parity against the PyTorch fp32 CUDA reference (same clip and window):

| test | alpha MAE | alpha max | % > 1/255 | % > 4/255 | fg PSNR (all / subject) |
|---|---|---|---|---|---|
| prod fp32, 720p 8/4 | 7.0e-6 | 6.6e-3 | 0.0004 | 0 | 81.9 / 75.9 dB |
| prod fp32, 1080p 8/4 | 6.3e-6 | 2.8e-3 | 0 | 0 | 83.1 / 76.1 dB |
| prod fp16, 720p 8/4 | 1.7e-5 | 8.7e-3 | 0.0019 | 0 | 74.6 / 67.8 dB |
| prod fp16, 720p 24/12 | 1.7e-5 | 3.1e-3 | 0 | 0 | 75.3 / 67.8 dB |
| prod fp16, 1080p 8/4 | 1.5e-5 | 1.9e-2 | 0.0019 | 0.00003 | 75.2 / 67.9 dB |
| spike fp16, 720p 8/4 | 1.7e-5 | 9.0e-3 | 0.0013 | 0 | 74.6 / 67.8 dB |
| prod fp16, 1080p 24/12 | no reference (PyTorch fp32 OOM) | | | | |

Against ground truth, prod fp32/fp16 and the reference agree to the 3rd digit (alpha MAE 0.00544
at 720p 8/4, 0.00482 at 1080p 8/4). GPU fp32 vs GPU fp32 differs more than CPU vs CPU (MAE 7e-6
vs 1e-7). Both runtimes use cuDNN/cuBLAS kernels with their own algorithms (torch allows TF32 in
cuDNN convolutions by default); this is unmeasured per op. Speed was measured too (in
`results/gpu/validate.log`) but isn't part of this validation.

## Portrait (C-RADIO position grid, set `2.0.0-onnx.3`, 2026-10-22)

**What was wrong.** C-RADIO runs in CPE mode: in eval, `ViTPatchGenerator._get_pos_embeddings`
(`vfms/cradio/C-RADIOv4-SO400M/vit_patch_generator.py`) resizes its stored 128×128 position grid bilinearly to
(M, M) with M = `max(rows, cols)` of the patch grid, then `window_select` crops the rows `if rows < M` and the
columns `if cols < M`. Those two Python `if`s are guards: the export, traced at 768×1280 (12×20 patches), kept
only the row crop. M itself stayed symbolic (the onnx.2 graph has a `Max` node feeding the `Resize`). So a
portrait input got an M×M = rows×rows grid: at 1280×768 padded (20×12 patches) 400 position tokens against 240
patches, ONNX Runtime's "Attempting to broadcast an axis by a dimension other than 1. 240 by 400" in `add_52`.
Every landscape and square shape ran (there the missing column crop is a no-op).

**Fix** (`onnx_patches.cradio_pos_embeddings`, applied by `onnx_patches.apply()` with `--patch`): the same
computation with both crops as unconditional slices, `[:rows, :cols]` (a no-op on the side that equals M, so
identical to upstream's `window_select`), and M as `torch.sym_max(rows, cols)`. After the crops the grid always
has the patches' shape, so upstream's final resize never runs and is left out. Same ops in the same order as
upstream: patched PyTorch vs upstream PyTorch is 0 (bit-identical) on every shape below. Not padding to square:
C-RADIO sees exactly what upstream PyTorch shows it.

**Parity** (`cradio_parity.py`, ORT CPU, N=2 smooth random frames; reference upstream PyTorch fp32 CPU,
unpatched; max / mean abs difference of `feat`, whose values reach 9-26). onnx.2 failed on every portrait row.

| padded H×W (patch grid) | onnx.3 fp32 | onnx.3 fp16 (mixed) | TensorRT-ready fp16 (`models-trt-2`, ORT CPU) |
|---|---|---|---|
| 1280×768 (20×12), portrait | 1.2e-5 / 7.1e-7 | 6.4e-3 / 1.7e-4 | 1.2e-2 / 3.1e-4 |
| 1152×640 (18×10), portrait | 3.3e-5 / 7.9e-7 | | |
| 1920×1152 (30×18), portrait | 2.0e-5 / 7.3e-7 | 7.1e-3 / 1.8e-4 | 9.7e-3 / 3.4e-4 |
| 384×256 (6×4), portrait | 3.1e-5 / 9.8e-7 | 6.1e-3 / 2.0e-4 | |
| 1280×256 (20×4), portrait 5:1 | 3.1e-5 / 7.6e-7 | | |
| 768×1280 (12×20), landscape | 4.0e-5 / 7.6e-7 | 8.1e-3 / 1.7e-4 | 1.8e-2 / 3.2e-4 |
| 1152×1920 (18×30), landscape | 1.9e-5 / 7.1e-7 | 1.0e-2 / 1.8e-4 | |
| 640×1152, 256×384, 768×768, 256×256 | 1.3e-5 to 4.7e-5 / 7.4e-7 to 8.6e-7 | 4.1e-3 / 1.7e-4 (768×768) | |

The landscape and square rows are the same numbers as onnx.2's, and the outputs bit-identical to onnx.2's
(`max 0` at 768×1280, 1152×1920, 768×768, 256×384, fp32 and fp16): the new graph only differs where the grid is
taller than wide. Portrait error is the size of landscape error in every precision.

End to end (corridorkey-desktop `docs/ENGINE_RUST.md`, "Portrait"): the procedural tiny clip transposed (200×320,
padded 384×256) through the Rust engine on the CPU against upstream PyTorch fp32: alpha MAE 1.46e-7, max 3.4e-5,
fg PSNR 103.0 / 96.1 dB (the landscape tiny clip: 2.11e-7, 1.7e-4, 102.3 / 95.8 dB).

**A 128 px side** (`small_side.py`) still fails in the ONNX stage 1 with every set (onnx.3 too): `Pad reflect:
pre-pad (3) exceeds maximum allowed (1)` on the 2-cell grid. Upstream PyTorch runs it: `blocks.py` picks
`'reflect' if H > pad and W > pad else 'replicate'`, a Python branch the export fixed to `reflect` (the same kind
of trace-baked branch as the C-RADIO grid). C-RADIO, MoGe, RVM and stage 2 ran at 128×384, 384×128, 128×128.
The engine keeps refusing a side of 128 px or less; the fix would be the same kind of patch on stage 1 (and the
stage-2 branch at `stage2.py:211`), not done here.

## Speed rewrites (`speed_patches.py`, set `2.0.0-onnx.2`, 2026-10-21)

GPU time per kernel was measured with CUPTI (torch.profiler around ONNX Runtime CUDA runs, kernels mapped to
ORT nodes through their launch time; ORT's own per-node profile times only the host-side launch on CUDA).
RTX 5080, ORT 1.31 CUDA EP, fp16, 1280×1152, random inputs, one session per process, steady runs:

| GPU time per run | onnx.1 | + window pads | + ConvTranspose | + grouped convs (onnx.2) |
|---|---|---|---|---|
| stage 2, B=1 | 73.5 ms | | 59.8 ms (pads + ConvTranspose together) | **53.4 ms** |
| stage 1, T=24 | 1158 ms | | 999 ms (pads + ConvTranspose together) | **915 ms** |

The three rewrites, each exact math (no approximation):

1. **Window pads.** The mask-free Swin blocks pad channel-last tensors at the end of H and W with pads computed
   in the graph. ORT runs these through its generic N-d CUDA Pad kernel: 15.2 ms per stage-2 run (7 pads),
   182 ms per stage-1 run at T=24 (9 pads). As Reshape(B·T, 1, H, W·C) → Pad(H end, (Wp−W)·C) → Reshape they
   hit ORT's 4D "pad along H and W" kernel (~0.16 ms each). Row-major, padding W·C values at the end of each
   row is padding W by Wp−W columns of C values: bit-identical.
2. **Depatchify ConvTranspose** (stage 2: 1280→4, kernel 32, stride 16, pad 8; stage 1 aux: 512→4, kernel 16,
   stride 8, pad 4). With kernel 2s: out[s·q + r] = X[q]·W[r] + X[q−1]·W[r+s], i.e. a 2×2 Conv to 4·s² channels
   over X zero-padded by 1, DepthToSpace(s, CRD), and the s/2 crop. Same products, other summation order.
   It also removes the ConvTranspose's cuDNN workspace (the Rust engine saw a 5.77 GB request at 1280×1152).
3. **Grouped 7×7 convs** (DepthwiseSwiGLU2D: value and gate filters as one Conv with group = dim and two filters
   per channel). cuDNN's grouped kernel took 0.81 ms per stage-2 call against 0.14 ms for a plain depthwise conv
   of a similar size; up to 8.5 ms per call in stage 1 at T=24. After the rewrite: stage 2's convolutions 13.0 →
   6.2 ms per run, stage 1's 178 → 91 ms at T=24. Each input channel is repeated in place
   (Unsqueeze → Expand(2) → Reshape: channel 2c+j = channel c) and the same weights run with group = 2·dim:
   output channel o still reads input channel o // 2 with filter o. Bit-identical on the CPU.

Not changed: NHWC layout (`prefer_nhwc=1`) doubled stage 2's time (147.8 ms); stage-2 batching is slower per
frame (B=2 59 ms, B=4 66 ms per frame against 53 ms at B=1); cuDNN search / workspace settings don't change
these kernels. What remains in stage 1 at T=24 (915 ms): attention 213 ms, MatMul 153 ms, convolutions 91 ms,
and 1701 small element-wise / data-movement nodes (Add, Transpose, Slice, Mul, Concat, …) 364 ms, none over
2 ms (bias adds after 3D MatMuls, RoPE, the region split of the mask-free windows).

Parity (`test_speed_patches.py`, ORT CPU fp32; and `gpu_parity` on CUDA at full size):

| check | max abs diff |
|---|---|
| ConvTranspose alone, stage 2 weights, input N(0,1) (1,1280,72,80) / (1,1280,5,3) | 1.4e-6 / 2.1e-6 (values up to 3.9) |
| ConvTranspose alone, stage 1 aux weights (1,512,72,80) | 7.2e-7 |
| window pad alone, rank 4 and 5, odd sizes | 0 |
| grouped conv alone, stage 2 / stage 1 weights | 0 |
| whole stage 2, 640×384 B=1 / 384×256 B=2 | 4.1e-8 / 3.7e-8 |
| whole stage 1, 640×384 T=2: baton / aux | 0 / 5.4e-7 |
| CUDA, 1280×1152, onnx.2 fp32 vs onnx.1 fp32: stage 2 / stage 1 baton / stage 1 aux | 1.2e-6 / 0 / 3.4e-6 |
| CUDA, 1280×1152, against onnx.1 fp32: onnx.1 fp16 vs onnx.2 fp16, stage 2 mean abs | 1.966e-4 vs 1.965e-4 (max 2.31e-3 both) |
| CUDA, stage 1 T=8 baton, same | 6.652e-4 vs 6.652e-4 (max 1.20e-2 both) |

End to end on the six real clips (Rust engine, docs/ENGINE_RUST.md in corridorkey-desktop): alpha agreement with
the PyTorch engine is unchanged to three digits (e.g. locked_backdrop alpha MAE 6.12e-4 with either set).

## TensorRT set (`build_trt_models.sh`, 2026-10-21)

**`2.0.0-onnx.4-trt` (2026-10-25):** from onnx.4. Stage 1 and stage 2 are re-exported with `--amp` + `fold_casts.py`
(as the set), so they are mixed precision too; `to_trt.py` now reads each op's type by ONNX type inference
(`elem_types`) instead of the file's input type: the attention scale takes Q's type, MoGe's antialiased resize stays
in fp32 where the policy put it, and FP32 islands move only ops that compute in fp16 (fp32 ops stay as they are).
C-RADIO's TensorRT file comes out byte-identical to onnx.3-trt's (the same source file; a check that fully fp16
inputs give what they gave before). MoGe's and RVM's `.onnx.data` are about half onnx.3-trt's: their weights sit
behind a Transpose, so the islands cast them to fp32 in the graph instead of storing fp32 copies (same values;
TensorRT folds the cast at build time).

For corridorkey-engine's opt-in TensorRT path. Built next to a production set (never over it); scratch copy:
`~/.cache/claude-scratch/corridorkey-onnx/models-trt-1/` (made from `2.0.0-onnx.2`: its C-RADIO, MoGe and RVM
files are identical to `onnx.1`'s, sha256 checked). Per network `ck2-<piece>-trt-fp16.onnx` (+ `.data`) and
`ck2-<piece>-trt-fp16-ctx.onnx`; `models.json` keys `tensorrt-fp16` and `tensorrt-fp16-ctx`.

What TensorRT 10.16's ONNX parser rejected in the production set, and the rewrite (`to_trt.py`, `onnx_patches.py`):

| what | parser error | rewrite | checked (ORT CPU fp32, against the production file) |
|---|---|---|---|
| `com.microsoft::MultiHeadAttention` (137 nodes) | plugin not found | back to the 4D form: `Q·(1/√d)`, `MatMul(Kᵀ)`, `Softmax`, `MatMul(V)` (the pattern TensorRT fuses) | max abs ≤ 2.4e-6 (stage 1/2, RVM, C-RADIO ≤ 2.1e-5 on features of ±6) |
| MoGe `Resize` antialias=1 | not supported | two in-graph weight matrices, `W[o,j] = max(0, 1 − |j+½ − s(o+½)| / max(s,1))`, rows normalised | formula vs torch `_upsample_bilinear2d_aa`: ≤ 3e-7 (down and up); MoGe features ≤ 4.1e-4 on ±5 |
| 10-D reshapes in the mask-free Swin regions | `MAX_DIMS` (8) | `_regions` / `_unregions` merge (Bn, r, c) and (heads, T): 7 dims, same element order | bit-identical in torch (all four shift cases); stage 1/2 graphs ≤ 2.4e-6 |

**Portrait (2026-10-22):** `models-trt-1`'s C-RADIO comes from the onnx.2 C-RADIO and fails on portrait like it
(ORT CPU: the same broadcast error). `~/.cache/claude-scratch/corridorkey-onnx/models-trt-2/` is `models-trt-1` with
only C-RADIO rebuilt from onnx.3's (`to_trt.py … --fp32-ops=Conv,ConvTranspose,MatMul --weights-only`, then
`trt_ctx.py`; the other files are hard links). On ORT CPU it takes portrait with the landscape error size (table in
"Portrait"); a TensorRT engine for a portrait range was not built or measured on the card. The engine rebuilds a
range's engines by itself when an export's size / time stamp changes.

### Precision: why the engines are strongly typed with FP32 islands

Per network on real data (gs1080, 1152×1920, 4 frames; `trt_netparity.py`): every network's inputs and outputs
from the production **fp32** set on ORT CUDA (TF32 off), then each candidate fed the same inputs. Mean / max abs
difference against fp32 (stage 2 also: alpha MAE).

| network (output) | ORT CUDA fp16 (production) | TensorRT via ORT's provider (weakly typed FP16) | TensorRT strongly typed + FP32 islands |
|---|---|---|---|
| RVM, first step (feat) | 6.39e-3 / 0.839 | 1.33e-2 / 3.09 | 6.11e-3 / 0.557 |
| C-RADIO (feat) | 1.00e-3 / 0.092 | 3.56e-3 / 1.007 | 9.31e-4 / 0.146 |
| MoGe (feat) | 3.43e-3 / 0.047 | 7.89e-3 / 0.309 | 3.13e-3 / 0.086 |
| stage 1 (baton) | 3.34e-4 / 7.10e-3 | 8.56e-4 / 3.94e-2 | 3.28e-4 / 6.51e-3 |
| stage 1 (aux) | 9.50e-5 / 2.42e-3 | 2.35e-4 / 1.84e-2 | 8.41e-5 / 3.44e-3 |
| stage 2 (logits) | 5.83e-5 / 2.02e-3 | 2.32e-4 / 1.09e-2 | 5.41e-5 / 2.09e-3 |
| stage 2 alpha MAE | 1.58e-5 | 1.24e-4 | 1.38e-5 |

The weakly typed build is 2-4× the CUDA fp16 error in every network; the same file strongly typed without islands
gives the same numbers (the loss is in TensorRT's FP16 kernels, not in typing). Stage 2, pinning layer types to
FP32 (`trt_typing_probe.py pin:`; mean abs): none 2.32e-4, MatMul 1.77e-4, ConvTranspose 1.38e-4, Conv+ConvTranspose
1.29e-4, normalisation/softmax/reduce 2.32e-4, elementwise/unary/activation 2.28e-4, Conv+ConvTranspose+MatMul
5.34e-5. So `to_trt.py --fp32-ops=Conv,ConvTranspose,MatMul --weights-only` casts the weight GEMMs and convolutions
to float32 in the fp16 graphs (MoGe: every MatMul; with weights only its mean was 4.46e-3). Only a strongly typed
network honours those casts (weakly typed with them: identical to no islands), and ORT's TensorRT provider has no
strongly typed option (1.31 option list checked), so corridorkey-engine builds the engines itself (`ck-trt-build`)
and ORT runs them through the EPContext stub. Means are at or below CUDA fp16's in every network; some maxima
are above it: MoGe 0.086 vs 0.047, C-RADIO 0.146 vs 0.092, stage-1 aux 3.4e-3 vs 2.4e-3, stage 2 2.09e-3 vs 2.02e-3.

Time per call, TensorRT Python API (`trt_typing_probe.py`, median of 5, 1152×1920): stage 2 57 ms weakly typed,
99 ms strongly typed + islands, 64 ms + the `onnx.2` speed rewrites (same parity); stage 1 (T=4) 102 / 141 / 120 ms.
C-RADIO (4 frames) 12 → 19 ms, MoGe 3 → 4.6 ms, RVM 0.9 ms either way.

Not used, recorded: TensorRT pure FP32 (TF32 off) doesn't build RVM or stage 2 at 4 GB workspace ("could not find
any implementation"); the weakly typed BF16 build of the fp32 files fails in stage 1 (type inference of the
ConvTranspose).

## Core ML set (`coreml/build_coreml_models.sh`, published as `2.0.0-onnx.4-coreml`, 2026-10-27)

For corridorkey-engine's `--device coreml` (macOS, BACKLOG rows 24 and 59). Fixed-shape copies of the shipped fp16
files, rewritten so ONNX Runtime's Core ML provider takes every node (the steps in the script's header); each keeps
its weights in the shipped set's `ck2-<piece>-fp16.onnx.data` (checked by `write_set.py`), so the files go into the
model set's own folder (ONNX Runtime refuses external weights outside the model's folder: a symlinked set fails).
RVM's input `state` is renamed `ck_state` (a name Core ML's ML Program parser reserves; the engine maps it back).
Graph outputs keep no shape (`fix_shapes.py` leaves them for ORT to infer): the ONNX checker refuses that as written;
with the inferred output shapes filled in it passes.

The published set is for 1280×1080 clips only (4K has no Core ML set yet, BACKLOG row 60; the 1920×1080 files
below are built, not yet published). From `2.0.0-onnx.4` (padded 1152×1280; the engine takes the smallest stage-1 window it has,
4/2 low-memory): C-RADIO and MoGe at 4 frames per call (the low-memory prepass's chunk), RVM, stage 1 at 4 and 8, stage 2
at 1; 1,089,814,318 bytes in seven files (`coreml.json` last). Built on the Linux PC (the graph rewrites are plain CPU
work; on the 16 GB Mac C-RADIO's fold reached the memory gate's pressure limit at 8 GB): ORT's Core ML partitioner
(Linux build) puts every node of every file on Core ML in one partition, and the files are byte-identical to the
2026-10-26 rebuild (sha256), so the build is reproducible.

```
engine-rs/export/coreml/build_coreml_models.sh ~/.local/share/corridorkey-desktop/models/2.0.0-onnx.4 OUT 1152x1280 \
  cradio:4 moge:4 rvm:1 stage1:4 stage1:8 stage2:1   # OUT/set: the six files, coreml.json, SHA256SUMS
tools/upload_model_set.sh OUT/set 2.0.0-onnx.4-coreml   # the release models-2.0.0-onnx.4-coreml (Marcy's OK first)
```

**1920×1080 clips** (row 60, built 2026-10-27; on the Mac mini M6 16 GB: peak 3.35 GB at window 4/2, 5.25 GB at 8/4, ~2.1 fps steady, mattes within 1/255 of CUDA): the same six networks at
1152×1920 (1080 pads to 1152, 1920 is already a multiple of 128: `clip.rs` `SHAPE_QUANTUM`), 1,092,898,613 bytes. The
same script; C-RADIO's fold peaked at 5.3 GB (memrun). Two builds gave byte-identical files, and the 1152×1280 build
of the same day reproduced the published files' SHA-256. The engine picks a size's files from `coreml.json` by the
clip's padded size (a size the set lacks is refused, naming the sizes it has), so one `coreml.json` lists both sizes:
`write_set.py` over a folder holding both builds' files writes it.

```
B=engine-rs/export/coreml; S=~/.local/share/corridorkey-desktop/models/2.0.0-onnx.4
$B/build_coreml_models.sh $S OUT1280 1152x1280 cradio:4 moge:4 rvm:1 stage1:4 stage1:8 stage2:1
$B/build_coreml_models.sh $S OUT1920 1152x1920 cradio:4 moge:4 rvm:1 stage1:4 stage1:8 stage2:1
mkdir BOTH && ln OUT1280/build/ck2-*-coreml-*.onnx OUT1920/build/ck2-*-coreml-*.onnx BOTH/
python -I $B/write_set.py BOTH SET $S              # SET: twelve files + coreml.json with both sizes, SHA256SUMS
tools/upload_model_set.sh SET 2.0.0-onnx.4-coreml  # adds the six new files and replaces coreml.json (Marcy's OK first)
```

The app's setup on macOS downloads it (electron/main/install.ts `COREML`, pinned by size and SHA-256) into
`.partial-2.0.0-onnx.4-coreml`, then moves the files into the model set's folder, `coreml.json` last; a set
installed without it gets it the next time the setup runs.

## onnx.5: one masked attention (candidate `2.0.0-onnx.5`, built and measured 2026-10-27)

Why: AMD's MIGraphX can't load stage 1 or stage 2 of onnx.4 (docs/AMD.md on branch `amd`): ONNX `RMSNormalization`
is unknown to it, and onnx_patches v2 splits every Swin block into four region groups whose sizes follow the input
size, so at every size some group is empty (MIGraphX reads a 0 in a Reshape target as "copy"). Apple's Neural Engine
compiler overflows its stack scheduling stage 2's attention branches (four per Swin block in v2). `onnx5_patches.py`
replaces three things at export time, on top of v2; Corridor's code and weights are unchanged.

- **Stage 2: one masked attention per Swin block.** The standard Swin form: windows of the padded, rolled grid, one
  attention over all of them with an additive mask (0 where query and key share a region, -inf elsewhere). The
  labels are upstream's (`_shifted_region_ids_2d`: slices (0, -w), (-w, -s), (-s, None) of the padded pre-shift grid,
  padding its own region, whose queries are cropped after). The mask is (B·windows, 1, 256, 256): 5.2 MB per frame at
  HD (40 windows), 17.7 MB at 4K (135), one per block shape and shift, shared by the blocks that have it. Attention
  nodes 30 → 12. A mask turns CUDA flash attention off: MHA then uses memory-efficient attention (speed: test request).
- **Stage 1: mask-free regions, gathered.** Stage 1 attends over 256·T tokens per window, T up to 80 in the engine;
  a mask would be (windows, N, N) with N = 256·T, e.g. 40 × 20480² values at 1920×1152, T=80, so the single masked
  form isn't possible there. Stage 1 keeps v2's exact regions (full windows, halves, quarters), but takes them
  straight from the token grid with **one Gather per q / k / v** (the index includes the window partition and the
  region split), with **one zero region appended to every group**, so no tensor is ever empty at any size, runs four
  plain attentions and puts the result back with **one Gather**. Inside a region the tokens are frame-major
  (t, y, x), v2's order, so attention sums in onnx.4's order (the first build gathered (y, x, t); see the floor
  below). The indices are built from broadcast ranges and compares (no division), once per block shape and shift (four ScatterElements in the whole network).
- **RMSNorm in plain ops.** torch's own `rms_norm` composite (fp32 inside, back to the input type, times the weight)
  written as Pow / ReduceMean / Add / Sqrt / Div / Cast / Mul, the pattern ONNX Runtime fuses back into one
  SimplifiedLayerNormalization at load; `LayerNorm2d` reduces over the channel axis in place (no permute pair).
- **`to_mha.py`** turns a masked `Attention` into MHA with the mask as `attention_bias`, and drops Transpose pairs
  that undo each other (128 pairs in stage 1, 27 in C-RADIO). `to_trt.py`'s plain form adds the mask before the
  softmax and accepts MHA inputs whose pair was dropped.
- **C-RADIO fp16 with fp16 weights (BACKLOG row 152).** Exported as before (fp16 autocast), then `fold_casts.py`
  turns its 109 weight casts into fp16 initializers: 1,724,414,688 → 900,504,288 bytes; fp16 initializers
  0.768 GiB, fp32 0.071 GiB (norms, position grid). Same inputs, outputs and op types; ONNX Runtime's optimised
  graph (Core ML probe below) has 933 nodes for both files. ORT folded those casts at load before, so the card holds
  the same fp16 weights. The TensorRT set's C-RADIO keeps starting from onnx.4's file (`CK_TRT_CRADIO_FROM`): its
  fp32 islands need the fp32 weights.

Inputs, outputs, names, dtypes and dynamic axes are unchanged (checked on all four stage files), so the engine needs
no change. Set download (the five fp16 files): 3,302,681,217 → 2,478,578,104 bytes.

**Region maps, checked (index arithmetic only, no model):** for 280 grid / shift / batch cases (1-5 windows per
axis, with and without the 8-token padding) every real token's attention set from the gather maps and from the
stage-2 mask equals upstream's region labels; the back map inverts the forward map; every group holds ≥ 1 region.
A mutated shift fails the check.

**Static comparison** (`2.0.0-onnx.4` → `2.0.0-onnx.5`; layout = Reshape, Transpose, Slice, Concat, Pad, Expand,
Tile, Squeeze, Unsqueeze, Gather, Split, Flatten, DepthToSpace):

| file | nodes | layout ops | Reshape | Transpose | Slice | Concat | attention | RMSNormalization |
|---|---|---|---|---|---|---|---|---|
| stage 1 fp16 | 4322 → 4505 | 2911 → **2197** | 925 → 727 | 608 → 310 | 541 → 361 | 403 → 247 | 48 → 48 | 111 → 0 |
| stage 1 fp32 | 4100 → 4137 | 2772 → **2071** | 912 → 727 | 482 → 184 | 541 → 361 | 403 → 247 | 48 → 48 | 111 → 0 |
| stage 2 fp16 | 2377 → 2039 | 1686 → **1024** | 531 → 247 | 366 → 202 | 341 → 205 | 226 → 121 | 30 → 12 | 50 → 0 |
| stage 2 fp32 | 2268 → 1862 | 1655 → **963** | 530 → 247 | 305 → 141 | 341 → 205 | 257 → 121 | 30 → 12 | 50 → 0 |

The node count of stage 1 grows by the norms written out (111 × 5 ops, fused again by ORT at load). Stage 1's
remaining layout ops are outside the windowed attention (CSwin / full blocks, the rolls, the DepthwiseSwiGLU
convolutions): not touched here.

**MIGraphX 2.18 parser** (`tools/migraphx_ops.py`, parsing only, at 384×256, 1280×1152, 1920×1152 and 3840×2176,
4 frames): the TensorRT-form files (plain attention; what `migraphx_patch.py` starts from) parse for **all five
networks at all four sizes**, without the RMSNorm patch (onnx.4: stage 1 and 2 refused). In the plain fp16 set
stage 1 parses at all sizes; stage 2 doesn't: MIGraphX's MultiHeadAttention parser wants `attention_bias` with one
row per head (ours broadcasts one mask over the heads), so AMD keeps using the TensorRT-form files.

**ORT Core ML partitioner** (`coreml/ep_probe.py`, the Linux ORT 1.31 build with the Core ML EP, ML Program, session
creation only, the dynamic files with their sizes fixed to 1152×1280, T=4; no `fold.py`, so these are not the Core
ML set's numbers, only old against new on equal terms). Core ML partitions / nodes left on the CPU:

| file | onnx.4 | onnx.5 |
|---|---|---|
| stage 1 fp16 | 210 / 1163 | 113 / 590 |
| stage 1 TensorRT form | 190 / 919 | 93 / 346 |
| stage 2 fp16 | 101 / 726 | 49 / 164 |
| stage 2 TensorRT form | 91 / 576 | 39 / 100 |
| C-RADIO fp16 | 29 / 138 | 29 / 138 |

**Measured 2026-10-27, first build** (`onnx5_parity.sh`, Marcy's OK; RTX 5080, ORT 1.31, the engine at main c3864a1).
These runs used the first build, whose stage-1 regions were (y, x, t) inside; the set was rebuilt the same day with
v2's frame-major order (static checks repeated: region maps, MIGraphX, Core ML partitions 113 / 93 unchanged) and
awaits the same runs:

- `torch` (PyTorch fp32, CPU, onnx5_patches against Corridor's unpatched code; 256×384, 384×640, 512×896 T=2,
  768×1280 T=4): stage 1 baton max 1.7e-6 to 2.1e-6 (values up to 3.6), aux ≤ 8.3e-7; stage 2 ≤ 1.0e-6. v2's level.
- `net`, ORT CPU, onnx.4 against onnx.5, same seeded inputs (256×384 T=2, 384×640 T=4, 768×1280 T=4): fp32 stage 1
  baton ≤ 2.4e-6, stage 2 ≤ 4.5e-7; fp16 stage 1 baton ≤ 2.1e-3 (values up to 3.9; fp16's step there is 2e-3), aux
  ≤ 4.9e-4, stage-2 matte ≤ 0.001/255; C-RADIO fp16 bit-identical. No non-finite values.
- `cuda`, the same on ORT CUDA fp16 at 1152×1920 T=8 and 2176×3840 T=4: stage 1 baton ≤ 6.4e-3 (values up to 4.8),
  aux ≤ 9.8e-4, stage-2 matte ≤ 0.016/255 (mean 0.002/255); C-RADIO bit-identical. 3 min, peak 6.7 GB on the card.
- `engine` (the Rust engine on CUDA, automatic window, float EXR, onnx.4 then onnx.5 per clip; 64 min):

| clip | size, frames | window | total s (4 → 5) | steady fps | peak VRAM GB | peak RSS GB | alpha max ×255 | alpha MAE | % px > 1/255 | sizzle (edge, 4 / 5) |
|---|---|---|---|---|---|---|---|---|---|---|
| godiva_close | 960×720, 349 | 80/40 | 38.7 → 37.5 | 12.08 → 12.28 | 9.84 → 9.51 | 6.40 → 6.31 | 0.37 | 3.4e-5 | 0 | 0.01084 / 0.01084 |
| locked_backdrop | 1280×1080, 80 | 48/24 low | 17.5 → 16.6 | 16.91 → 17.23 | 8.98 → 9.04 | 6.35 → 6.42 | 0.37 | 1.4e-5 | 0 | 0.02054 / 0.02054 |
| metal_glasses | 1280×1080, 139 | 48/24 low | 26.7 → 25.9 | 16.77 → 17.10 | 9.04 → 9.05 | 6.52 → 6.57 | 0.50 | 1.7e-5 | 0 | 0.00926 / 0.00926 |
| smoke | 1280×1080, 250 | 48/24 low | 47.5 → 45.9 | 16.69 → 16.99 | 9.04 → 9.04 | 6.59 → 6.63 | **1.12** | 2.4e-5 | 3e-7 | 0.01276 / 0.01276 |
| walking_sitting | 1280×1080, 314 | 48/24 low | 59.4 → 58.2 | 16.60 → 16.89 | 9.04 → 9.04 | 6.59 → 6.58 | **3.24** | 9.4e-6 | 5e-4 | 0.03659 / 0.03658 |
| with_motion_blur | 1280×1080, 50 | 48/24 low | 13.0 → 12.1 | 17.13 → 17.30 | 9.04 → 9.04 | 6.07 → 6.07 | 0.37 | 9.7e-6 | 0 | 0.03752 / 0.03750 |
| 04_2c | 4096×2160, 120 | 8/4 | 171.6 → 168.0 | 0.78 → 0.79 | 10.82 → 10.82 | 7.46 → 7.21 | 0.50 | 1.2e-5 | 0 | 0.02049 / 0.02049 |
| 04_5d | 4096×2160, 120 | 8/4 | 172.0 → 168.3 | 0.78 → 0.79 | 10.82 → 10.82 | 7.42 → 7.10 | **3.98** | 8.4e-6 | 7e-4 | 0.02521 / 0.02520 |
| 04_5h | 4096×2160, 120 | 8/4 | 169.2 → 168.1 | 0.78 → 0.79 | 10.82 → 10.82 | 7.44 → 7.18 | 0.75 | 1.0e-5 | 0 | 0.01812 / 0.01812 |
| 08_3a | 4096×2160, 120 | 8/4 | 172.9 → 167.9 | 0.77 → 0.79 | 10.82 → 10.82 | 7.40 → 7.23 | 0.62 | 6.9e-6 | 0 | 0.02149 / 0.02149 |

  Sizzle (tools/temporal_stability.py, the static hair-edge band's mean frame-to-frame change) is equal or lower on
  every clip; speed 1-7 % faster, graphics memory the same, host memory up to 0.3 GB lower at 4K. **The max bar
  (≤ 1/255 against onnx.4) fails on 3 of 10 clips** (1.12, 3.24 and 3.98 /255), on a few hair-edge pixels: at most
  0.0007 % of pixels over 1/255 (04_5d: about 60 pixels a frame), MAE ≤ 3.4e-5.
- Floor (same day, Marcy's OK; onnx.4 twice at test 4's settings, and `tools/vs_original.sh --steps quality`: the
  original twice and onnx.4 once). Alpha max ×255 / MAE / % of pixels over 1/255:

| clip (window) | onnx.4 vs onnx.4 | original vs original | onnx.4 vs original | onnx.5 vs onnx.4 |
|---|---|---|---|---|
| smoke (48/24) | 0 / 0 / 0 | 3.98 / 1.4e-4 / 0.011 | 38.6 / 7.5e-4 / 6.0 | 1.12 / 2.4e-5 / 3e-7 |
| walking_sitting (48/24) | 0 / 0 / 0 | 12.95 / 4.0e-5 / 0.016 | 93.5 / 1.8e-4 / 0.83 | 3.24 / 9.4e-6 / 5e-4 |
| 04_5d (8/4) | 0 / 0 / 0 | 7.97 / 1.5e-4 / 0.042 | 40.5 / 2.8e-4 / 0.98 | 3.98 / 8.4e-6 / 7e-4 |

  onnx.4 is bit-reproducible on CUDA, so onnx.5's differences come from its graph (stage 1's token order inside a
  region, the masked stage-2 kernel, the written-out RMSNorm), not from run-to-run noise. They are below the
  original's own run-to-run spread on every clip (3.98 vs 3.98, 3.24 vs 12.95, 3.98 vs 7.97 /255 at the max; 6-17×
  lower MAE) and 10-30× below onnx.4's distance to the original. (`vs_original.sh` keys our side at a 12 GB budget:
  04_5d then runs at 4/2 against the original's 8/4; the 04_5d onnx.4 vs original row above is onnx.4 at 8/4.)

Not measured: TensorRT and CPU engine runs, whether Apple's Neural Engine now compiles stage 2, a MIGraphX run on an
AMD card.

```
cd engine-rs/export
CK_ONNX_VERSION=2.0.0-onnx.5 CK_PATCH=--onnx5 CK_NEW_PIECES="stage1 stage2 cradio:fp16" CK_FOLD_CRADIO=1 \
  CK_REUSE_FROM=<onnx.4 files incl. fp32> CK_MODELS_DIR=OUT ./build_models.sh       # ~6 min CPU, peak 7 GB
./onnx5_parity.sh torch|net|cuda|engine|cpu ONNX4_SET ONNX5_SET OUT                 # the test requests (not run)
```

## Test clips

Procedural (`make_clip.py`), so they carry no rights and come with a ground-truth alpha. Each has
an unevenly lit, wrinkled green backdrop, a subject with about 260 thin semi-transparent hair
strands, a motion-blurred waving arm, a translucent scarf, green spill and sensor noise. Sizes:
1280×720 and 1920×1080 (48 frames each; 1080 pads to 1152, so both axes carry the 8-token Swin
padding), and 320×200 "tiny" (8 frames, padded to 384×256).

## Per-network export notes

Exporter: `torch.onnx.export(dynamo=True)` (torch 2.9.1, onnxscript 0.7.2), opset 23, then
`to_mha.py`. fp16 is exported from `model.half()`; converting the fp32 graph with
`onnxconverter_common` gave models ORT refused to load.

| network | needs | notes |
|---|---|---|
| C-RADIO | patch (onnx.3 on) | position grid with both crops in the graph (see "Portrait"); pure fp16 fails in its remote code (`expected m1 and m2 to have the same dtype … float != c10::Half`), so the fp16 file is traced under fp16 autocast: fp32 weights (1.72 GB), fp16 compute |
| MoGe | patch | DINOv2 `interpolate_pos_encoding` bakes the trace size into a Python-float scale factor. The patch does the same PyTorch bicubic as in-graph matrices (max diff 9e-5 to 3e-4 on features of 7 to 10) |
| RVM | nothing | one recurrent step per call; the host loops over frames |
| stage 1 | patch v2 | below |
| stage 2 | patch v2, traced at B=2 | below |

Stage 1/2 patches (`onnx_patches.py`):

1. **Shifted windows, mask-free** (v2, above). Upstream's `lru_cache`d region groups use
   `tolist()`/`nonzero()` and fail torch.export (`unhashable type: non-nested SymInt`).
2. **SwinAttention3D window batching** chooses its batch with Python shape arithmetic; replaced
   by a single-shot path.
3. Every SDPA is 4D (the converter rejects 5D: `only 4D query, key, and value are supported`).
4. Symbolic sizes: slicing a dummy off the *end* of a concat (`o[:n]`) fails the shape solver
   when n contains `Max()`; the dummy goes first and is dropped with `o[1:]`.

## Install footprint (measured with `du`)

| | size |
|---|---|
| PyTorch venv + weights/vfms (upstream runtime) | 7.1 GB + 4.8 GB = 11.9 GB |
| Minimal ORT GPU venv: `onnxruntime-gpu[cuda,cudnn]==1.31.0` + numpy | 2.4 GB (CUDA 13 libs 1.2 GB, cuDNN 884 MB, onnxruntime 335 MB) |
| Production fp16 set / fp32 set | 3.30 GB / 4.87 GB |
| TensorRT libs, only if the TRT EP is used | +4.3 GB (`tensorrt-cu13-libs` 10.16) |

The ORT 1.31 GPU wheel targets CUDA 13 and needs a driver that supports it (this machine's 615 does).

## Still open

1. fp16 parity at 1080p with 24/12 windows (no PyTorch fp32 reference fits in 12 GiB; a CPU
   reference at that size projects above the 16 GB host limit).
2. fp32 with 24/12 windows on CUDA (fails the 5.5 GiB stage-1 session cap; the engine's split
   of the VRAM budget across sessions decides this).
3. Whether the `value_info` effect also exists on the CUDA EP (the GPU numbers above already
   use files without it; not measured with it).
4. Per-session arenas: the five sessions don't share GPU memory, so peaks may add up. The engine
   can run them one after another as upstream does.
5. Torch-free host pipeline: resize kernels, asinh/sRGB and Hann blending need their own parity test.
6. Native fp16 C-RADIO (fp32 weights today, 1.72 GB): fp16 weights in the onnx.5 candidate (0.90 GB), not measured.
7. TensorRT: the TensorRT set above (MHA has no TensorRT plugin; the set uses plain attention). Some maxima
   under TensorRT are above CUDA fp16's (MoGe 0.086 vs 0.047, C-RADIO 0.146 vs 0.092); the means are below.
8. A side of 128 px: stage 1's reflect/replicate branch (`blocks.py`) is fixed to reflect by the export, so the
   ONNX stage 1 fails where PyTorch switches to replicate (see "Portrait"). The engine refuses such clips.

## How to rebuild / re-check

```
engine-rs/export/build_models.sh               # export + to_mha + speed_patches + manifest into models-<version>/ (CPU)
engine-rs/export/run.sh 16G speed_patches.py IN.onnx OUT.onnx  # only the speed rewrites (stage 1 / stage 2)
engine-rs/export/run.sh 14G test_speed_patches.py ORIG_DIR NEW_DIR   # their parity (CPU)
engine-rs/export/rebuild_mha.sh                # only to_mha + manifest on existing exports
engine-rs/export/run.sh 16G cradio_parity.py --onnx A.onnx [B.onnx] --shapes 1280x768,768x1280   # C-RADIO vs upstream PyTorch (CPU)
engine-rs/export/run.sh 16G small_side.py MODELS_DIR 128x384 384x128   # which networks take a 128 px side (PyTorch and ONNX)
engine-rs/export/run.sh 16G parity_patch.py 256x384x2 384x640x2 512x896x2 768x1280x2
engine-rs/export/run.sh 16G run_parity.py ort CLIP OUT.npz --onnx-set prod_fp32 --frames 8 --chunk 4 --stride 2
engine-rs/export/run.sh 8G  run_parity.py cmp REF.npz OUT.npz [GT_ALPHA_DIR]
engine-rs/export/run.sh 16G ort_mem.py stage1 768 1280 4 prod_fp32         # memory probe
engine-rs/export/gpu_validate_when_idle.sh     # guarded GPU validation (waits for a quiet GPU)
engine-rs/export/build_trt_models.sh PROD OUT   # TensorRT set (CPU)
engine-rs/export/coreml/build_coreml_models.sh PROD OUT 1152x1280 cradio:4 moge:4 rvm:1 stage1:4 stage1:8 stage2:1   # Core ML set (CPU; also 1152x1920)
engine-rs/export/run.sh 14G trt_netparity.py test REF.npz --models OUT --prec tensorrt-fp16 --ep ctx --cache DIR  # GPU, CK_TRT_BUILD=ck-trt-build
```

`run.sh` goes through `~/.cache/claude-scratch/tools/memrun.sh`, which stops a run itself at 90%
of its limit. `gpu_guard.py` refuses to start, or stops within 2 s, if Sonata runs or another
process holds > 1 GiB VRAM. It also stops the run if the process reaches 12 GiB of VRAM (exit 76).
ORT `gpu_mem_limit` is split per session (sum 11 GiB).
