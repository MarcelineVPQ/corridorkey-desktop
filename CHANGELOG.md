# Changelog

## 1.0.0

The first release: a free Linux desktop app for CorridorKey 2.0, Corridor Digital's AI green and blue
screen keyer, on its own Rust + ONNX Runtime engine.

- First app: clip queue (videos, frame folders, batch folders, companion hints found next to
  clips), per-clip hint/output/memory settings, one engine process for the queue, live progress
  from the engine (stages, frames, measured speed, the memory window used), result stills,
  errors with the engine's output, cancel.
- The CorridorKey engine in Rust on ONNX Runtime (CUDA, fp16), inside the app: 1.5-1.8× faster
  than the PyTorch version on every HD test clip and 2.4-2.7× faster on 4K (RTX 5080; README, Speed),
  using less graphics memory and RAM, with the same mattes (README, Quality); portrait clips
  work (model set `2.0.0-onnx.3`). The PyTorch engine stays available as the reference.
- A setup screen on first start: three steps, each ticked when done (download the runtime and
  models, ffmpeg, add your first clip). Engine, Open the setup brings it back.
- Installs itself: the setup downloads the GPU runtime (ONNX Runtime and
  NVIDIA's CUDA / cuDNN libraries, from PyPI) and the CorridorKey models (from this repository's
  releases), a 4.9 GB download once, with progress, stop and resume, every file SHA-256 checked. The whole
  install is less than half the original CorridorKey 2.0 setup (README, Install size).
- The Engine page lists what it finds (Automatic = the newest) with Browse… for anything else, and
  checks ffmpeg: if it's missing, it offers to install it (apt, pacman) or says what to enable.
- Updates: the AppImage updates itself from signed Stable / Development feeds (signature, size
  and SHA-512 checked; installs beside the running copy, the previous version kept; never a
  downgrade except Back to stable). Packaging as `CorridorKey-Desktop-<version>.AppImage`.
- CorridorKey's own icon (corridorkey.com).
