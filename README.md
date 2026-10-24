# CorridorKey Desktop

A free desktop app for [CorridorKey 2.0](https://github.com/nikopueringer/CorridorKey2.0),
Corridor Digital's AI green-screen keyer (model by Zachary Harris). Drop clips in, pick a hint
mode and outputs, and watch real progress: frames written, the temporal window the runtime
chose from your free graphics memory, and stills of the results.

Status: in development, Linux first.

## Requirements

- An NVIDIA graphics card (RTX 30-series or newer) and `ffmpeg`.
- A CorridorKey2.0 checkout set up as its README describes (Python venv, weights). The app
  asks for that folder on first start.

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
