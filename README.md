# CorridorKey Desktop

## Why this exists

On 21 October 2026 Corridor Crew released [CorridorKey 2.0](https://github.com/nikopueringer/CorridorKey2.0)
([the launch video](https://www.youtube.com/watch?v=svrdRAoIlxM)). I watched the whole video and purchased CK2.0
straight away from [corridorkey.com](https://corridorkey.com) (their app and plugins for Resolve, Nuke, After Effects,
Premiere and Blender), and only after paying did I see that Linux isn't supported yet. In the same video, Niko says
it's "still pretty heavy on the GPU right now": about one frame a second at full native 4K, on an RTX 5090.

I'm an audio/video engineer. Timing, throughput, color and what a signal costs are my day job, and so is software.
This was the perfect crossroads between the two. I've moved PyTorch projects to Rust and ONNX Runtime before, so I
knew there were gains to be found. I took Corridor's model, gave it a new engine (Rust on ONNX Runtime, no Python),
and wrapped it in a desktop app that installs itself.

On my RTX 5080 it keys 4K at about two frames a second: 2.4-2.7× faster than the original on the same machine
(1.5-1.8× at HD), with the same mattes, less graphics memory and RAM, and less than half the install. Every number
is below, with the clips and the commands to check them yourself. TensorRT is next, for more speed still. Rust and ONNX Runtime
also mean one engine for every platform: NVIDIA on Linux and Windows today, and Apple Silicon through Core ML next.

It's free, it stays free, and it's Corridor's model. Huge thanks to Niko, Zachary Harris and the Corridor crew.
Windows testers wanted: see Requirements.

Marcy ([MarcelineVPQ](https://github.com/MarcelineVPQ))

## What it is

A free desktop app for [CorridorKey 2.0](https://github.com/nikopueringer/CorridorKey2.0),
Corridor Digital's AI green-screen keyer (model by Zachary Harris). Drop clips in, pick a hint
mode and outputs, and watch real progress: frames written, the temporal window the runtime
chose from your free graphics memory, and stills of the results.

Status: 1.0 is almost ready (Linux and Windows); macOS is planned next.

## Requirements

- Linux (the AppImage) or Windows 10/11 (the installer), x64, with an NVIDIA graphics card (RTX 30-series or newer).
- Nothing else to set up: the engine comes with the app, and on first start the setup downloads the GPU runtime and
  the CorridorKey models (a 4.9 GB download, once). If `ffmpeg` is missing, it offers to install it (apt or pacman on
  Linux, `winget` on Windows).

**Windows, honestly:** the Windows build is tested in a Windows 11 virtual machine: it installs, opens, runs its setup
(the downloads, ffmpeg through winget) and works through its pages. That machine has no NVIDIA graphics card, so
**keying on an NVIDIA card under Windows has not been tested yet**: we don't have a real Windows PC with one. Every
speed and quality number in this README was measured on Linux. If you try it on Windows, please tell us how it goes.

**macOS is planned next.** A great many VFX artists work on Macs. The plan: Apple Silicon, with the engine on ONNX
Runtime's Core ML backend (Apple's GPU and Neural Engine) and a signed `.dmg`, built and tested on real Apple
Silicon machines (GitHub's macOS runners).

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

The same clips through the original CorridorKey 2.0 (PyTorch, its shipping bf16 mode) and CorridorKey
Desktop's engine (Rust + ONNX Runtime, fp16, model set `2.0.0-onnx.3`; the engine and GPU runtime the app ships),
one engine process per clip, with the same settings: 12 GB graphics memory budget, automatic temporal window
(both engines picked the same one every time), alpha + foreground outputs, no hint. Measured 2026-10-24 on an
RTX 5080 (driver 615.71.09), Ryzen 9 9950X3D, Kubuntu 26.04, with `tools/engine_bench.mjs`.

- **Total**: engine start to exit (the number that matters).
- **First frames**: start until the first frames are written (model load + the first temporal window).
- **Steady**: frames per second after the first window, as the engine reports them.
- **Memory**: peak of the engine's processes (graphics memory from nvidia-smi, RAM from `/proc`, sampled every
  250 ms), in GiB.

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

## How it's tested

Every result above is reproducible with the tools in this repository. The full run of 2026-10-24:

| Test | What it checks | Result |
| --- | --- | --- |
| `npm run check` | TypeScript types, formatting, the theme gate (colours only from one place), the loop gate (every loop, timer and wait carries a written verdict: 621 rows), 131 unit tests, the PyTorch engine's own tests | pass |
| `npm run check:engine` | Rust formatting, clippy with every warning an error, 66 engine tests | pass |
| CPU end to end (`e2e_cpu.sh`) | the Rust engine against PyTorch, both fp32, frame folder + H.264 + hint inputs, EXR + video outputs, low-memory mode | pass (numbers in Quality) |
| GPU speed + quality, HD and 4K | `engine_bench.mjs` + `matte_compare.py`, ten clips, both engines | pass (the tables above) |
| Fresh install | an isolated copy with an empty data folder downloads the 4.9 GB runtime and models, is stopped partway and resumed, then finds the engine | pass |
| Single instance (`two_copies_e2e.sh`) | a second copy quits without touching the first copy's running job | pass |
| Self-update (`update_e2e.sh`) | an older AppImage updates itself from a signed local feed | not run this time: AppImages can't mount from inside the test session (FUSE); it passed on 2026-10-22 |
| Bug hunt + audit | every function and failure path in the new code given a verdict; 5 bugs found and fixed, each with a test | done |

Test copies always run isolated: their own home folder, a headless compositor, a private D-Bus and a memory cap.
They never touch the desktop, its keyring or its settings.

## The original's open pull requests

We follow [CorridorKey 2.0's pull requests](https://github.com/nikopueringer/CorridorKey2.0/pulls) and check each one
against this app's own engine. As of 2026-10-24:

| PR | What it fixes in the original | In CorridorKey Desktop |
| --- | --- | --- |
| [#4](https://github.com/nikopueringer/CorridorKey2.0/pull/4) | Frame folders read in text order (`f_1, f_10, f_2`), and `.PNG`/`.EXR` in capitals not found on Linux | **Had the same bug; fixed.** Natural order (`f_2` before `f_10`) and any extension case, in the engine and the app, with tests |
| [#11](https://github.com/nikopueringer/CorridorKey2.0/pull/11) | The automatic memory window runs out of graphics memory on a first run (RTX 5090, 2048×1152) | **Handled differently.** The engine caps ONNX Runtime's memory to the budget and, if an automatic window still runs out before any frame is written, halves it and restarts (up to ~7 times). No retry was needed in any run here; not tested on a 32 GB card |
| [#9](https://github.com/nikopueringer/CorridorKey2.0/pull/9) | Halves the original's graphics memory (bf16 weights, no gradients), same output | **Not needed:** the engine already runs fp16 weights. If it is merged, the original's memory numbers in the Speed tables will drop; we will re-measure |
| [#8](https://github.com/nikopueringer/CorridorKey2.0/pull/8) | A desktop GUI (Qt) on top of the original's Python pipeline | A different approach: this app installs itself and runs its own engine, no Python |
| [#10](https://github.com/nikopueringer/CorridorKey2.0/pull/10), [#6](https://github.com/nikopueringer/CorridorKey2.0/pull/6), [#7](https://github.com/nikopueringer/CorridorKey2.0/pull/7) | Apple Silicon (MPS), AMD (ROCm) support | Not in 1.0: NVIDIA only. **macOS (Apple Silicon) is planned next**, on ONNX Runtime's Core ML backend; AMD would need ONNX Runtime's ROCm or MIGraphX build |
| [#3](https://github.com/nikopueringer/CorridorKey2.0/pull/3) | Python version requirements | Not applicable (no Python) |

## Why it's built this way

- **Rust + ONNX Runtime instead of Python + PyTorch:** the tables above. One small program (3.6 MB) with no Python,
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

| What | Linux | Windows |
| --- | --- | --- |
| The app | the AppImage you downloaded (and, after updates, the previous version next to it) | the install folder (Apps & features) |
| GPU runtime and models (~5.7 GB) | `~/.local/share/corridorkey-desktop` | `%LOCALAPPDATA%\corridorkey-desktop` |
| Thumbnails, stills, job temp files | `~/.cache/corridorkey-desktop` | `%LOCALAPPDATA%\corridorkey-desktop\cache` |
| Settings (a few KB) | `~/.config/corridorkey-desktop` | `%APPDATA%\corridorkey-desktop` |

- **App settings → Storage** shows each folder's real size and removes the runtime, the models or the cache (it asks
  first; the setup downloads them again when needed).
- The cache cleans itself: stills older than 30 days go, and it never grows past 500 MB. Job temp files are removed
  when a job ends, and anything left by a crash at the next start.
- **Windows:** uninstalling from Apps & features asks whether to remove the downloaded runtime, models, cache and
  settings too.
- **Linux:** delete the AppImage, then the three folders above.

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
