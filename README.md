# CorridorKey Desktop

A free desktop app for [CorridorKey 2.0](https://github.com/nikopueringer/CorridorKey2.0),
Corridor Digital's AI green-screen keyer (model by Zachary Harris). Drop clips in, pick a hint
mode and outputs, and watch real progress: frames written, the temporal window the runtime
chose from your free graphics memory, and stills of the results.

Status: in development, Linux first.

## Requirements

- An NVIDIA graphics card (RTX 30-series or newer) and `ffmpeg`.
- Nothing else to set up: the engine comes with the app, and on first start the Engine page downloads
  the GPU runtime and the CorridorKey models (4.5 GB, once). If `ffmpeg` is missing, it offers to install it.

## Install size

Less than half the disk space of the original CorridorKey 2.0 setup (measured on the same PC, 2026-10-24):

| Part | CorridorKey Desktop | Original CorridorKey 2.0 |
|---|---|---|
| App / code | **131 MB** (AppImage, engine inside) | 3 MB (Python scripts) |
| Runtime | **~2.3 GB**: ONNX Runtime + CUDA/cuDNN | **~7.1 GB** Python venv: PyTorch 1.7 GB, NVIDIA libraries 4.3 GB, Triton 0.6 GB, other packages |
| Models | **~3.1 GB** (fp16) | **~4.8 GB**: CorridorKey weights 2.5 GB + foundation models 2.3 GB |
| **Total** | **~5.5 GB** | **~11.9 GB** |
| Setup | Download one file; the app fetches the rest itself | Install Python, create a venv, pip install, run a download script |

PyTorch's environment carries NVIDIA libraries the ONNX Runtime engine never uses (NCCL and
cuSPARSELt, for multi-GPU and training), and the fp16 models are a third smaller.

## Speed

The same clips through the original CorridorKey 2.0 (PyTorch, its shipping bf16 mode) and CorridorKey
Desktop's engine (Rust + ONNX Runtime, fp16, model set `2.0.0-onnx.3`), with the same settings: 12 GB graphics
memory budget, automatic temporal window (both picked the same one), alpha + foreground outputs, no hint.
Total = engine start to finish. Memory = peak of the engine's processes. Measured 2026-10-24 on an RTX 5080
(driver 615.71.09), Ryzen 9 9950X3D, Kubuntu 26.04.

| Clip | Original | CorridorKey Desktop | Faster | Graphics memory | RAM |
|---|---|---|---|---|---|
| godiva_close 960×720, 349 frames | 61.1 s | **39.6 s** | 1.54× | 9.37 → 9.15 GB | 9.45 → 5.38 GB |
| locked_backdrop 1280×1080, 80 frames | 31.3 s | **19.5 s** | 1.61× | 11.97 → 8.07 GB | 9.23 → 5.15 GB |
| metal_glasses 1280×1080, 139 frames | 42.3 s | **26.7 s** | 1.58× | 11.97 → 8.07 GB | 9.92 → 5.47 GB |
| smoke 1280×1080, 250 frames | 74.7 s | **46.8 s** | 1.60× | 11.97 → 8.25 GB | 11.29 → 5.82 GB |
| walking_sitting 1280×1080, 314 frames | 91.5 s | **56.1 s** | 1.63× | 11.97 → 8.13 GB | 11.44 → 5.88 GB |
| with_motion_blur 1280×1080, 50 frames | 20.8 s | **11.4 s** | 1.82× | 12.03 → 9.44 GB | 8.86 → 3.70 GB |

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
