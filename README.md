# CorridorKey Desktop

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

On my RTX 5080 it keys 4K at about two frames a second: 2.4-2.7× faster than the original on the same machine
(1.5-1.8× at HD), with the same mattes, less graphics memory and RAM, and less than half the install. Every number
is below, with the clips and the commands to check them yourself. On Linux, an optional TensorRT mode takes HD to
about 2× the original's speed. Rust and ONNX Runtime also mean one engine for every platform: NVIDIA on Linux and
Windows, and Apple Silicon through Core ML.

It's free, it stays free, and it's Corridor's model. Huge thanks to Niko, Zachary Harris and the Corridor crew.
Windows testers wanted: see Requirements.

Marcy ([MarcelineVPQ](https://github.com/MarcelineVPQ))

## What it is

A free desktop app for [CorridorKey 2.0](https://github.com/nikopueringer/CorridorKey2.0),
Corridor Digital's AI green-screen keyer (model by Zachary Harris). Drop clips in, pick a hint
mode and outputs, and watch real progress: frames written, the temporal window the runtime
chose from your free graphics memory, and stills of the results.

Status: 1.0 is almost ready, for Linux, Windows and macOS (Apple Silicon).

## Requirements

- Linux (the AppImage) or Windows 10/11 (the installer), x64, with an NVIDIA graphics card (RTX 30-series or newer).
- macOS 14 or newer on Apple Silicon (M1 or newer; the disk image). Intel Macs aren't supported.
- Nothing else to set up: the engine comes with the app, and on first start the setup downloads the GPU runtime and
  the CorridorKey models (a 4.9 GB download on Linux and Windows, about 3.3 GB on macOS, once). If `ffmpeg` is
  missing, it offers to install it (apt or pacman on Linux, `winget` on Windows, Homebrew on macOS).
- Optional, Linux: **TensorRT** (Engine settings, TensorRT; off by default) for about 2× the original's speed at HD
  with the same mattes (Speed, 0.0.6-dev). Switching it on offers its own download: NVIDIA's TensorRT 10.16
  libraries (3.7 GB, from pypi.nvidia.com) and the TensorRT models (3.1 GB, from this repository's releases; C-RADIO's
  weights are copied from the models you already have), 6.9 GB in all, 7.5 GB on disk. The first job at each
  resolution optimizes for it once (about 2.5 minutes for the five networks on an RTX 5080); 4K still runs on CUDA.
  Best on 16 GB cards: where a network can't be built (stage 1 at 80-frame windows), that network runs on CUDA and
  the job's log says so. Windows needs its own TensorRT builder (a later version); macOS has no TensorRT.

**Windows, first start:** the installer isn't code-signed yet, so Windows SmartScreen shows "Windows protected
your PC" the first time. Click **More info**, then **Run anyway**. It's asked once; signing comes later.

**Windows, honestly:** the Windows build is tested in a Windows 11 virtual machine: it installs, opens, runs its setup
(the downloads, ffmpeg through winget) and works through its pages. That machine has no NVIDIA graphics card, so
**keying on an NVIDIA card under Windows has not been tested yet**: we don't have a real Windows PC with one. Every
speed and quality number in this README was measured on Linux. If you try it on Windows, please tell us how it goes.

**macOS, honestly:** a great many VFX artists work on Macs, so macOS is part of 1.0. The app runs on Apple Silicon,
with the engine on ONNX Runtime's Core ML backend (Apple's GPU and Neural Engine), and it's built, installed and
driven page by page on GitHub's Apple Silicon runners. The Core ML engine is in progress: all five networks reach
full Core ML coverage after exact graph rewrites; the Core ML provider comes next. GitHub's runners are virtual machines without
the GPU or the Neural Engine, so **Mac keying is measured on a real Apple Silicon Mac** (an M6 Mac mini,
`tools/mac_gate.sh`: mattes against CUDA and speed); 1.0 includes macOS only if that gate passes. The disk image is signed (Developer ID) and notarized by Apple: Gatekeeper accepts it as "Notarized Developer ID".

## Install size

Less than half the disk space of the original CorridorKey 2.0 setup (measured on the same PC, 2026-10-24, in
decimal GB: `du --si`):

| Part | CorridorKey Desktop | Original CorridorKey 2.0 |
| --- | --- | --- |
| App / code | **131 MB** (AppImage, engine inside) | 3 MB (Python scripts) |
| Runtime | **2.4 GB**: ONNX Runtime + CUDA/cuDNN (a 1.6 GB download) | **7.6 GB** Python venv: PyTorch, NVIDIA libraries, Triton, other packages |
| Models | **3.3 GB** (fp16) | **5.1 GB**: CorridorKey weights 2.7 GB + foundation models 2.4 GB |
| **Total** | **5.9 GB** | **12.6 GB** |
| Setup | Download one file; the app fetches the rest itself (4.9 GB) | Install Python, create a venv, pip install, run a download script |

PyTorch's environment carries NVIDIA libraries the ONNX Runtime engine never uses (NCCL and
cuSPARSELt, for multi-GPU and training), and the fp16 models are a third smaller.

## Speed

The same clips through the original CorridorKey 2.0 and CorridorKey Desktop's engine, on the same machine, back to
back, with the same settings. Measured 2026-10-24 with `tools/engine_bench.mjs`.

**Test machine and software**

| | |
| --- | --- |
| Graphics card | NVIDIA GeForce RTX 5080, 16 GB, driver 615.71.09 |
| Processor, memory | AMD Ryzen 9 9950X3D (16 cores), 60 GB RAM |
| System | Kubuntu 26.04, Linux 7.0.0, KDE Plasma (Wayland) |
| Original CorridorKey 2.0 | PyTorch 2.9.1 (CUDA 12.8, cuDNN 9.10), Python 3.12, its shipping mode: bf16 autocast |
| CorridorKey Desktop | Rust engine on ONNX Runtime 1.31.0 (CUDA 13.4, cuDNN 9.27), fp16, model set `2.0.0-onnx.3`: the engine and GPU runtime the app ships and downloads |

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

The same HD bench, run on different days as the engine improved (totals, seconds; Original = PyTorch):

| Clip | 2026-10-21 Original | **0.0.1-dev** 2026-10-21, first Rust engine (`onnx.1`) | **0.0.2-dev** 2026-10-21, after the speed work (`onnx.2`), two runs | 2026-10-24 Original | **0.0.3-dev** 2026-10-24, CorridorKey Desktop (`onnx.3`, as shipped in 1.0) |
| --- | --- | --- | --- | --- | --- |
| godiva_close | 68.4 | 54.9 | 39.7 / 42.7 | 61.1 | **39.6** |
| locked_backdrop | 40.3 | 36.9 | 20.6 / 21.9 | 31.3 | **19.5** |
| metal_glasses | 44.7 | 55.5 | 30.0 / 29.9 | 42.3 | **26.7** |
| smoke | 76.5 | 96.8 | 51.8 / 51.7 | 74.7 | **46.8** |
| walking_sitting | 94.2 | 116.2 | 63.2 / 63.1 | 91.5 | **56.1** |
| with_motion_blur | 19.0 | 22.7 | 12.4 / 12.3 | 20.8 | **11.4** |

- The straight port (0.0.1-dev) was *slower* than the original on four of six clips. The speed came from measuring
  where the time went and rewriting those parts of the graphs exactly (same output): window padding, the depatchify
  step, grouped 7×7 convolutions, and keeping memory pools warm between calls (docs/ENGINE_RUST.md, "Speed").
- Two runs of the same build agree within 1 % on four clips, 6 % on locked_backdrop and 8 % on godiva_close. The
  original varied more between days (godiva 68.4 → 61.1 s), so every comparison here is a back-to-back pair on the
  same day.

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

## Quality: the same mattes

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

These differences are fp16 against bf16 rounding. With both engines in full precision (fp32, on the processor,
`engine-rs/tools/e2e_cpu.sh`), the mattes are the same to within rounding: alpha MAE 1.7e-7, max 6.9e-5, no pixel
off by even 1/255, foreground PSNR 102.6 dB; the low-memory mode matches the normal one exactly (difference 0).

### Deep input: 10- and 12-bit plates reach the model in full (1.0)

Film plates come as 10- or 12-bit ProRes 4444 / HEVC 4:4:4 or 16-bit image sequences. The original reads video
and PNG at 8 bits (OpenCV), so everything above 8 bits is rounded away before the model sees it. CorridorKey
Desktop now decodes deep video to 16-bit RGB and reads 16-bit PNG at full depth (8-bit sources take the same path
as before, unchanged).

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
the numbering. The video cutout (ProRes 4444) stays straight, as that format carries it.

Checked on 2026-10-24 (CPU, a 10-frame 04_5d sequence and a 12-frame 12-bit ProRes clip, against the engine before
the change): OpenImageIO reports the matte file's single channel as its alpha channel; the matte values are
bit-identical to the old `Y` channel; the float cutout's colour equals the old straight colour × alpha exactly (half
float: within one or two half-float steps, the second rounding). OpenCV (4.11) and ffmpeg can't open an alpha-only
EXR; `tools/side_by_side.py` reads it with the `OpenEXR` Python package (`pip install OpenEXR`).

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
node tools/engine_bench.mjs python --python <CorridorKey2.0>/venv/bin/python --script engine/ck_engine.py \
  --package-root <CorridorKey2.0> --out out/pytorch --vram-budget 12 CLIP...
node tools/engine_bench.mjs rust --bin <corridorkey-engine> --models <models>/2.0.0-onnx.3 \
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

Every result in this README is reproducible with the tools in this repository. The full run of 2026-10-24:

| Test | What it checks | Result |
| --- | --- | --- |
| `npm run check` | TypeScript types, formatting, the theme gate (colours only from one place), the loop gate (every loop, timer and wait in the app and engine carries a written verdict: 793 rows listed, 723 with a required verdict; plain Rust loops over small collections are exempt), 172 unit tests, the PyTorch engine's own tests | pass |
| `npm run check:engine` | Rust formatting, clippy with every warning an error, 119 engine tests | pass |
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

## Why it's built this way

- **Rust + ONNX Runtime instead of Python + PyTorch:** the tables above. One small program (3.8 MB) with no Python,
  half the RAM, less graphics memory, 1.5-2.7× faster, same mattes.
- **fp16 on the graphics card:** the original runs bf16; fp16 is what NVIDIA's tensor cores and ONNX Runtime's CUDA
  kernels do fastest, and the Quality table shows it agrees with the original as closely as the original's own
  modes agree with each other.
- **The engine inside the app, built for glibc 2.28:** it runs on any Linux that Electron itself runs on (Ubuntu
  20.04 on, Debian 10 on, every current Fedora and Arch), not only on the machine that built it.
- **The runtime from PyPI, the models from this repository:** the app downloads the official ONNX Runtime and
  NVIDIA library packages directly, pinned by size and SHA-256, so nothing third-party is re-hosted; the converted
  models are published here under the CorridorKey licence. Every file is checked before it is used.
- **ffmpeg from the system, not bundled:** every Linux distribution ships it; the app checks it has the encoders it
  needs (H.264 and ProRes 4444) and offers the install where it can.
- **The original kept as the reference:** the PyTorch engine stays in the app (Engine page), so every speed and
  quality claim here can be checked against it on the same machine.

## Uninstall

CorridorKey writes only these folders (plus the results you ask for, next to your clips or in the folder you chose):

| What | Linux | Windows | macOS |
| --- | --- | --- | --- |
| The app | the AppImage you downloaded (and, after updates, the previous version next to it) | the install folder (Apps & features) | `CorridorKey.app` in Applications |
| GPU runtime and models (~5.7 GB; ~3.3 GB on macOS) | `~/.local/share/corridorkey-desktop` | `%LOCALAPPDATA%\corridorkey-desktop` | `~/Library/Application Support/corridorkey-desktop` |
| Thumbnails, stills, job temp files | `~/.cache/corridorkey-desktop` | `%LOCALAPPDATA%\corridorkey-desktop\cache` | `~/Library/Caches/corridorkey-desktop` |
| Settings (a few KB) | `~/.config/corridorkey-desktop` | `%APPDATA%\corridorkey-desktop` | `~/Library/Application Support/corridorkey-desktop` (with the data) |

- **App settings → Storage** shows each folder's real size and removes the runtime, the models or the cache (it asks
  first; the setup downloads them again when needed). On Linux, TensorRT is its own item: its libraries and models
  (inside the data folder, about 7.5 GB) and the engines built for your card (`~/.cache/corridorkey-desktop/tensorrt`).
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

## Licence and credits

CorridorKey is © Corridor Digital, under the CorridorKey licence (see LICENSE). This app is
free and stays free. Organisations with more than US $20M annual revenue need CorridorKey
plugin seats ([corridorkey.com](https://corridorkey.com)). Foundation models: C-RADIO (NVIDIA),
MoGe (Microsoft), RVM (Google DeepMind); see the CorridorKey repository's notices.

Built by Marcy ([MarcelineVPQ](https://github.com/MarcelineVPQ)) at 42 Pixel Studios.
