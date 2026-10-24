# Changelog

## 0.1.0-dev.1 (unreleased)

- First app: clip queue (videos, frame folders, batch folders, companion hints found next to
  clips), per-clip hint/output/memory settings, one engine process for the queue, live progress
  from the engine (stages, frames, measured speed, the memory window used), result stills,
  errors with the engine's output, cancel.
- The CorridorKey engine in Rust on ONNX Runtime (CUDA, fp16), inside the app: 0.51-0.68× the time
  of the PyTorch version per clip on an RTX 5080, with less graphics memory and RAM; portrait clips
  work (model set `2.0.0-onnx.3`). The PyTorch engine stays available as the reference.
- Installs itself: on first start the Engine page downloads the GPU runtime (ONNX Runtime and
  NVIDIA's CUDA / cuDNN libraries, from PyPI) and the CorridorKey models (from this repository's
  releases), 4.5 GB once, with progress, stop and resume, every file SHA-256 checked. The whole
  install is less than half the original CorridorKey 2.0 setup (README, Install size).
- The Engine page lists what it finds (Automatic = the newest) with Browse… for anything else, and
  checks ffmpeg: if it's missing, it offers to install it (apt, pacman) or says what to enable.
- Updates: the AppImage updates itself from signed Stable / Development feeds (signature, size
  and SHA-512 checked; installs beside the running copy, the previous version kept; never a
  downgrade except Back to stable). Packaging as `CorridorKey-Desktop-<version>.AppImage`.
- CorridorKey's own icon (corridorkey.com).
