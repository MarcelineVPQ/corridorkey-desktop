# AMD graphics cards (MIGraphX)

**Untested on real hardware: nothing here has run on an AMD card.** Since 1.0.0-dev.4 the app sets an AMD card up on
Linux **by default**, and says it is untested (backlog row 166; Marcy 2026-10-29: "untested is fine as long as we
declare that and we are working towards testing it ourself"). `CK_AMD=0` in the app's environment turns it off.

The declaration, word for word, in the setup's step 1 and the Engine page (the Graphics card block, Runtime and
models, TensorRT) whenever an AMD card is set up (`src/shared/texts.ts` `AMD_UNTESTED`, with a link to the issues):

> AMD support is new and not yet tested on a real AMD card: we're testing it ourselves next. If it doesn't work on
> your card, please tell us on [GitHub issues](https://github.com/MarcelineVPQ/corridorkey-desktop/issues).

The README, CHANGELOG and the wiki (Home, Installing on Linux, Troubleshooting) say the same. It comes out when the
real-card test passes (backlog row 184).

Status 2026-10-28: the engine has a MIGraphX provider (`--device migraphx`); the app's setup detects an AMD card,
downloads ONNX Runtime with AMD's ROCm 10.1 and MIGraphX libraries, and adds a models.json `migraphx-fp16` entry to
set 2.0.0-onnx.5 (below). Measured offline only, on a Linux PC with AMD's own MIGraphX library.

## On by default; `CK_AMD=0` turns it off

On Linux, with no NVIDIA driver loaded (NVIDIA comes first when a machine has both, as the engine's `auto` does), the
app looks for an AMD card. NVIDIA, Windows and macOS setups never read the AMD side, and a Linux PC where no AMD card
is found (no KFD driver, no GPU node) gets the "No NVIDIA graphics driver is loaded" message as before.

`CK_AMD=0` in the app's environment (`CK_AMD=0 ./CorridorKey-Desktop-*.AppImage`) turns the AMD path off: the app
reads nothing of the AMD side and an AMD card gets the "No NVIDIA graphics driver is loaded" message, as before
1.0.0-dev.4. Any other value, or none, leaves it on. A runtime already installed stays on disk (see the engine's
message below).

With an AMD card found:

- **Detection** (electron/main/amd.ts, install.ts `amdCardFor` / `systemSupport`): the first GPU node of the KFD
  topology (`/sys/class/kfd/kfd/topology/nodes/*/properties`: SIMDs and a `gfx_target_version`, as the engine's amd.rs
  reads them) whose gfx target ROCm 10.1's MIGraphX supports (a Ryzen iGPU listed before a Radeon card is skipped), and
  whether `/dev/kfd` and its `/dev/dri/renderD<minor>` open read-write. The setup says why not when no
  card's gfx target is one ROCm 10.1's MIGraphX supports, or when the user isn't in the `render` /
  `video` groups, and shows the declaration above. Only the chosen card's device wheel is downloaded. Limit: the engine runs on HIP's device 0 (amd.rs
  matches it by PCI bus id), which the app can't ask for without HIP; on a machine with several AMD GPUs (an iGPU
  turned on next to a Radeon card) HIP's device 0 may be the other one. Then set `HIP_VISIBLE_DEVICES` (ROCm's own
  variable for the cards HIP sees) to the supported card's HIP device index in the app's environment (its position
  among the GPU agents `rocminfo` lists, counting from 0), or turn the iGPU off in the firmware.
- **Runtime download** (install.ts `RUNTIME_AMD`, `ROCM_DEVICE`): the wheels below into
  `runtime/ort-1.31.0-rocm10.1-<gfx>`, in pip's layout (the libraries find each other through `$ORIGIN` RPATHs, and the
  engine finds the plugin next to ONNX Runtime's package): no `LD_LIBRARY_PATH`, nothing system-wide, no engine
  setting (the engine's `auto` picks MIGraphX when the plugin offers a GPU and there is no CUDA). The Engine page lists
  it as "(graphics card)".
- **Models**: set 2.0.0-onnx.5 only (MIGraphX can't load onnx.4's stage 1 and 2), plus MIGraphX's files in the set's
  own `migraphx` folder and the `migraphx-fp16` entry in its models.json (below).
- **Wording**: the TensorRT setting says TensorRT is NVIDIA's and MIGraphX runs instead; the GPU readout reads the
  amdgpu driver's sysfs files (`mem_info_vram_total` / `_used`, `gpu_busy_percent`, and from its hwmon folder
  `temp1_input`, `pwm1` / `pwm1_max`, `freq1_input`, `power1_average` or `power1_input`, each left out where missing;
  backlog row 171; no per-program list yet); a job's
  load step reads "Preparing for this graphics card (MIGraphX compiles each network the first time at each size)".

Supported gfx targets (AMD's ONNX Runtime page for MIGraphX; each has a pinned device wheel): gfx1100, gfx1101,
gfx1102 (Radeon RX 7000), gfx1200, gfx1201 (RX 9000, Radeon AI PRO R9700), gfx1150-gfx1153 (Ryzen AI graphics),
gfx90a, gfx942, gfx950 (Instinct MI200, MI300, MI350).

## The runtime (ROCm 10.1)

The app downloads it from AMD's own repository and PyPI (sizes and SHA-256 checked 2026-10-28 by downloading each wheel
twice; install.ts pins them):

| Wheel | Size (bytes) | From |
|---|---|---|
| `onnxruntime` 1.31.0 (plain: the provider is a plugin) | 23,760,984 | pypi.org |
| `onnxruntime-ep-migraphx` 1.0.0+rocm10.1.0: the MIGraphX provider **plugin** (`libmigraphx-ep.so`) | 1,808,763 | `https://stable.repo.amd.com/rocm/onnxruntime/whl-next/` |
| `migraphx-libs` 2.18.0+rocm10.1.0 | 82,963,723 | `https://stable.repo.amd.com/rocm/migraphx/whl-next/` |
| `rocm-sdk-core` 10.1.0 (HIP, ROCr, comgr, LLVM) | 419,364,838 | `https://stable.repo.amd.com/rocm/core/whl-next/` |
| `rocm-sdk-libraries` 10.1.0 (MIOpen, rocBLAS, hipBLASLt, rocRoller) | 260,814,462 | same |
| `rocm-sdk-device-<gfx>` 10.1.0: one, the card's kernels | 155,150,763 (gfx1152) to 1,832,820,487 (gfx942); gfx1100 233,374,792 | same |

Download: 1.02 GB for an RX 7900 (gfx1100), 1.13 GB for gfx1201 (the CUDA set is 1.55 GB). Kept after unpacking:
2.36 GB for gfx1100 (measured with the app's own `keepFromWheel` on the real wheels): what loading the plugin needs
(its ELF dependencies, all resolved inside the kept files: `ldd` on every kept library, 2026-10-28), LLVM's device
bitcode and clang headers (HIP's runtime compiler), the card's MIGraphX kernels and the whole device wheel; not the
debugger, profilers, Python bindings, compiler programs or the ROCm libraries MIGraphX doesn't link. A first cut: a
file a real card turns out to need (one opened only at run time) is the first thing the card test checks.

Licences: the ROCm wheels carry no licence files (the core wheel keeps a few under `share/doc`, kept), so
THIRD_PARTY_NOTICES.md carries the texts (licenses/rocm/: AMD's projects, LLVM, and the system libraries ROCm builds
in at the versions TheRock's therock-10.1 tag pins: elfutils 0.195 libelf LGPL-3.0-or-later, numactl 2.0.19 LGPL-2.1,
libdrm 2.4.134, bzip2 1.0.8, xz 5.8.1, SQLite 3.51.3, zlib 1.3.2, zstd 1.5.7).

Since ROCm 10 AMD ships the MIGraphX provider as an ONNX Runtime plugin instead of a whole ONNX Runtime build. The
older route, the `onnxruntime-migraphx` wheel (PyPI 1.27.1, AMD's repo 1.23.2), is a full ONNX Runtime 1.27 built
against ROCm 7.2.4: the engine (ONNX Runtime API 31) can't load it.

ROCm 10.1's compatibility matrix lists the MI300X (gfx942), the Radeon RX 7900 XTX (gfx1100) and the Radeon AI PRO
R9700 (gfx1201), Ubuntu 24.04. Unconfirmed: whether a stock distro kernel's amdgpu driver is enough for pip ROCm 10.1
or `amdgpu-dkms` is needed (the card test checks).

## The models (`migraphx-fp16`)

MIGraphX 2.18 parses set 2.0.0-onnx.5's own C-RADIO, RVM and stage 1 files, and refuses its MoGe (antialiased resize)
and stage 2 (MultiHeadAttention's `attention_bias` broadcast over the heads); their TensorRT-form files from release
`models-2.0.0-onnx.5-trt` parse. The app downloads those two (`ck2-moge-trt-fp16.onnx(.data)`,
`ck2-stage2-trt-fp16.onnx(.data)`, 0.61 GB, install.ts `MIGRAPHX`) into the set's `migraphx` folder and merges
`migraphx-fp16` into its models.json (`MIGRAPHX_KEY`): cradio, rvm, stage1 the set's own files, moge and stage2
`migraphx/…`. No new model release: every file is already published. That exact mix parses at 384×256, 1280×1152,
1920×1152 and 3840×2176, 4 frames (`tools/migraphx_ops.py --set migraphx-fp16`, 2026-10-28).

## The engine

- `--device migraphx` (Linux only) or `auto`: `auto` picks MIGraphX only when the MIGraphX plugin is registered and
  offers a GPU and no NVIDIA card has CUDA; a CUDA setup has no plugin, so it is unchanged.
- The plugin: `CK_ENGINE_MIGRAPHX_EP=/path/libmigraphx-ep.so`, else `onnxruntime_ep_migraphx/libmigraphx-ep.so`
  found where pip puts it next to `onnxruntime/capi/libonnxruntime.so` (runtime.rs `migraphx_lib`). Registered with
  ONNX Runtime's plugin API (`RegisterExecutionProviderLibrary`), sessions made on its first GPU device.
- Compiled programs: MIGraphX compiles per input shape (minutes for a large network), cached in
  `CK_ENGINE_MIGRAPHX_CACHE` (default `migraphx` next to the TensorRT cache root: the app's `<cache>/migraphx`), one folder per ONNX Runtime
  version, gfx target and network file (size + time: MIGraphX's own cache key follows the graph's structure, not its
  weights). Plugin option `cache_dir`.
- Memory (automatic window, `estimate`): the amdgpu driver's `mem_info_vram_total` / `mem_info_vram_used` (what
  amd-smi and rocm-smi read) for HIP's device 0 (matched by PCI bus id from `hipDeviceGetPCIBusId`; one card without
  HIP; several and no HIP: no reading rather than the wrong card's), and what the engine holds from its own DRM fdinfo
  (`drm-resident-vram`). No arena limit: the plugin has none; the budget still sizes the window (amd.rs).
- Precision: the sets are fp16 where they should be; no MIGraphX quantisation is asked for.
- Models: models.json's `migraphx-fp16` entry when the folder has one (else the plain files, and the job log says
  MIGraphX refuses them). For set 2.0.0-onnx.5 the app's AMD setup writes it (above); `engine-rs/export/migraphx_patch.py`
  is for onnx.4's files only.
- Errors name the AMD side ("no AMD graphics card ROCm can use", or what became of the plugin), never "NVIDIA" alone:
  with no provider at all on Linux and the MIGraphX plugin's file in place (the AMD runtime) the message names both
  ("CorridorKey needs an NVIDIA graphics card with CUDA, or an AMD graphics card with ROCm and AMD's MIGraphX plugin");
  without the plugin's file (every setup that never installed the AMD runtime) it is the message from before; a
  setup that installed it and then turned AMD off (`CK_AMD=0`) still has the file, so its message names AMD too.

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

- A run on a real AMD card (backlog row 184, dev.5; a rented Linux server with a Radeon AI PRO R9700, gfx1201, is the closest to a user's
  card; nothing is booked yet): the machine's driver, `/dev/kfd` and render-group access and KFD gfx targets first;
  then the app's own install (AMD detected, the AMD runtime and models downloaded and checked), the plugin loading into
  ONNX Runtime 1.31 (built for 1.29: `onnxruntime~=1.29.0` in its metadata; it negotiates the API version), the
  kept-file list, every MIGraphX compile (shape and seconds) and its cache on a second run, the engine's graphics
  memory against `amd-smi`, and one clip's matte against CUDA's (MAE and the share of pixels off by more than 1/255,
  as the Core ML gate measures).
- The plugin's option names (`cache_dir`) are read from its binary.
- The GPU readout lists no other programs on an AMD card yet (the driver keeps it per process in /proc/<pid>/fdinfo).
- Storage doesn't list MIGraphX's compiled-program cache (`<cache>/migraphx`) yet.
- The cloud test kit (`tools/amd_cloud_test.sh`) and the CUDA reference matte are still to be written.
- Windows AMD: no pip MIGraphX for Windows (`migraphx-libs` and `onnxruntime-ep-migraphx` are manylinux only);
  Windows ML's MIGraphX provider (Windows 11 24H2+, RDNA 3 or later) is the likely route, but it bundles ONNX Runtime
  1.28 while the engine is built on 1.31's API, so whether its plugin registers into the engine's ONNX Runtime is
  unconfirmed until it runs on a Windows RDNA 3 machine.

Sources: ROCm 10.1 compatibility matrix (rocm.docs.amd.com/en/docs-10.1.0/compatibility/compatibility-matrix.html),
AMD's ONNX Runtime install page (rocm.docs.amd.com/projects/ai-ecosystem/en/latest/inference/onnxruntime.html), the
wheels' metadata and ELF headers (read 2026-10-27), ONNX Runtime v1.27.1 `onnxruntime/core/providers/migraphx/`,
AMDMIGraphX `rocm-10.1` `src/onnx/` and `src/api/include/migraphx/migraphx.h`.
