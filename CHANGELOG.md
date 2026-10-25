# Changelog

## 1.0.0

The first release: a free desktop app for CorridorKey 2.0, Corridor Digital's AI green and blue
screen keyer, on its own Rust + ONNX Runtime engine, for Linux, Windows and macOS (Apple Silicon).

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
- Windows 10/11: an installer (per user, no administrator), the same setup (the Windows runtime
  packages, ffmpeg through winget) and an uninstaller that asks whether to remove the downloaded data.
  Tested in a Windows 11 virtual machine without an NVIDIA card: keying on Windows is untested
  (README, Requirements).
- App settings, Storage: each folder the app keeps, its size, and Remove; the thumbnail cache prunes
  itself (30 days, 500 MB). README, Uninstall lists every folder the app writes.
- Add clips (video files) and Add folder (frame sequences, folders of clips) are two buttons: one
  dialog can't pick both on Windows or Linux.
- The window title says which CorridorKey and which engine: CorridorKey 2.0 — Rust + ONNX.
- TensorRT, optional (Linux): Engine settings, TensorRT, "Use TensorRT (faster on NVIDIA)", off by default. About
  2× the original's speed at HD with the same mattes (README, Speed, 0.0.6-dev); the first job at each resolution
  optimizes for it once (about 4.5 minutes on an RTX 5080, about 5 at 4K; about half that once TensorRT's timing
  cache is warm). 4K (DCI 4K and UHD, up to 2176×4096) runs on TensorRT too, at the 8/4 window on 16 GB cards, about
  25 % faster than CUDA with the same mattes (README, Speed, 0.0.7-dev); open gate and larger stay on CUDA. Switching it on offers its own download (NVIDIA's
  TensorRT libraries from pypi.nvidia.com and the TensorRT models from this repository's releases, 6.9 GB, with
  progress, stop and resume, every file SHA-256 checked); jobs ask for TensorRT only once it is installed, and the
  job's log says what really ran (and which network stayed on CUDA, and why). Its own item in Storage. Windows
  needs its own engine builder (later); macOS has no TensorRT.
- Deep input: 10/12-bit video (ProRes 4444, HEVC/DNxHR 4:4:4…) is decoded to 16-bit RGB and 16-bit PNG is read at
  full depth, so film plates reach the model without rounding to 8 bits. Measured on a 4K plate: the matte is
  identical to keying the same plate as 16-bit frames; the old 8-bit read put one hair-edge pixel in twelve off by
  up to 15/255 (README, Quality). No measurable time cost (within run-to-run spread); 8-bit sources are unchanged.
- EXR outputs to the studio convention (Rust engine): frames named `<clip>_<output>.<number>.exr` with the source's
  own frame numbers and padding (a frame folder's `04_5d_00065.exr` gives `04_5d_alpha.00065.exr`; video counts
  from 1001), the alpha EXR's matte in channel `A` (Nuke and OpenImageIO read it as alpha), and the cutout
  premultiplied (RGB × alpha). On purpose this differs from the original CorridorKey's EXR writer
  (`alpha_000000.exr` from 0, the matte as `Y`, a straight cutout); the matte values themselves are unchanged.
- Video outputs for film work (Rust engine): a Codec choice per clip. Lossless H.264 10-bit 4:4:4 (the default; only
  the 10-bit rounding is lost, never more than 0.16/255 on the matte), DNxHR 444 10-bit in a .mov (Linux and Windows;
  within 1.3/255), or H.264 CRF 12 (the original's small files; up to 21/255 on hair edges). Measured against EXR on an
  HD clip and the 4K 04_5d plate (README, Quality, "Video outputs"). The Mac has lossless H.264 for now; Apple's ProRes
  4444 XQ comes with the Mac work. ffmpeg's ProRes encoder is no longer used: the video cutout is premultiplied colour
  with the Alpha output as its alpha (written with it); EXR keeps the premultiplied RGBA cutout. The ffmpeg check asks
  for libx264 with 10-bit (and dnxhd on Linux and Windows) and says plainly when the system's libx264 is 8-bit only.
  New protocol field `video_codec` (docs/ENGINE_PROTOCOL.md); the PyTorch reference engine still writes CRF 12.
- Parity with every option of the original's command line (docs/PARITY.md, each option with its verdict). Internal
  resolution (the original's `--model_scale`), per clip in Queue: Full / ¾ / ½ / ¼; the networks run at the scaled
  size with cv2's Lanczos-4 ported bit for bit and the outputs come back at the clip's size; `_settings.txt` writes
  the real scale and the memory estimate follows it (Rust engine; speed and matte per scale not measured yet). Linear
  exposure (the original's `--linear_brightness` / `--linear_contrast` / `--linear_contrast_pivot`) for video clips,
  Queue → Linear exposure. `start_mode` / `seed` in the engine protocol (NumPy's generator bit for bit). Checked end to
  end on the CPU in float32 against the original's runtime (alpha MAE below 5e-7). New protocol fields `model_scale`,
  `linear_brightness`, `linear_contrast`, `linear_contrast_pivot`, `start_mode`, `seed` (docs/ENGINE_PROTOCOL.md).
- Colour management, engine (Rust engine; the app's menus come next): OpenColorIO 2.5 built into the engine, so a
  clip can be given in its own colour space (ACEScg, ACES2065-1, the camera log spaces of OCIO's ACES studio config,
  or any space of a studio's own config, `$OCIO` honoured). The engine converts it exactly to what the model was
  trained on (linear Rec.709) and writes the EXR outputs back in the clip's space (or another chosen one); the
  alpha is never converted. Bit-identical to PyOpenColorIO on every colour space of the studio config and on a
  studio config with a show LUT, `$SHOT` and a CDL; a plate keyed in ACEScg or ACES2065-1 gives today's matte to
  within 1/256 (README, Quality). Jobs without a colour space run exactly as before (bit-identical). EXR and image
  sequences in this version; colour-managed video input comes next. New protocol fields and a `colorspaces` command
  (docs/ENGINE_PROTOCOL.md).
- Graphics memory → Manual shows the engine's own estimate next to each window and the Low-memory switch, before the
  job ("about X GiB of Y GiB free: fits"), from a new `estimate` engine command (docs/ENGINE_PROTOCOL.md; backlog row 41).
- Graphics memory → Memory limit: Auto or a limit in GiB per clip (the engine's `vram_budget_gb`), with a default for
  new clips in App settings → Graphics memory, shown with the card's size and free memory from the engine's reading;
  the estimate is weighed against it. Auto means the free memory when the job starts, as before (docs/GUIDE.md;
  backlog row 43). A finished job shows the limit it ran with.
- App settings → Storage: the cache folder can move (Change…, Default; move the files, copy-verified before any
  delete, or start fresh, asked), shows its size per clip and per TensorRT range, and every folder has Open
  (docs/GUIDE.md; backlog row 44).
- Cache folder on a drive that isn't connected: the app never makes the chosen location itself (only its own folder
  inside one that is there); Storage says "Drive not available", the cache uses the default folder for now (nothing
  moved or deleted, the choice kept for the next start), with Use the default folder from now on. Start queue is
  disabled with "Moving the cache folder…" while the cache moves.
