# AMD graphics cards (MIGraphX)

**Untested on real hardware: nothing here has run on an AMD card.** The app doesn't download an AMD runtime, so the app
itself still needs an NVIDIA card on Linux and Windows.

Status 2026-10-27: the engine has a MIGraphX provider (`--device migraphx`); with set 2.0.0-onnx.4 **stage 1 and stage
2 don't parse in MIGraphX** (below). Set 2.0.0-onnx.5 (the app's set on Linux and Windows from 1.0.0-dev.2) changed
their export: its TensorRT-form files parse for all five networks at 384×256, 1280×1152, 1920×1152 and 3840×2176
(docs/ONNX_EXPORT.md "onnx.5"); no models.json `migraphx-fp16` entry points at them yet. Measured offline on the
Linux PC with AMD's own MIGraphX library.

## The runtime (ROCm 10.1)

| What | Version | Where |
|---|---|---|
| ROCm on the machine | 10.1.0 (AMD Developer Cloud image "ROCm 10.1 on Ubuntu 24.04"); HIP 7.16, still `libamdhip64.so.7` | system (`/opt/rocm`) |
| ONNX Runtime | 1.31 (the app's pin; AMD's matrix lists 1.29, see "Open") | PyPI `onnxruntime` |
| MIGraphX provider | `onnxruntime-ep-migraphx` 1.0.0+rocm10.1.0: a **plugin** library (`libmigraphx-ep.so`, 1.8 MB) that ONNX Runtime loads at run time | `https://stable.repo.amd.com/rocm/onnxruntime/whl-next/` |
| MIGraphX | `migraphx-libs` 2.18.0+rocm10.1.0 (83 MB; kernels for gfx90a, gfx942, gfx950, gfx1100-1103, gfx1150-1153, gfx1200/1201) | `https://stable.repo.amd.com/rocm/migraphx/whl-next/` |

Since ROCm 10 AMD ships the MIGraphX provider as an ONNX Runtime plugin instead of a whole ONNX Runtime build. The
older route, the `onnxruntime-migraphx` wheel (PyPI 1.27.1, AMD's repo 1.23.2), is a full ONNX Runtime 1.27 built
against ROCm 7.2.4: the engine (ONNX Runtime API 31) can't load it, and it isn't the AMD cloud image's ROCm.

ROCm 10.1's compatibility matrix lists the MI300X (gfx942), the Radeon RX 7900 XTX (gfx1100) and the Radeon AI PRO
R9700 (gfx1201), Ubuntu 24.04. The plugin's library looks for MIGraphX next to itself (pip's `migraphx_libs`) and for
HIP/ROCm in pip's ROCm packages or `/opt/rocm/lib`: on the cloud image system ROCm is enough, nothing ROCm ships with
the app.

## The engine

- `--device migraphx` (Linux only) or `auto`: `auto` picks MIGraphX only when the MIGraphX plugin is registered and
  offers a GPU and no NVIDIA card has CUDA; a CUDA setup has no plugin, so it is unchanged.
- The plugin: `CK_ENGINE_MIGRAPHX_EP=/path/libmigraphx-ep.so`, else `onnxruntime_ep_migraphx/libmigraphx-ep.so`
  found where pip puts it next to `onnxruntime/capi/libonnxruntime.so` (runtime.rs `migraphx_lib`). Registered with
  ONNX Runtime's plugin API (`RegisterExecutionProviderLibrary`), sessions made on its first GPU device.
- Compiled programs: MIGraphX compiles per input shape (minutes for a large network), cached in
  `CK_ENGINE_MIGRAPHX_CACHE` (default `migraphx` next to the TensorRT cache root), one folder per ONNX Runtime
  version, gfx target and network file (size + time: MIGraphX's own cache key follows the graph's structure, not its
  weights). Plugin option `cache_dir`.
- Memory (automatic window, `estimate`): the amdgpu driver's `mem_info_vram_total` / `mem_info_vram_used` (what
  amd-smi and rocm-smi read) for HIP's device 0 (matched by PCI bus id from `hipDeviceGetPCIBusId`; one card without
  HIP; several and no HIP: no reading rather than the wrong card's), and what the engine holds from its own DRM fdinfo
  (`drm-resident-vram`). No arena limit: the plugin has none; the budget still sizes the window (amd.rs).
- Precision: the sets are fp16 where they should be; no MIGraphX quantisation is asked for.
- Models: models.json's `migraphx-fp16` entry when the folder has one (else the plain files, and the job log says
  MIGraphX refuses them). `engine-rs/export/migraphx_patch.py` makes it from the TensorRT-ready exports.
- Errors name the AMD side ("no AMD graphics card ROCm can use", or what became of the plugin), never "NVIDIA".

## What MIGraphX takes (offline check)

`tools/migraphx_ops.py MODELS --migraphx-libs <pip's migraphx_libs> --set <entry>` loads MIGraphX 2.18's own C
library (its ONNX parser and reference target need no GPU), lists the ops its parser doesn't know and parses each
network at the engine's shapes (1280x1152, 4 frames); `--ref` also runs MIGraphX's reference (CPU) target against
ONNX Runtime's CPU provider. Set 2.0.0-onnx.4:

| Network | `fp16` | `tensorrt-fp16` | `migraphx-fp16` (patched) | reference target vs ORT CPU (256x256) |
|---|---|---|---|---|
| C-RADIO | parses | parses | parses | max 0.011, mean 0.0013 (mean value 0.75) |
| MoGe | **refused**: Resize `exclude_outside=1` (its antialiased resize) | parses (resize as matrices) | parses | max 0.27, mean 0.012 (mean value 0.90): to measure on the card |
| RVM | parses (bicubic resize included) | parses | parses | max 0.006, mean 0.0009 |
| stage 1 | **refused**: RMSNormalization unknown | same | **refused**: zero-size tensors | — |
| stage 2 | **refused**: RMSNormalization unknown | same | **refused**: zero-size tensors | — |

RMSNormalization (111 nodes in stage 1, 50 in stage 2) is fixed by `migraphx_patch.py` (SimplifiedLayerNormalization,
float32 inside; ORT CPU: stage 2 bit-identical, stage 1 within one fp16 step). The blocker after it: the shifted-window
attention (CorridorKey2.0 `corridorkey/blocks.py` `_sdpa_with_region_ids`) splits windows into full ones and edge
groups; the export keeps that split with symbolic counts (`sym_max(n - 1, 0)` windows), and at every tried size
(256x256 to 3840x2176) some group is empty. ONNX Runtime runs the empty tensors; MIGraphX's Reshape reads a 0 in a
target shape as "copy this dimension" (its parser ignores `allowzero`), so the first empty group's Reshape fails
("reshape has 983040 elements whereas the input has 0", stage 2 node `view_97` at 1280x1152). The same graphs also
use 0 as "copy" in 192 (stage 1) / 120 (stage 2) constant shapes, so setting `allowzero` can't fix it. The fix
belongs in the export: shifted windows as one masked SDPA over all windows (the standard Swin form: no groups, no
empty tensors), parity-checked against the current set.

The earlier ONNX Runtime 1.27 MIGraphX provider (in-tree, ROCm 7.2) has a fixed op list and gives up on a whole
network with more than 10 unsupported nodes: stage 1 and stage 2 would have run entirely on the CPU there.

## Open

- Stage 1 / stage 2 MIGraphX-friendly export: done in set 2.0.0-onnx.5 (backlog row 165; parsing checked offline only). Still open: a models.json `migraphx-fp16` entry for its TensorRT-form files, and a run on a real AMD card (a paid test needs Marcy's go).
- ONNX Runtime 1.31 with the plugin built for 1.29 (`onnxruntime~=1.29.0` in its metadata; it negotiates the API
  version, "requires ORT API >= …"): expected to load, unproven until a card runs it.
- The plugin's option names (`cache_dir`) are read from its binary; its source isn't public.
- The cloud test kit (`tools/amd_cloud_test.sh`) and the CUDA reference mattes are still to be written.

Sources: ROCm 10.1 compatibility matrix (rocm.docs.amd.com/en/docs-10.1.0/compatibility/compatibility-matrix.html),
AMD's ONNX Runtime install page (rocm.docs.amd.com/projects/ai-ecosystem/en/latest/inference/onnxruntime.html), the
wheels' metadata and ELF headers (read 2026-10-27), ONNX Runtime v1.27.1 `onnxruntime/core/providers/migraphx/`,
AMDMIGraphX `rocm-10.1` `src/onnx/` and `src/api/include/migraphx/migraphx.h`.
