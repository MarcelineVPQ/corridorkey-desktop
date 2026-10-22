# Backlog

One list (rule 8). Rows are built only when Marcy says "now". Updated in the
same commit as the work.

| # | Item | Source | Status |
|---|---|---|---|
| 1 | Electron shell: clip queue, per-clip settings, run with real progress, results | plan | building |
| 2 | Engine install from inside the app (venv + weights, licence + progress), Sonata pattern | plan, rule 10 | planned |
| 3 | ONNX Runtime engine, decided on the spike's numbers | `spike/onnx` | measuring |
| 4 | Make hints in the app: mark the subject on a frame (no Resolve Magic Mask needed) | launch video 2026-10-21 | idea |
| 5 | Window control with a live VRAM estimate (runtime's own table), labelled as an estimate | launch video | idea |
| 6 | Quick single-frame preview before the full temporal render | launch video | idea |
| 7 | Review tools: A/B wipe vs the plate, alpha-only view with gamma boost, loupe, frame step / flip-flop | launch video (Marion's notes: hair flicker, soft edges) | idea |
| 8 | Eroded core-matte export for Nuke/Fusion edge work (EXR) | launch video (core-matte workflow) | idea |
| 9 | Garbage matte (box/polygon) and frame-range processing | launch video (marker stands) | idea |
| 10 | Input/output colour space shown explicitly (display-coded vs scene-linear) | README | idea |
| 11 | Hint on any frame, not only the first (needs a runtime change or a reversed pass) | launch video | needs research |
| 12 | TensorRT speed option: OFF by default, opt-in in Settings with an honest explanation. Engines are built per GPU for resolution *ranges* (padded to the runtime's 128 px quantum; aspect ratio counts) and temporal-window ranges; a clip outside every range gets a one-time "Optimizing for this resolution" build or runs on the normal path. Precision BF16 (as trained) unless FP16/FP8 pass the matte-error test. Driver/TensorRT updates can invalidate cached engines: say so, rebuild. Frame rate and input bit depth don't matter (all input becomes float32 before the model) | Marcy 2026-10-21 | engine side built on `speed/tensorrt` (strongly typed engines, fp16 + FP32 islands, CUDA-fp16 parity; 0.66-0.82× CUDA fp16 time on the six clips); Settings toggle not built |
| 13 | Self-update (signed Stable/Development feeds, verified AppImage install, Restart now, Back to stable) + AppImage packaging and release workflow, as in DS5/Sonata (docs/RELEASING.md) | Marcy 2026-10-21 | built on `feat/updater`; needs the GitHub repo + `CK_FEED_KEY` secret, and the UI wiring |
| 14 | Portrait clips on the ONNX engine: every export of C-RADIO (onnx.1, onnx.2, the TensorRT set) failed on frames taller than wide (the export dropped the position grid's column crop: 400 position tokens against 240 patches at 1280x768 padded) | bug hunt 2026-10 (docs/BUG_HUNT_2026-10.md I3) | done on `fix/portrait` + CorridorKey2.0 `onnx/portrait`: set `2.0.0-onnx.3` (C-RADIO re-exported with both crops in the graph, no padding); C-RADIO vs PyTorch fp32 on portrait max ≤ 3.3e-5 (fp32), the landscape size; landscape bit-identical to onnx.2 (six clips: mattes identical, totals within 0.7 s); portrait vs the PyTorch engine alpha MAE 6.86e-4 / 3.69e-4 (landscape 6.12e-4 / 3.01e-4); CPU fp32 e2e 1.46e-7. onnx.1/.2 still refused in words. Open: TensorRT portrait engines unmeasured on the card (`models-trt-2`) (docs/ENGINE_RUST.md "Portrait") |
| 15 | One decode pass for the low-VRAM RVM and foundation phases (they decode the clip twice now): ≤ ~1 s per job, changes the staging | efficiency pass #18 | idea |
| 16 | Restart through systemd-run (the normal path): the new copy starts at once, while the old one still quits (the fallback now waits for it; this path can't be tested from the isolated harness, which has no user manager). Wrap the target in the same wait | bug hunt 2026-10 (U6) | planned |
| 17 | Multi-GPU: the engine's NVML card is CUDA_VISIBLE_DEVICES' first entry by NVML (PCI) order, CUDA's device 0 is by CUDA's own order; GPU UUIDs in CUDA_VISIBLE_DEVICES aren't read. One card (Marcy's machines) is unaffected | bug hunt 2026-10 (C7) | idea |
| 18 | A clip the app can't read (probe error) shows its reason on its row but raises no task dot; the task rule says everything that needs the user is a task. Marcy's call | bug hunt 2026-10 (A9) | idea |
| 19 | A failed or cancelled job leaves the files it had started in the output folder (half-written videos / EXR frames); the next run overwrites them. Remove them, or say so on the row | bug hunt 2026-10 (E12) | idea |
| 20 | The PyTorch engine (kept until retired) keeps three gaps the hunt fixed in the Rust engine: a `cancel` must come before its `run` line; upstream's writer drops the videos' transfer / primaries tags; a NaN / infinity in an EXR frame spreads over the whole matte | bug hunt 2026-10 (E13) | idea |
| 21 | After the Rust engine beats PyTorch: code audit — efficiency pass (hot paths, allocations, copies, GPU↔host round-trips, ffmpeg/decode overlap) and loop detection (every loop/timer listed mechanically with one verdict; Rust included) across engine-rs and the app | Marcy 2026-10-21 | done (docs/EFFICIENCY_PASS_2026-10.md, docs/LOOP_PASS_2026-10.md) |
| 22 | Final step after the audit: bug hunt across the Rust engine and the app (mechanical, every finding with a verdict; fixes on branches) | Marcy 2026-10-21 | done (docs/BUG_HUNT_2026-10.md) |
