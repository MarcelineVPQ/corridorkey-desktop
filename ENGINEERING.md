# CorridorKey Desktop: engineering notes

Everything behind the [README](README.md): the speed and quality measurements with their test machines and methods, the speed journey release by release, what we got wrong, how it is tested and how it is built.

## What it is

A free desktop app for [CorridorKey 2.0](https://github.com/nikopueringer/CorridorKey2.0),
Corridor Digital's AI green-screen keyer (model by Zachary Harris). Drop clips in, pick a hint
mode and outputs, and watch real progress: frames written, the temporal window the runtime
chose from your free graphics memory, and stills of the results.

Status: 1.0 is almost ready. The development builds (1.0.0-dev.N, on the Development update channel) key on Linux and
Windows with an NVIDIA graphics card, and on Apple Silicon Macs through Core ML: from 1.0.0-dev.2 for 1280×1080 and
1920×1080 clips, and from 1.0.0-dev.3 at 4K too (macOS, honestly, below). From 1.0.0-dev.4 AMD cards on Linux too: new,
and not yet tested on a real AMD card (Requirements).

## Highlights

- **Faster on the card you have.** On an RTX 5080: 4K about 1.8-1.9× the original's speed, HD 1.5-1.9×; on Linux the
   optional TensorRT mode about 2.3-2.4× at 4K and 1.9-2.2× at HD (Speed).
- **The same mattes.** Measured against the original on every test clip; dev.2's model set onnx.5 stays within
   0.25-0.50/255 of onnx.4 on all ten, with no more hair sizzle (Quality; Speed, 0.0.9-dev).
- **Installs itself, no Python.** One file to download; the app fetches the rest (4.03 GB on Linux, 3.81 GB on
   Windows, 5.74 GB on macOS), every file SHA-256 checked, less than half the original's install (Install size).
- **One engine, every platform.** Rust on ONNX Runtime: NVIDIA (CUDA) on Linux and Windows, TensorRT on Linux, Core ML
   on Apple Silicon (1280×1080, 1920×1080 and, from dev.3, 4K clips), and from dev.4 AMD cards on Linux through
   MIGraphX (new, not yet tested on a real AMD card).
- **A real Mac app.** From 1.0.0-dev.3, 4K keys on a base 16 GB M6 Mac mini with its mattes within 1/255 of an RTX
  5080's on every pixel; the disk image and the app are signed and notarized by Apple, and every release is keyed
  through the installed app on that Mac before it ships (macOS, honestly).
- **Budget cards welcome.** The memory planner picks the largest temporal window your card holds; measured down to an
   8 GB RTX 2070 SUPER on a 2011 Core i7 (Requirements; Speed, test machines).
- **Studio outputs.** EXR named the studio way with the matte in alpha, lossless 10-bit H.264 or DNxHR 444, and 10-
   and 12-bit plates read in full (Quality).
- **Colour management.** OpenColorIO 2.5 built in: ACES, the camera log spaces, or your studio's own config.
- **A Console, not a shell.** Its own command set with Tab completion, history, pipes into its own filters, `watch`
   and scripts; anything that replaces files asks first, `sudo`-style ([wiki: Console](https://github.com/MarcelineVPQ/corridorkey-desktop/wiki/Console)).
- **Farm-ready.** The `corridorkey` command line, job export for Deadline, OpenCue, Flamenco and OpenJD, and Console
   scripts from cron ([wiki: Render farm](https://github.com/MarcelineVPQ/corridorkey-desktop/wiki/Render-Farm)).
- **Free, open, measured.** Signed updates (self-updating on Linux; from dev.4 Windows and macOS say when a new version
  is out), every speed and quality claim measured with its method, including what we got wrong (Quality, "What we got
  wrong").

## Why this exists

On 21 October 2026 Corridor Crew released [CorridorKey 2.0](https://github.com/nikopueringer/CorridorKey2.0)
([the launch video](https://www.youtube.com/watch?v=svrdRAoIlxM)). I watched the whole video and purchased CK2.0
straight away from [corridorkey.com](https://corridorkey.com) (their app and plugins for Resolve, Nuke, After Effects,
Premiere and Blender), and only after paying did I see that Linux isn't supported yet. In the same video, Niko says
it's "still pretty heavy on the GPU right now": about one frame a second at full native 4K, on an RTX 5090. I'd just found a fun new project to tackle.

I'm an audio/video engineer. Timing, throughput, color and what a signal costs are my day job, and so is software.
This was the perfect crossroads between the two. I've moved PyTorch projects to Rust and ONNX Runtime before, so I
knew there were gains to be found. I took Corridor's model, gave it a new engine (Rust on ONNX Runtime, no Python),
and wrapped it in a desktop app that installs itself.

On my RTX 5080 it keys 4K at about 1.7 frames a second: about 1.8-1.9× faster than the original on the same machine
(1.5-1.9× at HD; a short clip gains less, since loading the models dominates), with the same mattes, less graphics
memory and RAM, and less than half the install (the same-day pair of 2026-10-26 on model set onnx.4, Speed; dev.2's
onnx.5 measured the same speed within run-to-run spread, Speed 0.0.9-dev). Every number is below, with
the clips and the commands to check them yourself. On Linux, an optional TensorRT mode takes that to about 1.9-2.2×
the original's speed at HD and about 2.3-2.4× at 4K. Rust and ONNX Runtime also mean one engine for every platform: NVIDIA on Linux and
Windows, and Apple Silicon through Core ML.

It's free, it stays free, and it's Corridor's model. Huge thanks to Niko, Zachary Harris and the Corridor crew.
Windows testers with a real NVIDIA PC wanted (dev.2 passed in a virtual machine): see Requirements.

Marcy ([MarcelineVPQ](https://github.com/MarcelineVPQ))

## What's coming

Everything planned lives in one list, [docs/BACKLOG.md](docs/BACKLOG.md), each item with its status. In short
(row numbers in brackets):

**The Mac, now at 4K (dev.3).** The Core ML engine keys 1280×1080, 1920×1080 and 4K clips on an M6 Mac mini (CPU +
GPU, 16 GB; mattes within 1/255 of CUDA's, 2026-10-28; 4K at 0.38 fps [60]), the disk image is signed and notarized,
and every release is keyed through the installed app on that Mac. Next: 4K at 1 fps on that mini [177], and self-update
on the Mac [57].

**Next, toward 1.0:**
- Keying on a real Windows PC with an NVIDIA card (only tested in a virtual machine so far)
- Colour management with OpenColorIO / ACES, per clip [29]; EXRs to the studio spec [30]
- A fully offline install for air-gapped studios [31]
- The objective scorecard against CorridorKey 2.0, anyone can rerun it [36], with a release gate: never more hair
  "sizzle" than the original [53]
- The documented DaVinci Resolve round trip [40]

**Agreed, after 1.0:** Nuke reading our outputs as they are, with a script for the
farm command line, never a plugin (Corridor sells theirs) [33]; anamorphic and overscan plates [34]; 8K and studio
Linux (Rocky) [35]; source timecode carried through [38]; a quick preview frame before the full run [39]; garbage and
core mattes [46]; Marion Spates' core-matte and edge-band workflow, with a Nuke template [48]; an edge-sharpness metric
[50]; a watch folder for editors [52]; the Avid round trip, research first [51]; TensorRT built for the windows jobs
pick [61]; Windows code signing [28].

**Experiments, measured first:** a temporal edge stabilizer [47], a hybrid edge mode [49], flicker against the
temporal window [37].

**Agreed, not scheduled yet:** making hints in the app, a mask painter [4].

**Ideas, not decided:** review tools (A/B wipe, alpha view, loupe) [7], keying a frame
range [9], a hint on any frame [11].

Plus about 35 small engineering items from the October code passes and the independent senior review (rows 62-94):
none of them changes what a user sees today.

## Requirements

- Linux (the AppImage) or Windows 10/11 (the installer), x64, with an NVIDIA graphics card (RTX 20-series or newer, 8 GB or more; measured on an RTX 2070 SUPER 8 GB and an RTX 5080
  16 GB: the speed and quality numbers are the RTX 5080's (Speed), and the RTX 2070 SUPER measured the temporal windows
  that fit an 8 GB card under a graphics-memory limit, docs/ENGINE_RUST.md "Where memory is tight"; both machines in
  Speed).
  **On Windows the NVIDIA card is required, and on Linux an NVIDIA or a supported AMD card**: the engine keys on CUDA
  (and on Linux AMD's MIGraphX). Intel graphics cards aren't supported, and without one nothing falls back to the CPU: a job stops with "CorridorKey needs an NVIDIA
  graphics card with CUDA." (on Linux with the AMD runtime installed, the message also names AMD's MIGraphX). AMD cards on Linux (ROCm 10.1 and AMD's
  MIGraphX, which the setup downloads) are on from 1.0.0-dev.4, when no NVIDIA driver is loaded. **AMD support is new
  and not yet tested on a real AMD card: we're testing it ourselves next. If it doesn't work on your card, please tell
  us on [GitHub issues](https://github.com/MarcelineVPQ/corridorkey-desktop/issues).** `CK_AMD=0` turns it off: docs/AMD.md.
- macOS 14 or newer on Apple Silicon (M1 or newer; the disk image, from 1.0.0-dev.2; 1280×1080 and 1920×1080 clips, and
  4K from 1.0.0-dev.3; 16 GB keys 4K, tight). Intel
  Macs aren't supported.
- Nothing else to set up: the engine comes with the app, and on first start the setup downloads the GPU runtime and
  the CorridorKey models (a 4.03 GB download on Linux, 3.81 GB on Windows, 5.74 GB on macOS, once). If `ffmpeg` is
  missing, it offers to install it (apt or pacman on Linux, `winget` on Windows, Homebrew on macOS).
- Optional, Linux: **TensorRT** (Engine settings, TensorRT; off by default) for about 1.9-2.2× the original's speed at
  HD and about 2.3-2.4× at 4K, with the same mattes (Speed, the same-day pair of 2026-10-26, on onnx.4; dev.2's
  TensorRT jobs use onnx.4's TensorRT set). Switching it on offers its own download: NVIDIA's TensorRT 10.16
  libraries (3.7 GB, from pypi.nvidia.com) and the TensorRT models (3.5 GB, from this repository's releases; C-RADIO's
  1.7 GB of weights are copied from the 2.0.0-onnx.4 models when they are still installed), 7.3 GB in all (5.5 GB
  with onnx.4's models), 6.1 GB on disk. Each
  resolution range is optimized once (about 4.4-4.8 minutes for the five networks on an RTX 5080: 4.4 at 1280×1080,
  4.8 at 4K even with TensorRT's timing cache warm; Speed, "0.0.8-dev: TensorRT on onnx.4"): the app builds 4K and HD in the background when TensorRT is
  switched on, with a progress bar in Engine settings, and pauses while you key. Engine settings, TensorRT lists the
  common sizes (720p to 6K) by range: tick a size to build it, untick to remove it, or enter a size of your own; a
  waiting clip offers "Build for this clip's size". Jobs never wait on a build: a clip
  whose range isn't built yet runs on CUDA, and its page says so. 4K (DCI 4K and UHD, up to 2176×4096) runs on TensorRT too, at
  the 8/4 window on 16 GB cards; open gate and larger frames stay on CUDA (Speed, 0.0.7-dev). Best on 16 GB cards: where a network can't be built (stage 1 at 80-frame windows), that network runs on CUDA and
  the job's log says so. Windows needs its own TensorRT builder (a later version); macOS has no TensorRT.

**Windows, first start:** the installer isn't code-signed yet, so Windows SmartScreen shows "Windows protected
your PC" the first time. Click **More info**, then **Run anyway**. It's asked once; signing comes later.

**Windows, honestly:** the Windows build is tested in a Windows 11 virtual machine: it installs, opens, runs its setup
(the downloads, ffmpeg through winget) and works through its pages. That machine has no NVIDIA graphics card, so
**keying on an NVIDIA card under Windows has not been tested yet**: we don't have a real Windows PC with one. Every
speed and quality number in these notes was measured on Linux. If you try it on Windows, please tell us how it goes.

**macOS, honestly:** a great many VFX artists work on Macs, and **1.0.0-dev.2 is the first Mac build**: the app
(signed with a Developer ID, notarized by Apple) with its Core ML engine, keying 1280×1080 and 1920×1080 clips on
Apple Silicon (measured on an M6 Mac mini, below); 1.0.0-dev.3 adds 4K. Other frame sizes aren't there yet.
There's no NVIDIA card on a Mac, so the Mac engine uses ONNX Runtime's Core ML backend (Apple's GPU and Neural Engine)
instead of CUDA. Where that stands:

- **Core ML models in setup** (backlog row 59): Core ML compiles for fixed sizes, so the Mac needs its own model set.
  It's published (release `models-2.0.0-onnx.5-coreml`, and with 4K `models-2.0.0-onnx.5-coreml.1` from dev.3) and the
  setup downloads it on a Mac; a Mac with dev.2's set downloads only the 4K files.
- **The app asks for Core ML** (row 58): in dev.2, checked on the M6 Mac mini before release.
- **1280×1080, 1920×1080 and 4K clips** (row 60): Core ML compiles for fixed frame sizes, so the set has files for
  1280×1080 clips (padded to 1152×1280), standard 1920×1080 HD (padded to 1152×1920) and, from dev.3, 4096×2160
  (padded to 2176×4096). dev.2's set,
  `onnx.5-coreml`, on the Mac mini M6 16 GB (2026-10-28, CPU + GPU, window 4/2): 1280×1080, 120 frames, 111.0 s,
  2.84 fps steady, peak 2.64 GB; 1920×1080, 12 frames, 2.02 fps steady, peak 3.78 GB. Mattes against CUDA: alpha MAE
  2.1-2.5e-5, 0.002 % of pixels over 1/255 at 1280×1080 and none at 1920×1080. The figures and the earlier onnx.4
  set's: Speed, "Apple Silicon (Core ML)". 4K (dev.3), 12 frames: 0.38 fps steady, peak 9.8 GB (it fits a 16 GB Mac,
  tight: 0.8 GB swapped), mattes within 1/255 of CUDA's on every pixel.
- **Proven on a real Mac** (row 24): GitHub's runners are virtual Macs without the GPU or the Neural Engine, so Mac
  keying is measured on a real Apple Silicon Mac (an M6 Mac mini, `tools/mac_gate.sh`): mattes within fp16 rounding of
  CUDA on the same clips, and the speed. From dev.3 every release is also keyed through the installed app's queue on
  that Mac (`tools/mac_app_gate.sh`: Gatekeeper's verdicts, the setup's download, one clip on Core ML). macOS is in
  1.0 only if those gates pass; otherwise 1.0 is Linux and Windows and the Mac follows in 1.1.
- **No TensorRT** (NVIDIA only), video outputs are lossless H.264 (ProRes 4444 XQ comes with the Mac work), and the Mac
  doesn't update itself yet (row 57): from dev.4 it says when a new version is out, and Download opens its release page
  (row 180).

## Install size

Less than half the disk space of the original CorridorKey 2.0 setup (measured on the same PC, 2026-10-24, in
decimal GB: `du --si`):

| Part | CorridorKey Desktop | Original CorridorKey 2.0 |
| --- | --- | --- |
| App / code | **135 MB** (AppImage, engine inside) | 3 MB (Python scripts) |
| Runtime | **2.4 GB**: ONNX Runtime + CUDA/cuDNN (a 1.6 GB download) | **7.6 GB** Python venv: PyTorch, NVIDIA libraries, Triton, other packages |
| Models | **2.5 GB** (fp16) | **5.1 GB**: CorridorKey weights 2.7 GB + foundation models 2.4 GB |
| **Total** | **5.0 GB** | **12.6 GB** |
| Setup | Download one file; the app fetches the rest itself (4.03 GB on Linux, 3.81 GB on Windows, 5.74 GB on macOS) | Install Python, create a venv, pip install, run a download script |

PyTorch's environment carries NVIDIA libraries the ONNX Runtime engine never uses (NCCL and
cuSPARSELt, for multi-GPU and training), and the fp16 models are a third smaller.

## Speed

The same clips through the original CorridorKey 2.0 and CorridorKey Desktop's engine, on the same machine, back to
back, with the same settings. Measured 2026-10-24 with `tools/engine_bench.mjs`.

**Test machine and software (PC)**

Every PC speed and quality number in these notes was measured on this machine:

| | |
| --- | --- |
| Graphics card | NVIDIA GeForce RTX 5080, 16 GB, driver 615.71.09 |
| Processor, memory | AMD Ryzen 9 9950X3D (16 cores), 60 GB RAM |
| System | Kubuntu 26.04, Linux 7.0.0, KDE Plasma (Wayland) |
| Original CorridorKey 2.0 | PyTorch 2.9.1 (CUDA 12.8, cuDNN 9.10), Python 3.12, its shipping mode: bf16 autocast |
| CorridorKey Desktop | Rust engine on ONNX Runtime 1.31.0 (CUDA 13.4, cuDNN 9.27), fp16, model set `2.0.0-onnx.3`: the engine and GPU runtime the app shipped and downloaded then (since 2026-10-25 it downloads `2.0.0-onnx.4`, and dev.2 `2.0.0-onnx.5`; 0.0.8-dev and 0.0.9-dev below) |

**Second test machine (8 GB card)**

The temporal windows that fit an 8 GB card under a graphics-memory limit (Requirements; docs/ENGINE_RUST.md, "Where
memory is tight") were measured on this one:

| | |
| --- | --- |
| Graphics card | NVIDIA GeForce RTX 2070 SUPER, 8 GB, driver 615.71.09 |
| Processor, memory | Intel Core i7-2600K (4 cores, 8 threads, 3.4 GHz), 16 GB RAM, ASUS P8Z68-V PRO |
| System | Linux Mint 22, Linux 6.8.0 |

**Method**

- One engine process per clip, so every run includes loading the models (what a user waits for).
- The same settings for both: a 12 GB graphics-memory budget, the automatic temporal window (both engines picked the
  same one on every clip), alpha + foreground outputs, no hint.
- Nothing else on the graphics card: the bench refuses to start, and pauses between clips, while another program
  holds more than 1 GiB of it.
- **Total**: engine start to exit (the number that matters). **First frames**: start until the first frames are
  written (model load plus the first temporal window). **Steady**: frames per second after the first window, as the
  engine reports them. **Memory**: peak of the engine's processes (graphics memory from nvidia-smi, RAM from
  `/proc`, sampled every 250 ms), in GiB.

### HD (Hollywood Camera Work plates)

| Clip | Original: total · first frames · steady | CorridorKey Desktop: total · first frames · steady | Faster | Graphics memory (GiB) | RAM (GiB) |
| --- | --- | --- | --- | --- | --- |
| godiva_close 960×720, 349 frames | 61.1 s · 42.9 s · 20.5 fps | **39.6 s** · 28.6 s · 36.2 fps | **1.54×** | 9.37 → 9.15 | 9.45 → 5.38 |
| locked_backdrop 1280×1080, 80 frames | 31.3 s · 20.4 s · 9.2 fps | **19.5 s** · 13.0 s · 18.2 fps | **1.61×** | 11.97 → 8.07 | 9.23 → 5.15 |
| metal_glasses 1280×1080, 139 frames | 42.3 s · 27.2 s · 10.4 fps | **26.7 s** · 17.3 s · 18.1 fps | **1.58×** | 11.97 → 8.07 | 9.92 → 5.47 |
| smoke 1280×1080, 250 frames | 74.7 s · 47.1 s · 9.6 fps | **46.8 s** · 30.6 s · 17.4 fps | **1.60×** | 11.97 → 8.25 | 11.29 → 5.82 |
| walking_sitting 1280×1080, 314 frames | 91.5 s · 59.9 s · 10.1 fps | **56.1 s** · 38.0 s · 17.9 fps | **1.63×** | 11.97 → 8.13 | 11.44 → 5.88 |
| with_motion_blur 1280×1080, 50 frames | 20.8 s · 13.6 s · 8.3 fps | **11.4 s** · 7.4 s · 18.2 fps | **1.82×** | 12.03 → 9.44 | 8.86 → 3.70 |

### 4K (Tears of Steel plates, 4096×2160 scene-linear EXR, 120 frames each)

| Shot | Original: total · first frames · steady | CorridorKey Desktop: total · first frames · steady | Faster | Graphics memory (GiB) | RAM (GiB) |
| --- | --- | --- | --- | --- | --- |
| 04_5h curly hair through glasses | 471.7 s · 207.2 s · 0.48 fps | **172.3 s** · 94.3 s · 1.92 fps | **2.74×** | 11.34 → 9.28 | 20.13 → 12.92 |
| 04_5d dreadlocks, curls, bright lamps | 449.5 s · 199.7 s · 0.52 fps | **171.8 s** · 93.5 s · 1.92 fps | **2.62×** | 11.34 → 9.48 | 20.21 → 12.92 |
| 08_3a wispy hair, green prop on green | 416.6 s · 194.8 s · 0.60 fps | **174.4 s** · 94.0 s · 1.95 fps | **2.39×** | 11.34 → 9.11 | 20.55 → 12.94 |
| 04_2c two actors, grey hair, low light | 413.4 s · 193.8 s · 0.59 fps | **170.4 s** · 93.8 s · 1.92 fps | **2.43×** | 11.34 → 9.36 | 20.32 → 12.96 |

The bigger the frame, the bigger the lead: 1.5-1.8× at HD, 2.4-2.7× at 4K (3.2-4× once running). Both engines
use the low-memory temporal window here (80/40 or 48/24 at HD, 8/4 at 4K), chosen from the same table.

### Repeatability and how we got here

Each engine build on the way is labelled as a dev step:

| Step | Date | What changed |
| --- | --- | --- |
| **0.0.1-dev** | 2026-10-21 | the first Rust engine: a straight port of the original's graphs (models `onnx.1`) |
| **0.0.2-dev** | 2026-10-21 | the speed work: the slow parts of the graphs rewritten exactly, memory pools kept warm (models `onnx.2`) |
| **0.0.3-dev** | 2026-10-24 | as shipped in 1.0 (models `onnx.3`) |
| **0.0.4-dev** | 2026-10-24 | 4K EXR frames decoded four at once, freed memory returned after every job (results below) |
| **0.0.5-dev** | 2026-10-24 | TensorRT re-measured on today's engine (opt-in, not in the app yet; results below) |
| **0.0.6-dev** | 2026-10-24 | TensorRT takes CUDA's window, so its mattes match (results below) |
| **0.0.7-dev** | 2026-10-24 | TensorRT at 4K: DCI 4K and UHD get their own engine range (results below) |
| **0.0.8-dev** | 2026-10-25 | model set `onnx.4`: CorridorKey 2.0's precision policy (dev.1's models; results below, with TensorRT on it and a same-day re-measurement against the original on 2026-10-26) |
| **0.0.9-dev** | 2026-10-28 | model set `onnx.5`: our own stage 1 / stage 2 graphs, C-RADIO's weights stored in fp16, download 3.30 → 2.48 GB; and its Core ML set `onnx.5-coreml` for the Mac (dev.2's models; results below) |
| **0.0.10-dev** | 2026-10-29 | the pipelining pass: decode while the models load, loads behind the first pass, the blend beside the next window, C-RADIO / MoGe once per frame; same output byte for byte on the RTX 5080 at the two windows measured (dev.5; results below) |
| **0.0.11-dev** | 2026-10-29 | the networks' outputs read in place instead of copied out, stage 2 reusing stage 1's converted frames; same output byte for byte on the RTX 5080 at the two windows measured (dev.5; results below) |

The same HD bench, run on different days as the engine improved (totals, seconds; Original = PyTorch):

| Clip | 2026-10-21 Original | **0.0.1-dev** 2026-10-21, first Rust engine (`onnx.1`) | **0.0.2-dev** 2026-10-21, after the speed work (`onnx.2`), two runs | 2026-10-24 Original | **0.0.3-dev** 2026-10-24, CorridorKey Desktop (`onnx.3`, as shipped in 1.0) |
| --- | --- | --- | --- | --- | --- |
| godiva_close | 68.4 | 54.9 | 39.7 / 42.7 | 61.1 | **39.6** |
| locked_backdrop | 40.3 | 36.9 | 20.6 / 21.9 | 31.3 | **19.5** |
| metal_glasses | 44.7 | 55.5 | 30.0 / 29.9 | 42.3 | **26.7** |
| smoke | 76.5 | 96.8 | 51.8 / 51.7 | 74.7 | **46.8** |
| walking_sitting | 94.2 | 116.2 | 63.2 / 63.1 | 91.5 | **56.1** |
| with_motion_blur | 19.0 | 22.7 | 12.4 / 12.3 | 20.8 | **11.4** |

The steps after that, on the same HD bench (totals, seconds, all on 2026-10-24, back to back; the original from the
column above; TensorRT is the optional Linux mode):

| Clip | 2026-10-24 Original | **0.0.3-dev** CUDA (as shipped) | **0.0.4-dev** CUDA | **0.0.5-dev** TensorRT, shorter windows (mattes differ, not shipped) | **0.0.6-dev** TensorRT, CUDA's window (in the app) | 0.0.6-dev vs the original |
| --- | --- | --- | --- | --- | --- | --- |
| godiva_close | 61.1 | 39.6 | 37.3 | 30.9 | **34.6** | 1.77× |
| locked_backdrop | 31.3 | 19.5 | 19.1 | 15.9 | **15.2** | 2.06× |
| metal_glasses | 42.3 | 26.7 | 25.8 | 20.2 | **21.2** | 2.00× |
| smoke | 74.7 | 46.8 | 46.5 | 33.3 | **36.4** | 2.05× |
| walking_sitting | 91.5 | 56.1 | 58.4 | 40.8 | **43.9** | 2.08× |
| with_motion_blur | 20.8 | 11.4 | 11.8 | 9.5 | **11.2** | 1.86× |

And at 4K (Tears of Steel, 120 frames each, totals in seconds; 0.0.4-dev was measured on 04_5h only):

| Shot | 2026-10-24 Original | **0.0.3-dev** CUDA | **0.0.4-dev** CUDA | **0.0.7-dev** CUDA | **0.0.7-dev** TensorRT | 0.0.7-dev TensorRT vs the original |
| --- | --- | --- | --- | --- | --- | --- |
| 04_5h | 471.7 | 172.3 | 162.7 | 151.5 | **113.0** | 4.17× |
| 04_5d | 449.5 | 171.8 | | 147.5 | **112.6** | 3.99× |
| 08_3a | 416.6 | 174.4 | | 147.3 | **112.4** | 3.71× |
| 04_2c | 413.4 | 170.4 | | 148.1 | **111.5** | 3.71× |

The original and 0.0.3-dev wrote video outputs; the 0.0.7-dev runs wrote EXR, so those columns aren't strictly the
same job. Each step's own section below has its details and its mattes.

- The straight port (0.0.1-dev) was *slower* than the original on four of six clips. The speed came from measuring
  where the time went and rewriting those parts of the graphs exactly (same output): window padding, the depatchify
  step, grouped 7×7 convolutions, and keeping memory pools warm between calls (docs/ENGINE_RUST.md, "Speed").
- Two runs of the same build agree within 1 % on four clips, 6 % on locked_backdrop and 8 % on godiva_close. The
  original varied more between days (godiva 68.4 → 61.1 s), so every comparison here is a back-to-back pair on the
  same day.

<details>
<summary>How the speed got here: 0.0.4-dev to 0.0.11-dev, measured release by release</summary>

### 0.0.4-dev: feeding the card faster at 4K

A utilization log (the card sampled every 100 ms) showed the card busy 88 % of an HD job but only 78 % of a 4K one:
in the 4K job's first two phases (RVM and the foundation models) it waited on EXR frames, decoded one at a time at
~80 ms each. 0.0.4-dev decodes four frames at once (one pass over the clip: 9.4 → 4.9 s) and reads a clip's size from
the EXR header instead of decoding a frame. The same 4K shot (04_5h, 120 frames), back to back:

| | 0.0.3-dev | 0.0.4-dev |
| --- | --- | --- |
| Frame decode + preparation (all passes, own thread) | 51.8 s | 27.8 s |
| RVM phase | 11.2 s | 6.0 s |
| Foundation phase | 10.2 s | 7.0 s |
| Keying (stage 1 + stage 2) | 132.1 s | 133.4 s |
| **Total** | **170.1 s** | **162.7 s** (−4 %) |
| Engine RAM, peak | 12.8 GB | 13.6 GB |

Both 4K outputs (alpha and foreground) are bit-identical to 0.0.3-dev's (same MD5 of every decoded frame). The keying
itself is unchanged: from here only faster kernels (TensorRT, next) make 4K faster. HD video clips don't use
this path (ffmpeg decodes them) and are unchanged: walking_sitting 54.5 → 55.2 s, within run-to-run spread.

### 0.0.5-dev: TensorRT on today's engine

The TensorRT path, re-measured on the 0.0.4-dev engine and today's models (`onnx.3`, TensorRT 10.16.1), against
CUDA on the same day, back to back. TensorRT engines already built (each resolution's one-time build took 3.4–3.7
minutes the first time):

| Clip (HD) | CUDA: window · total | TensorRT: window · total | Change | TensorRT graphics memory / RAM |
| --- | --- | --- | --- | --- |
| godiva_close | 80/40 low · 37.3 s | 24/12 · **30.9 s** | −17 % | 7.33 / 3.52 GB |
| locked_backdrop | 48/24 low · 19.1 s | 16/8 · **15.9 s** | −17 % | 7.36 / 4.46 GB |
| metal_glasses | 48/24 low · 25.8 s | 16/8 · **20.2 s** | −22 % | 7.36 / 4.93 GB |
| smoke | 48/24 low · 46.5 s | 16/8 · **33.3 s** | −28 % | 7.36 / 4.96 GB |
| walking_sitting | 48/24 low · 58.4 s | 16/8 · **40.8 s** | −30 % | 7.36 / 4.85 GB |
| with_motion_blur | 80/40 low · 11.8 s | 16/8 · **9.5 s** | −19 % | 7.36 / 3.88 GB |

**Not shipped yet, because of the mattes.** TensorRT's memory limits give it shorter temporal windows (16 or 24
frames, against CUDA's 48 or 80), and the window changes the matte more than precision does. TensorRT against CUDA
(`tools/matte_compare.py`):

| Clip | alpha MAE | % of pixels off by more than 1/255 | alpha PSNR |
| --- | --- | --- | --- |
| godiva_close | 2.06e-2 | 27.0 % | 25.2 dB |
| locked_backdrop | 8.18e-4 | 5.7 % | 48.5 dB |
| metal_glasses | 3.51e-3 | 9.5 % | 34.7 dB |
| smoke | 7.55e-3 | 12.8 % | 28.6 dB |
| walking_sitting | 2.93e-3 | 2.6 % | 28.9 dB |
| with_motion_blur | 3.39e-4 | 2.9 % | 53.4 dB |

The next step lets TensorRT run the same long windows as CUDA, so its mattes match before it reaches the app.

### 0.0.6-dev: TensorRT with the same mattes as CUDA

0.0.5-dev showed the catch: TensorRT's memory limits gave it 16–24-frame windows where CUDA uses 48 or 80, and the
window changes the matte. 0.0.6-dev gives TensorRT exactly CUDA's window and staging (one network on the card at a
time), and builds its engines for that window. Stage 1 for 48-frame windows needs a 6.1 GB working-memory block
while it builds (peak 13.9 GB on the card), so it builds on 16 GB cards; where a network can't be built (stage 1 at
80 frames), that one network runs on CUDA at the same window and the app remembers not to try again.

The six HD clips, totals in seconds, all on 2026-10-24 (the original and CUDA from the runs above):

| Clip (window) | Original | CUDA (0.0.4-dev) | **TensorRT (0.0.6-dev)** | vs the original |
| --- | --- | --- | --- | --- |
| godiva_close (80/40) | 61.1 | 37.3 | **34.6** (stage 1 on CUDA) | 1.77× faster |
| locked_backdrop (48/24) | 31.3 | 19.1 | **15.2** | 2.06× |
| metal_glasses (48/24) | 42.3 | 25.8 | **21.2** | 2.00× |
| smoke (48/24) | 74.7 | 46.5 | **36.4** | 2.05× |
| walking_sitting (48/24) | 91.5 | 58.4 | **43.9** | 2.08× |
| with_motion_blur (80/40) | 20.8 | 11.8 | **11.2** (stage 1 on CUDA) | 1.86× |

Mattes, TensorRT against CUDA at the same window (`tools/matte_compare.py`): every clip within fp16 rounding, the
same band as CUDA against the original PyTorch.

| Clip | alpha MAE | % of pixels off by more than 1/255 | alpha PSNR |
| --- | --- | --- | --- |
| godiva_close | 9.63e-4 | 7.4 % | 51.3 dB |
| locked_backdrop | 4.01e-4 | 3.5 % | 55.1 dB |
| metal_glasses | 5.69e-4 | 4.7 % | 52.5 dB |
| smoke | 5.18e-4 | 4.1 % | 55.1 dB |
| walking_sitting | 1.88e-4 | 1.5 % | 57.0 dB |
| with_motion_blur | 2.19e-4 | 1.7 % | 57.9 dB |

The one-time build per resolution is about 2.5 minutes for the five networks. In 1.0 this is the app's TensorRT
switch (Linux, off by default; Requirements): the AppImage carries the engine builder, and the switch offers the
TensorRT download.

**Correction (measured later on 2026-10-24, 0.0.7-dev):** the 2.5 minutes above (140.9 s for the 1280×1080 range)
were measured with TensorRT's timing cache already warm from the earlier ranges' builds in the same cache folder.
A first build with an empty cache, the five networks at 1280×1080 (window 48/24), takes **270.7 s (4 min 31 s)**
with the shipped (Zig-built) builder and 270.7 s with the earlier g++ build of it, so the builder makes no
difference; stage 1 alone is 138 s. The same builds with the timing cache warm: 135.0 s. The app's own first
optimize measured 4 min 22 s. So: about 4.5 minutes the first time per resolution on an RTX 5080, about half that
when the timing cache is warm.

### 0.0.7-dev: TensorRT at 4K

Until 0.0.6-dev a frame with a side over 2176 px ran on CUDA under TensorRT. 0.0.7-dev gives 4K its own engine
range (DCI 4K and UHD pad into 2176×4096; open gate 4096×3072 and anything larger stay on CUDA) and keeps CUDA's
window, as at HD: 8/4 in low-memory mode at 4K on a 16 GB card. Measured on 2026-10-24, RTX 5080 (16 GB), TensorRT
10.16.1.

The one-time builds at 4K (the shipped builder, workspace 7.2 GiB, cold; card memory is the whole card, in GiB as in the
tables above; the desktop holds 1.6 of it):

| Network | Window | Built | Time | Card peak | RAM peak |
| --- | --- | --- | --- | --- | --- |
| C-RADIO | 8/4 | yes | 36.8 s | 3.2 GB | 4.3 GB |
| MoGe | 8/4 | yes | 33.1 s | 2.4 GB | 2.5 GB |
| RVM | 8/4 | yes | 35.6 s | 2.5 GB | 2.4 GB |
| stage 1 | 8/4 | yes | 139.2 s | 12.8 GB | 4.7 GB |
| stage 2 | 8/4 | yes | 57.8 s | 5.6 GB | 3.3 GB |
| stage 1 | 16/8 | **no** with a 4.0, 7.2 or 9.2 GiB workspace (no tactic); yes with 11.7 GiB (211.8 s, 12.7 GB) | | | |

Inside the engine the first 4K job built all five in 284.5 s (about 5 minutes) and nothing fell back to CUDA.
16/8 doesn't fit a 16 GB card: the engine caps the builder's workspace at 8 GiB, and even the engine built by hand
with 11.7 GiB ran out of graphics memory in stage 1 while keying (13.2 GB peak), as CUDA does at 16/8. So 8/4 is the
4K window on 16 GB for both.

The four Tears of Steel 4K plates (120 EXR frames each), TensorRT against CUDA, same day, same engine binary, same
8/4 window, EXR output:

| Shot | CUDA: total · first frames · steady | TensorRT: total · first frames · steady | Change | Graphics memory, CUDA / TensorRT | RAM, CUDA / TensorRT |
| --- | --- | --- | --- | --- | --- |
| 04_5h | 151.5 s · 88.9 s · 1.90 fps | **113.0 s** · 68.1 s · 2.66 fps | −25 % | 9.22 / 9.81 GB | 6.30 / 5.50 GB |
| 04_5d | 147.5 s · 85.6 s · 1.93 fps | **112.6 s** · 67.4 s · 2.64 fps | −24 % | 9.13 / 9.81 GB | 6.35 / 5.67 GB |
| 08_3a | 147.3 s · 85.4 s · 1.93 fps | **112.4 s** · 67.7 s · 2.67 fps | −24 % | 9.29 / 9.81 GB | 6.37 / 5.67 GB |
| 04_2c | 148.1 s · 86.2 s · 1.93 fps | **111.5 s** · 66.4 s · 2.64 fps | −25 % | 9.15 / 9.81 GB | 6.48 / 5.66 GB |

04_5h's first TensorRT job, with the one-time build: 398.9 s; its matte is bit-identical to the later job's. These
runs used a measurement build of the engine; the shipped change, re-run on 04_5d with the same engines, took
111.9 s (measurement build: 112.6 s and 109.9 s), and its alpha and foreground are identical to the measurement build's, value for value.

Mattes, TensorRT against CUDA, read exactly: the EXR frames as floats with OpenCV (not through ffmpeg). The edge
band is where CUDA's alpha is between 0.02 and 0.98 (hair and soft edges). The HD table above compares video files,
so its numbers aren't directly comparable with these.

| Shot | alpha MAE | alpha max | % off by more than 1/255 | more than 4/255 | alpha PSNR | edge band: MAE · % > 1/255 | fg PSNR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 04_5h | 2.95e-5 | 0.016 | 0.005 % | 0.00000009 % | 76.1 dB | 4.4e-4 · 0.11 % | 63.1 dB |
| 04_5d | 3.08e-5 | 0.086 | 0.094 % | 0.002 % | 70.6 dB | 7.5e-4 · 3.1 % | 65.2 dB |
| 08_3a | 4.14e-5 | 0.054 | 0.116 % | 0.016 % | 66.6 dB | 1.2e-3 · 4.2 % | 54.1 dB |
| 04_2c | 3.75e-5 | 0.013 | 0.010 % | 0 | 75.4 dB | 3.7e-4 · 0.14 % | 80.6 dB |

Today's CUDA 4K totals (147-152 s) are below the 4K table's 170-174 s (0.0.3-dev): 0.0.4-dev's faster EXR decoding
took 04_5h from 170.1 to 162.7 s; these runs also write EXR instead of video, and the rest of the gap wasn't measured
on its own. The 4K table above stays as measured.

### 0.0.8-dev: onnx.4, CorridorKey 2.0's precision policy (2026-10-25)

The app now downloads model set `2.0.0-onnx.4`: MoGe, RVM, stage 1 and stage 2 compute the way CorridorKey 2.0 does
under its autocast (fp16 convolutions, matrix multiplies and attention; fp32 norms, softmax, exp/pow, sums and
upsampling), where `onnx.3` ran those four entirely in fp16. C-RADIO is unchanged. Measured 2026-10-25, RTX 5080, CUDA,
the app's normal settings (automatic window, 12 GB budget, alpha + foreground video outputs), the same engine binary,
onnx.4 then onnx.3 back to back:

| Clip | onnx.3: total · first frames · steady | onnx.4: total · first frames · steady | Change | Graphics memory (GiB), onnx.3 → onnx.4 | RAM (GiB), onnx.3 → onnx.4 |
| --- | --- | --- | --- | --- | --- |
| locked_backdrop 1280×1080, 80 frames (48/24) | 20.2 s · 13.9 s · 18.65 fps | 24.5 s · 17.7 s · 16.80 fps | +21 % | 8.21 → 9.07 | 5.15 → 6.49 |
| 04_5d 4096×2160 EXR, 120 frames (8/4) | 161.7 s · 84.7 s · 1.95 fps | 180.5 s · 92.6 s · 1.66 fps | +12 % | 9.26 → 9.29 | 13.62 → 13.55 |

The cost is real: 12-21 % more time, and at HD 0.9 GiB more graphics memory and 1.3 GiB more RAM; the gain is parity
with how CorridorKey 2.0 itself computes, not a measured quality change (Quality, "What we got wrong" 1). The tables
above stay as measured with onnx.3.

### 0.0.8-dev: TensorRT on onnx.4 (2026-10-25)

One run each on the RTX 5080, the shipping model set onnx.4 and the app's normal settings (automatic window, 12 GB
budget, alpha + foreground video outputs). First a cold build into an empty TensorRT cache (the job builds its own
range), then TensorRT with the range built and CUDA, back to back (`tools/engine_bench.mjs`):

| Clip | TensorRT (built) | CUDA | TensorRT takes | Steady fps, TensorRT / CUDA | Graphics memory (GB), TensorRT / CUDA |
| --- | --- | --- | --- | --- | --- |
| locked_backdrop 1280×1080, 80 frames | 15.9 s | 25.4 s | 0.63× the time | 20.6 / 15.7 | 11.0 / 9.1 |
| 04_5d 4096×2160 EXR, 120 frames | 143.7 s | 189.7 s | 0.76× the time | 2.20 / 1.63 | 10.8 / 9.3 |

The one-time build per resolution range, seconds per network (the engine's own log), and its size on disk:

| Range | C-RADIO | MoGe | RVM | Stage 1 | Stage 2 | Total | Disk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| up to 1280×1280 (the 1280×1080 clip) | 34.7 | 23.2 | 25.0 | 137.5 | 42.4 | 4.4 min | 2.76 GB |
| up to 4096×2176 (4K) | 31.3 | 27.4 | 24.7 | 145.1 | 59.3 | 4.8 min | 2.77 GB |

From these: the build pays for itself after about 750 frames at 4K (about 30 s of 24 fps footage) and about 2,200
frames at 1280×1080. Not measured: the HD 1920×1080 range and every other range, other cards, and the build as the
very first on a card (the 4K build ran second, with the timing cache the first one wrote).

### 0.0.8-dev re-measured: the same-day pair on onnx.4 (2026-10-26)

The headline numbers above, measured again because the app ships onnx.4 since 2026-10-25: the original and this
engine back to back on the RTX 5080, the same day, with `tools/vs_original.sh --steps speed --repeats 1` (12 GB
budget, automatic window, alpha + foreground videos, no hint), then TensorRT with its ranges built
(`tools/engine_bench.mjs --tensorrt`, same clips and settings). Engine at main 1afed1c. One repeat each; totals are
engine start to result, model load included.

| Clip | Original | CUDA | Faster | TensorRT (built) | Faster |
| --- | --- | --- | --- | --- | --- |
| godiva_close 960×720, 349 frames | 67.8 s | 40.7 s | 1.67× | 37.0 s | 1.83× |
| locked_backdrop 1280×1080, 80 | 37.0 s | 19.6 s | 1.89× | 16.5 s | 2.24× |
| metal_glasses, 139 | 42.1 s | 28.3 s | 1.49× | 22.0 s | 1.92× |
| smoke, 250 | 73.2 s | 48.7 s | 1.50× | 37.7 s | 1.94× |
| walking_sitting, 314 | 86.9 s | 59.5 s | 1.46× | 45.8 s | 1.90× |
| with_motion_blur, 50 | 18.6 s | 17.2 s | 1.08× | 17.9 s | 1.04× |
| 04_5h 4K EXR, 120 | 328.7 s | 174.4 s | 1.89× | 135.6 s | 2.42× |
| 04_5d 4K EXR, 120 | 325.7 s | 176.0 s | 1.85× | 136.5 s | 2.39× |
| 08_3a 4K EXR, 120 | 327.2 s | 180.0 s | 1.82× | 139.5 s | 2.34× |
| 04_2c 4K EXR, 120 | 321.8 s | 174.6 s | 1.84× | 134.7 s | 2.39× |

Steady frames per second: the original 9.6-10.4 at 1280×1080 and 0.93-0.97 at 4K; CUDA 16.9-17.3 and 1.69-1.75;
TensorRT 21.1-21.8 and 2.29-2.32. Peak graphics memory: the original 11.97 GiB (HD) and 11.34 GiB (4K); CUDA 9.07 and
9.29; TensorRT 11.04 and 10.79.

What changed against the tables above: our times are about the same as on 2026-10-24 (4K 174-180 s against
170-174 s), but **the original ran faster this time** (4K 322-329 s against 413-472 s; steady 0.93-0.97 fps against
0.48-0.60). Same checkout, same machine; we don't know why yet, and only more same-day repeats will show which of its
days is typical. The ratios above are the conservative ones. with_motion_blur gains least: 50 frames in one window,
so loading the models is most of its time.

Since this pair the memory table moved to onnx.4 too (main 1e7cf76, "What we got wrong" item 5's follow-up): at the
pair's 12 GB budget a 4K clip now gets the 4/2 window instead of 8/4 (slower, and safe: 3200×1800 at 8/4 measured
11.79 GiB). On a 16 GB card with its whole free memory (about 14.5 GiB), 4K keeps 8/4 and 1080p gets 24/12 normal.

### 0.0.9-dev: onnx.5, our own graphs (2026-10-28)

dev.2 downloads model set `2.0.0-onnx.5`: our own export of stage 1 and stage 2, made so AMD's MIGraphX and Apple's
Neural Engine can take them. Stage 2 runs one masked Swin attention per block, stage 1 takes its regions by one gather
each in the original's frame-major token order, and the RMS norms are written in plain operations. C-RADIO's weights
are stored in fp16 (ONNX Runtime converted them to fp16 on load before, so the card holds the same weights), which
takes the models download from 3.30 to 2.48 GB. MoGe and RVM are byte for byte onnx.4's; Corridor's code and weights
are unchanged (docs/ONNX_EXPORT.md, "onnx.5"). The Mac gets its own Core ML set from the same export,
`onnx.5-coreml` (Apple Silicon, below).

Method: RTX 5080 (the PC above), CUDA fp16, the same engine binary, the automatic window from the card's free memory
(13.3-13.5 GiB; both sets picked the same window on every clip), alpha + foreground as float EXR, no hint. One run per
set, back to back per clip, onnx.4 first (`tools/engine_bench.mjs`, then `tools/matte_compare.py` and
`tools/temporal_stability.py` on the two outputs). Eight clips on 2026-10-27; 08_3a and 04_2c on 2026-10-28, after the
first run was cut short. These runs write float EXR, where most tables above wrote video, so their totals and steady
rates compare with each other, not with those tables.

| Clip (window) | Steady fps, onnx.4 → onnx.5 | Change | Total, onnx.4 → onnx.5 | Change | Graphics memory (GiB), onnx.4 → onnx.5 | RAM (GiB), onnx.4 → onnx.5 |
| --- | --- | --- | --- | --- | --- | --- |
| godiva_close 960×720, 349 frames (80/40) | 11.04 → 11.43 | +3.5 % | 41.9 → 39.9 s | −5.0 % | 9.84 → 9.00 | 6.45 → 6.32 |
| locked_backdrop 1280×1080, 80 (48/24 low) | 15.46 → 15.84 | +2.4 % | 18.8 → 17.7 s | −5.5 % | 9.04 → 9.04 | 6.49 → 6.58 |
| metal_glasses 1280×1080, 139 (48/24 low) | 15.20 → 15.57 | +2.4 % | 28.9 → 27.8 s | −3.9 % | 9.04 → 9.04 | 6.61 → 6.70 |
| smoke 1280×1080, 250 (48/24 low) | 15.11 → 15.45 | +2.3 % | 51.4 → 49.9 s | −2.8 % | 9.04 → 9.04 | 6.60 → 6.78 |
| walking_sitting 1280×1080, 314 (48/24 low) | 16.45 → 16.50 | +0.3 % | 60.0 → 59.2 s | −1.3 % | 9.05 → 9.04 | 6.59 → 6.86 |
| with_motion_blur 1280×1080, 50 (48/24 low) | 16.31 → 16.55 | +1.5 % | 13.4 → 12.5 s | −6.8 % | 9.04 → 9.04 | 6.11 → 6.27 |
| 04_5h 4096×2160 EXR, 120 (8/4) | 0.75 → 0.76 | +2.1 % | 176.3 → 173.4 s | −1.6 % | 10.82 → 10.82 | 7.48 → 7.35 |
| 04_5d 4096×2160 EXR, 120 (8/4) | 0.76 → 0.78 | +2.4 % | 174.9 → 170.0 s | −2.8 % | 10.82 → 10.82 | 7.43 → 7.31 |
| 08_3a 4096×2160 EXR, 120 (8/4) | 0.76 → 0.78 | +3.2 % | 177.9 → 169.6 s | −4.7 % | 10.82 → 10.82 | 7.39 → 7.16 |
| 04_2c 4096×2160 EXR, 120 (8/4) | 0.76 → 0.79 | +2.8 % | 175.5 → 168.5 s | −4.0 % | 10.82 → 10.82 | 7.42 → 7.12 |
| **All ten** | | | **919.0 → 888.4 s** | **−3.3 %** | | |

Honestly: 0.3-3.5 % faster steady (1.3-6.8 % on the totals) is about the size of the run-to-run spread (two runs of
one build agreed within 1 % on four HD clips, 6 % on locked_backdrop and 8 % on godiva_close; "Repeatability" above),
it is one run per set, and onnx.4 always ran first. So: no slower, the same graphics memory (godiva_close peaked
0.84 GiB lower in its one run), RAM 0.09-0.27 GiB higher on the 1280×1080 clips (godiva_close 0.13 lower) and 0.12-0.30 GiB lower at 4K.

Mattes, onnx.5 against onnx.4 (every frame, EXR read as float), and the hair "sizzle" (`temporal_stability.py`: the
second difference of alpha in the static hair-edge band, pooled mean; the flow check kept the same moving pixels for
both sets on every clip, so both are measured over the same regions):

| Clip | alpha max | alpha MAE | % off by more than 1/255 | alpha PSNR | sizzle, onnx.4 / onnx.5 |
| --- | --- | --- | --- | --- | --- |
| godiva_close | 0.37/255 | 2.71e-5 | 0 | 79.5 dB | 0.010835 / 0.010835 |
| locked_backdrop | 0.37/255 | 1.20e-5 | 0 | 84.6 dB | 0.020542 / 0.020543 |
| metal_glasses | 0.37/255 | 1.31e-5 | 0 | 83.6 dB | 0.009265 / 0.009265 |
| smoke | 0.50/255 | 1.72e-5 | 0 | 83.0 dB | 0.012760 / 0.012761 |
| walking_sitting | 0.50/255 | 7.82e-6 | 0 | 88.3 dB | 0.036589 / 0.036569 |
| with_motion_blur | 0.37/255 | 8.82e-6 | 0 | 86.6 dB | 0.037518 / 0.037536 |
| 04_5h | 0.37/255 | 7.84e-6 | 0 | 86.4 dB | 0.018119 / 0.018120 |
| 04_5d | 0.37/255 | 5.67e-6 | 0 | 87.8 dB | 0.025207 / 0.025204 |
| 08_3a | 0.37/255 | 5.21e-6 | 0 | 88.7 dB | 0.021494 / 0.021494 |
| 04_2c | 0.25/255 | 1.03e-5 | 0 | 84.8 dB | 0.020489 / 0.020491 |

Every pixel of every frame within half a 1/255 step of onnx.4's, and the same sizzle to within 0.1 % on every clip.

**TensorRT stays on onnx.4.** dev.2's TensorRT jobs use dev.1's TensorRT set (`2.0.0-onnx.4-trt`), so the TensorRT
numbers in these notes are onnx.4's (0.0.8-dev). onnx.5's own TensorRT set is still being measured.

### 0.0.10-dev: the pipelining pass (2026-10-29)

The engine keeps the card busier with the same output: a clip's first frames decode while the models load; in the
normal mode on CUDA three of the five models load while the first pass (RVM) runs (since the performance review, only
with the automatic window and at least 10 GB for the job); in the normal mode each temporal window's results are blended while the card already
runs the next window, and C-RADIO and MoGe run once per frame instead of once per window a frame is in. Method: RTX 5080 (the PC above), CUDA fp16, model set `2.0.0-onnx.5`, the automatic window
(13.1 GB free), alpha + foreground as float EXR, three runs per engine, alternating back to back
(`tools/engine_bench.mjs`; dev.4's engine against this one). Every output file of every run is byte for byte the same
as dev.4's (240 EXR files at 4K, 628 at HD; `cmp`; this round's per-run record wasn't kept). Checked on the RTX 5080
only, at these two windows, float EXR; other cards, other windows, the CPU provider and Core ML: not checked
(docs/ENGINE_RUST.md, "The pipelining pass").

| Clip (window) | dev.4 engine, total (s) | 0.0.10-dev, total (s) | Median | Graphics memory (GB) | RAM (GB) |
| --- | --- | --- | --- | --- | --- |
| 04_5h 4096×2160 EXR, 120 frames (8/4 normal) | 165.4 · 166.4 · 166.9 | 160.1 · 159.4 · 158.4 | **−4.2 %** | 11.08 → 11.35 | 7.5-7.8 → 8.6-8.8 |
| walking_sitting 1280×1080, 314 frames (48/24 low-memory) | 58.8 · 58.5 · 58.1 | 58.3 · 58.0 · 58.0 | −0.9 % (within the spread) | 9.26 → 9.26 | 7.2-7.3 → 7.3-7.4 |

Each change was measured on its own at 4K (docs/ENGINE_RUST.md, "The pipelining pass"): the early decode and the
loads behind RVM −1.6 %, the blend on its own thread −1.5 %, C-RADIO and MoGe once per frame −1.6 % (medians). The
read-only studies before it estimated +5-9 % at 4K and +3-6 % at HD; measured, the low-memory mode HD clips use gained
nothing (the blend on its own thread was tried there and dropped), and TensorRT, always in that mode, wasn't measured.

### 0.0.11-dev: fewer copies (2026-10-29)

Same day, same method and machine, the dev.4 engine against this one (with 0.0.10-dev's pipelining), three runs
each, alternating: the networks'
results are read where ONNX Runtime made them instead of being copied out (stage 1's states are 0.57 GB per 4K
window), and in the normal mode stage 2 takes each frame from stage 1's already converted input. Every output file of
every run is byte for byte the same as dev.4's (`cmp`, the result kept per run; the same scope as above). These runs
are the build before the last change (the RVM pass resizing its inputs from bfloat16); the final build was checked byte
for byte against dev.4 in one run at HD and, before the review's load-order fixes, one at 4K; not timed.

| Clip (window) | dev.4 engine, total (s) | 0.0.11-dev, total (s) | Median | Graphics memory (GB) | RAM (GB) |
| --- | --- | --- | --- | --- | --- |
| 04_5h 4096×2160 EXR, 120 frames (8/4 normal) | 164.9 · 165.7 · 166.1 | 152.5 · 152.5 · 152.7 | **−8.0 %** | 11.08 → 11.35 | 7.8 → 8.6-8.7 |
| walking_sitting 1280×1080, 314 frames (48/24 low-memory) | 58.1 · 57.5 · 57.6 | 55.8 · 56.0 · 56.0 | **−2.8 %** | 9.26 → 9.07-9.26 | 7.3-7.4 → 7.2-7.3 |

Tried and dropped (docs/ENGINE_RUST.md, "The pipelining pass"): HD in the normal mode at the same window (identical
mattes, no faster: HD is limited by the card's own work) and page-locked output memory (−0.7 % at 4K, inside the
spread, for 0.4-0.7 GB of locked RAM).

</details>

### The full suite, float EXR (2026-10-29)

All ten test clips on the RTX 5080 (16 GB), one run per clip and engine, back to back in one session: the original
CorridorKey 2.0 (PyTorch, from its own checkout), CorridorKey Desktop at 1.0.0-dev.5's engine on CUDA, and the same
engine with TensorRT. The card's whole free memory, the automatic window, alpha and foreground written as float EXR (the
studio deliverable), no hint. Totals in seconds, from engine start to result. Two TensorRT runs included that size's
one-time engine build (marked) and aren't a keying speed; godiva_close's TensorRT run is missing (the bench setup's
fault, not the engine's).

| Clip | Original | CUDA | × | TensorRT | × |
| --- | --- | --- | --- | --- | --- |
| godiva_close 960×720 | 109.7 | 37.1 | 3.0 | — | — |
| locked_backdrop 1280×1080 | 47.0 | 18.3 | 2.6 | 279.6 (with the build) | — |
| metal_glasses 1280×1080 | 109.5 | 32.2 | 3.4 | 21.8 | 5.0 |
| smoke 1280×1080 | 182.4 | 47.7 | 3.8 | 37.5 | 4.9 |
| walking_sitting 1280×1080 | 266.2 | 59.4 | 4.5 | 47.1 | 5.7 |
| with_motion_blur 1280×1080 | 44.1 | 13.3 | 3.3 | 9.5 | 4.6 |
| 04_5h 4096×2160 | 516.4 | 161.7 | 3.2 | 346.7 (with the build) | — |
| 04_5d 4096×2160 | 543.9 | 170.7 | 3.2 | 118.8 | 4.6 |
| 08_3a 4096×2160 | 504.5 | 158.5 | 3.2 | 114.8 | 4.4 |
| 04_2c 4096×2160 | 586.1 | 166.9 | 3.5 | 122.9 | 4.8 |

Writing float EXR, the original is much slower than in the video-output tables above (04_5h 516 s here, 329 s writing
video on 2026-10-26), so these ratios are higher than those; compare like with like. On this card TensorRT's 4K jobs
ran the 4/2 window (the tables above from 2026-10-25/26 used 8/4), and the CUDA window varied with the memory free at
each start (8/4 normal or 4/2 low at 4K). TensorRT's mattes differ slightly from CUDA's: up to about 9.5/255 on 0.2 % of
pixels on an HD clip (2026-10-29), the same with an engine built for the job's own window, so it is TensorRT's fp16
precision, not the build size.

### Apple Silicon (Core ML)

The Mac engine runs ONNX Runtime's Core ML backend on its own model set (Core ML compiles for fixed frame sizes:
1280×1080 clips padded to 1152×1280, 1920×1080 padded to 1152×1920, and from dev.3 4096×2160 padded to 2176×4096). Measured on a real Mac with
`tools/mac_gate.sh`, against CUDA on the PC above with the same clip, window and settings; memory is the peak
phys_footprint of the engine's processes (`tools/mac_memgate.c`), since a Mac's graphics memory is its RAM.

**Test machine (Mac)**

| | |
| --- | --- |
| Computer | Mac mini (Mac18,5) |
| Chip | Apple M6: 6 CPU cores (2 performance + 4 efficiency), 12-core GPU, Neural Engine |
| Memory | 16 GB unified memory |
| System | macOS 27.0.1 |
| CorridorKey Desktop | Rust engine on ONNX Runtime 1.31.0, Core ML provider, compute units CPU + GPU (`cpu-gpu`; the Neural Engine is off by default, docs/ENGINE_RUST.md "Core ML on a 16 GB Mac"), fp16 |

Results so far: 04_5d (Tears of Steel) scaled to 1280×1080 (120 frames), to 1920×1080 and at 4K (the first 12 frames),
low-memory windows, alpha + foreground as float EXR.

| Set, date | Clip, window | Total | Steady fps | Peak footprint | Mattes against CUDA: alpha MAE · alpha max · % > 1/255 |
| --- | --- | --- | --- | --- | --- |
| `onnx.4-coreml`, 2026-10-27 | 1280×1080, 120 frames, 4/2 | 160.2 s | | 2.36 GB | (12-frame runs: 2.7-3.1e-5 · 1/255 or less · 0 %) |
| `onnx.4-coreml`, 2026-10-27 | 1280×1080, 120 frames, 8/4 | 171.9 s | | 3.33 GB | |
| `onnx.4-coreml`, 2026-10-27 | 1920×1080, 12 frames, 4/2 | 26.2 s | 2.09 | 3.35 GB | 2.14e-5 · 3.42e-3 · 0 % |
| `onnx.4-coreml`, 2026-10-27 | 1920×1080, 12 frames, 8/4 | 19.7 s | 2.08 | 5.25 GB | 2.23e-5 · 1.46e-3 · 0 % |
| **`onnx.5-coreml`** (dev.2), 2026-10-28 | 1280×1080, 120 frames, 4/2 | 111.0 s | 2.84 | 2.64 GB | 2.50e-5 · 1.90e-2 · 0.002 % (none over 4/255) |
| **`onnx.5-coreml`** (dev.2), 2026-10-28 | 1920×1080, 12 frames, 4/2 | 23.8 s | 2.02 | 3.78 GB | 2.10e-5 · 3.91e-3 · 0 % |
| **`onnx.5-coreml.1`** (dev.3), 2026-10-28 | 4096×2160, 12 frames, 4/2 | 73.1 s (44 s of it Core ML's first compile) | 0.38 | 9.8 GB (0.8 GB swapped) | 1.32e-5 · 2.44e-3 · 0 % |

CUDA on the PC, the same onnx.5 jobs: 22.8 s (15.99 fps steady) at 1280×1080, 6.2 s (10.94 fps) at 1920×1080 and
20.0 s (1.88 fps) at 4K. The 4K row ran the engine shipped in dev.2 on the 4K files, under the memory gate set to stop
only at critical pressure (its default, the first pressure warning, stopped the first try during Core ML's compile).
The onnx.4 rows are docs/ENGINE_RUST.md ("Core ML on a 16 GB Mac") and backlog row 60; the onnx.5 rows are the Mac
gate's reports of 2026-10-28 (both passed the gate's bar: within fp16 rounding of CUDA).

What these don't show: whether onnx.5 is faster on the Mac. Core ML compiles each model file on first use and caches
it, and the cache states differ between these runs (which also ran different engine builds: the 1920×1080
onnx.4 runs 5e0d9e9, the onnx.5 runs e7eb105), so the totals aren't a like-for-like pair. The one comparable figure, the 1920×1080 steady rate at 4/2, is
about the same (2.09 / 2.02 fps). onnx.5's peak footprint was 0.28-0.43 GB higher in these runs.

**The Mac's full table comes after the Mac test round, which hasn't run yet**: all ten clips, against CUDA, with the
speed and memory of each (backlog row 24).

<details>
<summary>TensorRT, first measurement (2026-10-21)</summary>

### TensorRT, first measurement (2026-10-21)

TensorRT's first measurement in the engine, on 2026-10-21 (`onnx.2` models, the same HD bench), before it took
CUDA's window (0.0.6-dev above is what the app's switch runs). It needed a one-time optimization per resolution
(about 3.5 minutes) and was not available at 4K (its 4K build needs more than 12 GB of graphics memory).

| Clip | TensorRT total | CUDA total (same day) | Original (same day) | TensorRT vs original |
| --- | --- | --- | --- | --- |
| godiva_close | 28.8 s | 42.7 s | 68.4 s | 0.42× the time |
| locked_backdrop | 14.4 s | 21.9 s | 40.3 s | 0.36× |
| metal_glasses | 22.4 s | 29.9 s | 44.7 s | 0.50× |
| smoke | 37.0 s | 51.7 s | 76.5 s | 0.48× |
| walking_sitting | 44.6 s | 63.1 s | 94.2 s | 0.47× |
| with_motion_blur | 10.1 s | 12.3 s | 19.0 s | 0.53× |

</details>

## Quality: the mattes against the original and the truth

Speed only counts if the result is the same. `tools/matte_compare.py` compares every frame of CorridorKey Desktop's
alpha and foreground against the original's from the same runs. For scale: the original's own shipping GPU mode
(bf16) differs from its full-precision (fp32) reference by about as much (alpha MAE 5.0e-4 on the test clips,
docs/ENGINE_RUST.md).

| Clip | Frames | Alpha MAE | Alpha max | Pixels > 1/255 | Alpha PSNR | Foreground PSNR (all / subject) |
| --- | --- | --- | --- | --- | --- | --- |
| godiva_close | 349 | 1.57e-3 | 0.122 | 14.8 % | 49.0 dB | 45.6 / 44.2 dB |
| locked_backdrop | 80 | 6.12e-4 | 0.068 | 3.9 % | 54.3 dB | 49.0 / 47.5 dB |
| metal_glasses | 139 | 6.89e-4 | 0.091 | 5.7 % | 52.2 dB | 45.3 / 41.8 dB |
| smoke | 250 | 9.38e-4 | 0.156 | 7.8 % | 50.4 dB | 45.3 / 43.2 dB |
| walking_sitting | 314 | 2.71e-4 | 0.341 | 1.8 % | 54.1 dB | 52.0 / 43.1 dB |
| with_motion_blur | 50 | 3.01e-4 | 0.082 | 2.2 % | 57.0 dB | 50.9 / 45.2 dB |
| 4K 04_5h | 120 | 4.47e-4 | 0.154 | 3.2 % | 53.5 dB | 44.7 / 42.6 dB |
| 4K 04_5d | 120 | 3.05e-4 | 0.264 | 2.0 % | 55.1 dB | 45.3 / 43.8 dB |
| 4K 08_3a | 120 | 2.37e-4 | 0.082 | 1.6 % | 57.5 dB | 46.2 / 45.5 dB |
| 4K 04_2c | 120 | 4.59e-4 | 0.064 | 3.3 % | 56.0 dB | 51.2 / 48.5 dB |

**Correction (2026-10-25):** we wrote that these differences were "fp16 against bf16 rounding". Whether that holds against the
truth: on the same input, yes, it's the original's bf16 rounding, and ours is the closer of the two (measured
2026-10-25, "What we got wrong" 1 below). These rows are from before that, when we still read input at 16 bits. With both engines in full precision (fp32, on the processor,
`engine-rs/tools/e2e_cpu.sh`), the mattes are the same to within rounding: alpha MAE 1.7e-7, max 6.9e-5, no pixel
off by even 1/255, foreground PSNR 102.6 dB; the low-memory mode matches the normal one exactly (difference 0).

### What we got wrong, and what we're doing about it

Part of the story, kept here on purpose. Each item: what happened, how it was found, the fix.

**1. A difference in the hair, and two wrong turns finding it (found 2026-10-24 by eye; input matched to
CorridorKey 2.0 and measured 2026-10-25).** Marcy saw a
difference in the hair on the first day of side-by-side viewing. We filed it as "within the original's variation"
because our scorecard compared us only with the original's *output*, never with the *truth* (the original's model in
full fp32 precision). On 2026-10-25 we measured against the truth and published a large hair-edge gap here, then
withdrew it: the truth and the original's bf16 run were fed 16-bit PNG frames converted by ffmpeg, while our engine
read the video itself, so the inputs weren't the same and the numbers don't count. Acting on them, we also re-exported
four networks with the original's precision policy (model set onnx.4); the hair didn't measurably change, so that
wasn't the cause. onnx.4 ships anyway since 2026-10-25 (dev.1), for parity with CorridorKey 2.0's precision policy, not
because it fixed the hair (its cost: Speed, "0.0.8-dev"). dev.2's onnx.5 is built on onnx.4's export (docs/ONNX_EXPORT.md,
"onnx.5"); its mattes are within 0.5/255 of onnx.4's (Speed, "0.0.9-dev"). The one deviation from CorridorKey 2.0 left in our input
then: it reads video through OpenCV at 8 bits; we read 10/12-bit plates at 16 bits (same colour conversion), and
rounded 10/12-bit 4:2:2 and 4:2:0 to 8 bits differently from OpenCV.

The fix and the measurement (2026-10-25): our engine now reads input exactly as CorridorKey 2.0 does by default,
byte for byte (16 bits is an opt-in per clip). Then one run on locked_backdrop (12-bit ProRes 4444, 1280×1080, 80
frames), the same .mov fed to all three through their own readers, the same window (12/6, low-memory), float EXR
outputs, compared exactly (`tools/matte_compare.py`; the method checked first on a known-equal pair: truth vs
itself is exactly 0). Truth = CorridorKey 2.0's own `infer.py` with its bf16 autocast switched off (fp32 model on
the runtime's own inputs; Corridor's files untouched, a wrapper patches autocast at run time):

| vs the fp32 truth | Alpha MAE | Alpha max | % > 1/255 | Hair edges MAE | Hair edges % > 1/255 | fg PSNR |
| --- | --- | --- | --- | --- | --- | --- |
| CorridorKey 2.0 as it ships (bf16) | 3.6e-4 | 0.053 | 0.63 % | 1.9e-3 | 9.45 % | 57.3 dB |
| **CorridorKey Desktop (CUDA fp16, onnx.4)** | **2.6e-5** | **0.0065** | **0.00004 %** | **2.1e-4** | **0.0007 %** | **73.6 dB** |

Fed the same pixels, our matte is closer to the truth than CorridorKey 2.0's own shipping run on every measure
(hair-edge error about 9× smaller). Our engine against CorridorKey 2.0 as it ships: alpha MAE 3.7e-4, hair edges
9.1 % > 1/255, fg 57.2 dB, about the original's own distance from the truth: on the same input, what separates us
from the original is its bf16 rounding.

How much the 16-bit read changed (2026-10-25, one more run, the same clip and settings, only `input_bit_depth`
"16"): our 16-bit matte against our 8-bit one, hair edges MAE 4.0e-3, 40.5 % > 1/255 (alpha MAE 2.8e-4, fg 49.4 dB);
against CorridorKey 2.0 as it ships, hair edges 39.7 % > 1/255, against 9.1 % at 8 bits. So most of the hair
difference Marcy saw came from our 16-bit read, about 4× more than the original's bf16 rounding. Whether 16-bit
hair is better or worse is not measured: the truth above was fed 8-bit frames, so 16-bit differs from it by input,
not necessarily by error. That needs a second truth fed the same 16-bit frames (the next step, "expanding the bit
depth").

**2. The scorecard measured the wrong reference (2026-10-24).** Comparing with the original's output can't tell
which of two roundings is closer to the right answer. From now on quality is measured against the fp32 truth. The
overnight precision-floor run also failed (the fp32 reference didn't fit 12 GiB at the original's window, then our
comparisons hit memory limits we had guessed), and had to be run again.

**3. Options of the original we hadn't carried over (found 2026-10-24 watching the launch video).** `--model_scale`,
the linear brightness/contrast adjust (ported but fixed at identity), `--start_mode` and `--seed`. All now ported and
tested against PyTorch; every option of `infer.py` has a written verdict in docs/PARITY.md.

**4. TensorRT's one-time build was never explained, and fallbacks were silent (2026-10-25).** Switching TensorRT on
meant a first job sat through about 5 minutes of building at 4K, when CUDA alone finishes the clip in under 3; and a
job that ran on CUDA instead didn't say so. Now every job page shows what it ran on and why, and TensorRT builds in
the background with a progress bar and an explanation, never inside a job.

**5. The memory estimate wasn't an upper bound (2026-10-24).** The old table was off by −32 % to +73 % against
measured peaks. Recalibrated on 96 measured points; it is now above every one of them (+6 % margin).

**5, again: the table was measured on the previous models (2026-10-26).** The 2026-10-24 table came from model set
onnx.3; the app ships onnx.4 since 2026-10-25 (dev.1; dev.2's onnx.5 peaked at the same graphics memory or
less at the automatic windows on the ten test clips, Speed "0.0.9-dev"). The same sweep on onnx.4 (RTX 5080, CUDA fp16, 85 points: 69 ran, 16
ran out of memory) found the old table under the measured peak at 31 of 69 points (up to 16 %: 960×720 80/40
low-memory, 11.58 GiB against 9.75), and on a 16 GB card it picked 48/24 low-memory for a 1920×1080 clip, which runs
out of memory on onnx.4. The table is now onnx.4's, again above every measured point (by at least 0.12 GiB), and the
windows that ran out of memory are never picked on a 16 GB card. The automatic window on a 16 GB card (~14.5 GiB
free): 1920×1080 48/24 low-memory → 24/12 normal (measured 10.15 GiB); 1280×1080 (48/24) and 4K (8/4) keep their
windows. At a 12 GiB budget: 4K 8/4 → 4/2 low-memory (3200×1800 peaks 11.79 GiB at 8/4, and the table never falls
for a larger size), with_motion_blur 80/40 → 48/24, 1920×1080 24/12 → 8/4; the 1280×1080 clips and godiva_close keep
theirs. The tables above stay as measured.

**6. Smaller ones.** The README's time column once showed time to the first frames instead of the total (corrected).
An early reading that longer temporal windows give steadier hair was overturned by three more plates.

### Deep input: 10- and 12-bit plates reach the model in full (1.0)

Film plates come as 10- or 12-bit ProRes 4444 / HEVC 4:4:4 or 16-bit image sequences. The original reads video
and PNG at 8 bits (OpenCV), so everything above 8 bits is rounded away before the model sees it. CorridorKey
Desktop can decode deep video to 16-bit RGB and read 16-bit PNG at full depth (8-bit sources take the same path
as before, unchanged). Since 2026-10-25 this is an opt-in per clip (Input precision, "Read 10/12-bit plates at 16
bits (differs from CorridorKey 2.0)"; the engine's `input_bit_depth`): by default every input is read exactly as
CorridorKey 2.0 reads it, byte for byte, so a comparison with the original starts from the same pixels.

Measured on 2026-10-24 on the 4K plate 04_5d (120 frames), encoded as 10-bit ProRes 4444 XQ and as 12-bit HEVC
4:4:4. The reference is the same plate decoded to 16-bit PNG frames (exactly the values the video holds), keyed by
the same engine; outputs as EXR, compared exactly (OpenCV float, every frame):

| Plate | Decode | Alpha MAE | Alpha max | Hair edges (alpha 0.02-0.98) off by > 1/255 | Foreground max | Total time (4K, 120 frames) |
| --- | --- | --- | --- | --- | --- | --- |
| ProRes 4444 XQ, 10-bit | 8-bit (before) | 6.5e-5 | 0.058 | 8.4 % | 0.214 | 148.6 s |
| ProRes 4444 XQ, 10-bit | **16-bit (now)** | **0** | **0** | **0 %** | **0** | 150.8 s |
| HEVC 4:4:4, 12-bit | 8-bit (before) | 6.3e-5 | 0.062 | 7.5 % | 0.278 | 150.9 s |
| HEVC 4:4:4, 12-bit | **16-bit (now)** | **0** | **0** | **0 %** | **0** | 152.2 s |

The 16-bit path gives exactly the matte of the 16-bit image sequence. The 8-bit read cost the most where keying is
hardest: about one hair-edge pixel in twelve was off, by up to 15 levels of 255. The deep decode costs no measurable
time: +1.5 % and +0.9 % in this run, −2.0 % and −1.4 % in a repeat run, so within run-to-run spread.

Reproduce it with `tools/bit_depth_bench.sh --old-engine <engine before 5a89777> --new-engine <engine>` (it makes the
plates, keys all six runs and compares them exactly; its header says how to build the old engine). Its repeat run gave
the same quality numbers to the last digit (8.42 % / 7.53 % of hair-edge pixels, 0 for both 16-bit decodes).

### EXR outputs a compositor can read as they are (1.0)

EXR outputs follow the studio convention, unlike the original's EXR writer: frames are named
`<clip>_<output>.<number>.exr` with the source's own frame numbers (a frame folder `04_5d_00065.exr` …
`04_5d_00184.exr` gives `04_5d_alpha.00065.exr` …; a video counts from 1001, the VFX convention), the matte-only EXR
stores the matte as the alpha channel `A` (the original writes it as `Y`, which Nuke reads as grey colour), and the
cutout is premultiplied (RGB × alpha, as EXR and Nuke expect; the original's is straight). `_settings.txt` records
the numbering. The video cutout is premultiplied too, without an alpha channel (see "Video outputs").

Checked on 2026-10-24 (CPU, a 10-frame 04_5d sequence and a 12-frame 12-bit ProRes clip, against the engine before
the change): OpenImageIO reports the matte file's single channel as its alpha channel; the matte values are
bit-identical to the old `Y` channel; the float cutout's colour equals the old straight colour × alpha exactly (half
float: within one or two half-float steps, the second rounding). OpenCV (4.11) and ffmpeg can't open an alpha-only
EXR; `tools/side_by_side.py` reads it with the `OpenEXR` Python package (`pip install OpenEXR`).

### Video outputs: lossless H.264, DNxHR 444 or H.264 CRF 12 (1.0)

The video outputs are display-referred (sRGB / Rec.709), 10-bit 4:4:4, encoded straight from the engine's 16-bit
render (no 8-bit step), in the codec chosen per clip: **lossless H.264** (libx264 at quantiser 0, High 4:4:4
Predictive; the default), **DNxHR 444** 10-bit (ffmpeg's own DNxHR encoder, in a .mov), or **H.264 CRF 12** (the
original's output, small files). On a Mac it is lossless H.264 for now; Apple's ProRes 4444 XQ comes with the Mac
work. ffmpeg's unlicensed ProRes encoder is not used. EXR stays the exact, scene-linear deliverable.

Measured on 2026-10-24 (RTX 5080, CUDA): each clip keyed once with EXR float output and once per codec, every video
decoded by ffmpeg to 16-bit and compared exactly with the EXR (`tools/matte_compare.py`; EXR read by OpenCV /
OpenEXR, its foreground display-encoded the same way). HD = walking_sitting, 1280×1080, 314 frames; 4K = the
04_5d plate, 4096×2160 scene-linear EXR, its first 48 frames. "Hair edges" = pixels where the EXR matte is between
0.02 and 0.98. Size per frame is the alpha + foreground files. Encode speed is ffmpeg alone with the engine's
arguments (2 threads per output, as the engine runs them) on the same 16-bit frames (rebuilt from the EXR run; the
DNxHR file it gave is identical to the engine's own: alpha difference 0).

| Codec | Clip | Alpha MAE | Alpha max | Pixels > 1/255 | Hair edges: MAE · > 1/255 | Foreground PSNR | Size per frame (alpha + fg) | Encode speed (alpha · fg) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Lossless H.264 | HD | 5.0e-5 | 6.1e-4 (0.16/255) | 0 % | 2.9e-4 · 0 % | 71.5 dB | 0.04 + 0.28 MB | 109 · 45 fps |
| Lossless H.264 | 4K | 3.0e-4 | 6.1e-4 (0.16/255) | 0 % | 2.9e-4 · 0 % | 66.1 dB | 0.27 + 12.3 MB | 16 · 1.5 fps |
| DNxHR 444 10-bit | HD | 6.5e-5 | 5.0e-3 (1.3/255) | 0.0001 % | 6.5e-4 · 0.0003 % | 65.9 dB | 1.22 + 1.22 MB | 146 · 102 fps |
| DNxHR 444 10-bit | 4K | 3.1e-4 | 4.9e-3 (1.3/255) | 0.00003 % | 5.6e-4 · 0.00002 % | 53.3 dB | 7.77 + 7.77 MB | 22 · 4.4 fps |
| H.264 CRF 12 | HD | 2.1e-4 | 0.084 (21/255) | 1.5 % | 6.4e-3 · 57 % | 51.2 dB | 0.004 + 0.015 MB | 129 · 75 fps |
| H.264 CRF 12 | 4K | 4.5e-4 | 0.070 (18/255) | 1.5 % | 3.9e-3 · 38 % | 42.3 dB | 0.03 + 1.80 MB | 14 · 2.1 fps |
| EXR float (the reference) | HD · 4K | | | | | | 0.58 + 12.6 MB · 2.96 + 98.7 MB | |

Lossless H.264 loses only the 10-bit rounding (YCbCr, video range): never more than 0.16/255 anywhere. DNxHR 444 stays
within 1.3/255 on the matte, with a handful of pixels above 1/255; its foreground loses more on the grainy 4K plate
(DNxHR has a fixed data rate per frame). CRF 12 puts more than half of the HD hair-edge pixels off by more than
1/255, up to 21/255. Lossless H.264 is the slowest to encode at 4K (1.5 frames/s for the foreground, against about one
4K frame per second for keying: 111-152 s per 120-frame plate, Speed); DNxHR encodes fastest. The whole jobs, one run each on a shared machine:
HD 56.4 s (EXR), 56.0 s (lossless), 55.7 s (DNxHR), 60.0 s (CRF 12); 4K 48 frames 60.1 s, 70.6 s, 60.0 s, 82.0 s.

DNxHR's pixel format: the encoder also takes RGB (gbrp10le). Encoded from the same frames, RGB had a lower matte MAE
(4.0e-5 HD, 4.2e-5 4K) with the same maximum (4.9e-3), and a better HD foreground (69.9 dB) but a worse 4K one
(49.2 against 53.3 dB). The engine keeps YCbCr 4:4:4 (yuv444p10le), the common DNxHR 444 flavour, which did better
on the harder film plate. The container is .mov: ffmpeg's MXF muxer refuses frame rates outside the broadcast set
(12.5 and 29.97 fps wrote nothing), and Resolve and Nuke read DNxHR in a .mov.

**The cutout:** none of these codecs carries an alpha channel (ffmpeg's DNxHR encoder has none and stops at 10 bits),
so the video cutout is the despilled colour premultiplied by the matte, in the file's own coding (sRGB, or linear with
the scene-linear option), and its alpha is the Alpha output, which a video job with a cutout always writes (the app
keeps it on; the engine adds it if asked without it and says so in the job's log). A compositor reads the pair as a
premultiplied image plus its matte. For an RGBA cutout in one file, use EXR (premultiplied RGBA). The original's
cutout was straight colour with alpha in ProRes 4444 from ffmpeg's ProRes encoder, which is no longer used.

### Colour management (OCIO) (1.0, engine)

CorridorKey's networks were trained on scene-linear Rec.709. A studio's plate is often in ACEScg, ACES2065-1 or a
camera's log space. The engine now has the real OpenColorIO library built in (2.5.2, the VFX Reference Platform's
2026 version), so a clip can be given in its own colour space: the engine converts it exactly to linear Rec.709
before the model sees it (negative values kept) and writes the EXR outputs back in that space. The alpha is data and
is never converted. The config is the job's own, else `$OCIO` (a studio's show config), else OCIO's built-in ACES
studio config, and `_settings.txt` records which one (its versioned name and cache id). The app's menus for it come
next; this version takes EXR and image sequences (colour-managed video comes after).

Measured on 2026-10-24 (docs/ENGINE_RUST.md "Colour" has the commands):

| Check | Result |
| --- | --- |
| Every colour space of the ACES studio config to linear Rec.709 and back (`ocio_roundtrip` test) | scene-linear spaces (18): within 3.3 float32 steps of the pixel's largest channel; log spaces (18): within 3.1e-4 of a 10-bit code |
| The engine's processors against PyOpenColorIO 2.5.2 (`tools/ocio_compare.py`, 1.8 M values each) | 110 of 110 bit-identical (55 spaces, both directions) |
| A studio config through `$OCIO`: a show LUT picked by `$SHOT`, a CDL | 6 of 6 bit-identical |
| Jobs without a colour space, against the engine before this change (EXR sequence, video) | every output byte-identical |
| 04_5d (8 frames) converted to ACEScg / ACES2065-1, keyed with that input space | 85.4 % of matte pixels identical; the rest differ by at most 1/256 (alpha MAE 2.4e-6, PSNR 90.9 dB) |
| The same, written back in ACEScg | foreground bit-identical to `ocioconvert` applied to the linear-Rec.709 key |
| Alpha with the output in linear Rec.709, ACEScg or ACEScct | byte-identical |
| The Windows engine's processors against Linux's (Wine, the same inputs) | 25 spaces byte-identical (every scene-linear one); 30 with a log or power curve within 7.5e-7 of the pixel's largest channel (the platforms' maths libraries round a few values differently) |

The keyed difference has one cause: converting a plate to ACEScg and back in float32 moves a few values across a
bfloat16 rounding step before the model (192 of 13.3 million input values here); the network spreads those tiny
changes over the frame. For scale, the original's own GPU mode differs from its full-precision mode by alpha MAE
5.0e-4, 200 times more.

Cost: converting a 4K frame (4096×2160) takes 10-12 ms on the way in and 3-6 ms per EXR colour output on the way out,
spread over this PC's 32 threads (Ryzen 9 9950X3D; 51-119 ms and 18-70 ms on one thread, depending on the colour
space), on the decoding and rendering threads that run beside the graphics card. On the 8-frame CPU test the job took
the same time with and without it (20.6-21.6 s against 21.5 s).

Two limits, stated plainly: the Windows numbers were measured under Wine on this PC, not yet on a real Windows
machine; and the engine always runs OCIO in its exact mode (LOSSLESS), which makes one rare case slow: a show LUT
used *inverted* as an input space (about 9 s per 4K frame in the test config). We keep exactness as the default and
will revisit if a real studio config needs it.

### Test it yourself

The clips are free to download (their owners don't allow re-hosting, so they aren't in this repository):

- **The six clips above:** [Hollywood Camera Work's green screen plates](http://www.hollywoodcamerawork.us/downloads.html)
  (© 2009 Hollywood Camera Work; free to use and post results, mention them).
- **4K plates (hair, glasses, green on green):** [Tears of Steel](https://mango.blender.org/production/4-tb-original-4k-footage-available-as-cc-by)
  original footage, 4096×2160 scene-linear OpenEXR from a Sony F65 (CC-BY 3.0, Blender Foundation). The shots we
  test with: [04_5h](https://media.xiph.org/mango/tearsofsteel-footage-exr/04_5h/linear/) (curly hair through
  glasses), [04_5d](https://media.xiph.org/mango/tearsofsteel-footage-exr/04_5d/linear/) (dreadlocks, curls,
  bright lamps), [08_3a](https://media.xiph.org/mango/tearsofsteel-footage-exr/08_3a/linear/) (wispy grey hair,
  a green prop against the green screen), [04_2c](https://media.xiph.org/mango/tearsofsteel-footage-exr/04_2c/linear/)
  (two actors, grey hair, low light); 120 frames from the middle of each.

Run both engines the same way with `tools/engine_bench.mjs` (it writes this table's numbers, `bench.md`):

```
node tools/engine_bench.mjs python --python <CorridorKey2.0>/venv/bin/python --script tools/reference/ck_engine.py \
  --package-root <CorridorKey2.0> --out out/pytorch --vram-budget 12 CLIP...
node tools/engine_bench.mjs rust --bin <corridorkey-engine> --models <models>/2.0.0-onnx.5 \
  --ort <runtime>/onnxruntime/capi/libonnxruntime.so.1.31.0 --env LD_LIBRARY_PATH=<runtime's library folders> \
  --device cuda --out out/rust --vram-budget 12 CLIP...
```

Then compare them: `tools/matte_compare.py` gives the numbers for whole clips, and `tools/side_by_side.py` the
pictures, for any two output folders (engines, versions, video or EXR): each frame's foreground and matte side by
side, a 20× difference image, crops of the spots you name, an optional side-by-side video, and the exact numbers.
It reads EXR as float and checks itself (the reference against itself must be zero) before writing anything:

```
python3 tools/side_by_side.py out/pytorch/<clip> out/rust/<clip> --out compare --labels Original Ours \
  --frames 72 --crop hair:2160,480,880,720 --video --open
```

## How it's tested

Every result in these notes is reproducible with the tools in this repository. The full run of 2026-10-24:

| Test | What it checks | Result |
| --- | --- | --- |
| `npm run check` | TypeScript types, formatting, the theme gate (colours only from one place), the loop gate (every loop, timer and wait in the app and engine carries a written verdict: 846 rows listed, 768 with a required verdict; plain Rust loops over small collections are exempt), 172 unit tests, the reference engine's protocol tests (`tools/reference/`) | pass |
| `npm run check:engine` | Rust formatting, clippy with every warning an error, 132 engine tests | pass |
| CPU end to end (`e2e_cpu.sh`) | the Rust engine against PyTorch, both fp32: frame folder, H.264 and hint inputs, EXR and video outputs, low-memory mode | pass: alpha MAE 1.7e-7, low-memory mode identical |
| GPU speed and quality, HD and 4K | `engine_bench.mjs` + `matte_compare.py`, ten clips, both engines | pass (the tables above) |
| Memory soak | an isolated copy keys the six HD clips three times in a row (18 jobs) while every process's memory is sampled every 5 s | pass: no growth (below) |
| Fresh install | an isolated copy with an empty data folder downloads the 4.9 GB runtime and models, is stopped partway and resumed, then finds the engine | pass |
| Windows, in a VM | install, setup, ffmpeg through winget, the 4.6 GB Windows download, adding a clip, uninstall (below) | pass (no keying: no NVIDIA card in the VM) |
| Single instance (`two_copies_e2e.sh`) | a second copy quits without touching the first copy's running job | pass |
| Self-update (`update_e2e.sh`) | an older AppImage updates itself from a signed local feed | not run this time: AppImages can't mount from inside the test session (FUSE); it passed on 2026-10-22 |
| Bug hunt + audit | every function and failure path in the new code given a verdict; 5 bugs found and fixed, each with a test | done |
| Leak and efficiency audit | everything that could grow per frame, per job or per state push, in the app and the engine | no leak found; its fixes are in |
| The original's pull requests | each open PR on CorridorKey 2.0 checked against this app (below) | one shared bug found and fixed (frame order) |

Test copies always run isolated: their own home folder, a headless compositor, a private D-Bus and a memory cap.
They never touch the desktop, its keyring or its settings.

### Memory soak (no leaks)

Three full queues of the six HD clips (18 jobs, all done) in one app session, sampled every 5 s:

| | Round 1 | Round 2 | Round 3 |
| --- | --- | --- | --- |
| Engine RAM, peak | 5,891 MB | 5,789 MB | 5,877 MB |
| Engine open files, max | 138 | 135 | 138 |
| Graphics memory, peak | 14.4 GB | 14.9 GB | 14.9 GB |
| After the round: app main / window / GPU process | 195 / 114 / 297 MB | 196 / 115 / 297 MB | 197 / 115 / 297 MB |
| After the round: graphics memory used | 2.89 GB | 2.81 GB | 2.85 GB |

The engine quits after every queue and gives all its memory back (it holds no graphics memory while the app is
idle); the app itself stays flat.

### Windows (virtual machine)

Windows 11 in a virtual machine without an NVIDIA card, driven like a user would (the installer, the window, file
dialogs):

| Step | Result |
| --- | --- |
| Installer: per user, no administrator, desktop shortcut | pass |
| First start opens the setup; Windows folders (`%LOCALAPPDATA%`) | pass |
| ffmpeg through `winget`, found without restarting the app | pass |
| The first-run download (4.6 GB, the Windows packages): every byte, temp files cleaned | pass |
| Adding a clip: thumbnail and details read through ffmpeg | pass |
| Uninstall: asks first, then removes the app, the 6 GB of data and the settings; clips untouched | pass |
| Keying on an NVIDIA card | not tested (no NVIDIA card in the VM) |

## The original's open pull requests

We follow [CorridorKey 2.0's pull requests](https://github.com/nikopueringer/CorridorKey2.0/pulls) and check each one
against this app's own engine. As of the evening of 2026-10-24:

| PR | What it fixes in the original | In CorridorKey Desktop |
| --- | --- | --- |
| [#4](https://github.com/nikopueringer/CorridorKey2.0/pull/4) | Frame folders read in text order (`f_1, f_10, f_2`), and `.PNG`/`.EXR` in capitals not found on Linux | **Had the same bug; fixed.** Natural order (`f_2` before `f_10`) and any extension case, in the engine and the app, with tests |
| [#11](https://github.com/nikopueringer/CorridorKey2.0/pull/11) | The automatic memory window runs out of graphics memory on a first run (RTX 5090, 2048×1152) | **Handled differently.** The engine caps ONNX Runtime's memory to the budget and, if an automatic window still runs out before any frame is written, halves it and restarts (up to ~7 times). No retry was needed in any run here; not tested on a 32 GB card |
| [#9](https://github.com/nikopueringer/CorridorKey2.0/pull/9) | Halves the original's graphics memory (bf16 weights, no gradients), same output | **Not needed:** the engine already runs fp16 weights. If it is merged, the original's memory numbers in the Speed tables will drop; we will re-measure |
| [#8](https://github.com/nikopueringer/CorridorKey2.0/pull/8) | A desktop GUI (Qt) on top of the original's Python pipeline | A different approach: this app installs itself and runs its own engine, no Python |
| [#10](https://github.com/nikopueringer/CorridorKey2.0/pull/10), [#6](https://github.com/nikopueringer/CorridorKey2.0/pull/6), [#7](https://github.com/nikopueringer/CorridorKey2.0/pull/7) | Apple Silicon (MPS), AMD (ROCm) support | **macOS (Apple Silicon) is part of 1.0**, on ONNX Runtime's Core ML backend instead of PyTorch's MPS. AMD isn't in 1.0; it would use ONNX Runtime's MIGraphX (Linux) or DirectML (Windows) build |
| [#13](https://github.com/nikopueringer/CorridorKey2.0/pull/13) | Attention runs out of memory on GPUs without fused attention kernels (AMD RX 5700 XT): the math fallback builds the whole score matrix at once | **Not on NVIDIA:** the engine runs ONNX Runtime's CUDA kernels. The same question matters for the Core ML engine (Apple GPUs); its design includes attention in bounded chunks, to be measured on the Mac |
| [#3](https://github.com/nikopueringer/CorridorKey2.0/pull/3), [#14](https://github.com/nikopueringer/CorridorKey2.0/pull/14) | Python version requirements; dependency management with uv | Not applicable (no Python) |

## Built with

Every third-party part, with its licence and full licence text, is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the people and models behind it are in [docs/CREDITS.md](docs/CREDITS.md).
The main pieces:

| Part | Technology |
| --- | --- |
| The model | [CorridorKey 2.0](https://github.com/nikopueringer/CorridorKey2.0) by Corridor Digital (designed and trained by Zachary Harris), on the foundation models C-RADIO (NVIDIA), MoGe (Microsoft) and RVM (Google DeepMind); exported to ONNX at fp16, unchanged |
| Engine | Rust 1.93, [ONNX Runtime](https://onnxruntime.ai) 1.31 (through the `ort` crate), OpenColorIO 2.5 (built in), `exr` and `image` for frames, `rayon` for CPU work |
| Graphics card | NVIDIA CUDA 13.4 and cuDNN 9.27 (Linux, Windows), optional TensorRT 10.16 (Linux), Apple Core ML (macOS, in progress) |
| App | Electron 45, React 18, TypeScript 5.9, Vite 7 with electron-vite, Lucide icons |
| Video in and out | ffmpeg from the system (libx264 10-bit, DNxHR) |
| Packaging | electron-builder: AppImage (Linux), NSIS installer (Windows), signed and notarized disk image (macOS); the Linux engine linked for glibc 2.28 with Zig (cargo-zigbuild), the Windows engine cross-built with MinGW-w64, the installer built through Wine |
| Updates | Signed update feeds (Ed25519), checked by the app before it installs anything |
| Checks | Vitest, Rust's own tests and clippy, Prettier, and the project's own gates (loops, theme colours, Electron security) |

## Why it's built this way

- **Rust + ONNX Runtime instead of Python + PyTorch:** the tables above. One program (9.6 MB, with OpenColorIO built in) with no Python,
  half the RAM, less graphics memory, about 1.5-1.9× faster (the same-day pair of 2026-10-26), same mattes.
- **fp16 on the graphics card:** the original runs bf16; fp16 is what NVIDIA's tensor cores and ONNX Runtime's CUDA
  kernels do fastest, and the Quality table shows it agrees with the original as closely as the original's own
  modes agree with each other.
- **The engine inside the app, built for glibc 2.28:** it runs on any Linux that Electron itself runs on (Ubuntu
  20.04 on, Debian 10 on, every current Fedora and Arch), not only on the machine that built it.
- **The runtime from PyPI, the models from this repository:** the app downloads the official ONNX Runtime and
  NVIDIA library packages directly, pinned by size and SHA-256, so nothing third-party is re-hosted; the converted
  models are published here under the CorridorKey licence. Every file is checked before it is used.
- **ffmpeg from the system, not bundled:** every Linux distribution ships it; the app checks it has the encoders it
  needs (libx264 with 10-bit, and DNxHR on Linux and Windows) and offers the install where it can.
- **The original kept as the reference, outside the app:** the app runs only the Rust engine; the comparison tools
  (`tools/vs_original.sh`, `tools/engine_bench.mjs`) run Corridor's original from its own checkout and venv, so every
  speed and quality claim here can be checked against it on the same machine.

## Uninstall

CorridorKey writes only these folders (plus the results you ask for, next to your clips or in the folder you chose):

| What | Linux | Windows | macOS |
| --- | --- | --- | --- |
| The app | the AppImage you downloaded (and, after updates, the previous version next to it) | the install folder (Apps & features) | `CorridorKey.app` in Applications |
| GPU runtime and models (a 4.03 GB download on Linux, 3.81 GB on Windows, 5.74 GB on macOS, once; more on disk, as the runtime is unpacked: Install size) | `~/.local/share/corridorkey-desktop` | `%LOCALAPPDATA%\corridorkey-desktop` | `~/Library/Application Support/corridorkey-desktop` |
| Thumbnails, stills, job temp files | `~/.cache/corridorkey-desktop` | `%LOCALAPPDATA%\corridorkey-desktop\cache` | `~/Library/Caches/corridorkey-desktop` |
| Settings (a few KB) | `~/.config/corridorkey-desktop` | `%APPDATA%\corridorkey-desktop` | `~/Library/Application Support/corridorkey-desktop` (with the data) |

- **App settings → Storage** shows each folder's real size and removes the runtime, the models or the cache (it asks
  first; the setup downloads them again when needed). On Linux, TensorRT is its own item: its libraries and models
  (inside the data folder, about 6.1 GB) and the engines built for your card (`~/.cache/corridorkey-desktop/tensorrt`).
- The cache cleans itself: stills older than 30 days go, and it never grows past 500 MB. Job temp files are removed
  when a job ends, and anything left by a crash at the next start.
- **Windows:** uninstalling from Apps & features asks whether to remove the downloaded runtime, models, cache and
  settings too.
- **Linux:** delete the AppImage, then the three folders above.
- **macOS:** move CorridorKey to the Bin, then delete its two folders above (Finder: Go → Go to Folder…).

## Develop

```
npm install
npm run dev
npm run check
```

