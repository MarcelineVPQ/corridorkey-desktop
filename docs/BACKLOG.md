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
| 14 | Portrait clips on the ONNX engine: every export of C-RADIO (onnx.1, onnx.2, the TensorRT set) fails on frames taller than wide (a square position grid: 240 tokens against 400 at 768x1280 padded). The engine now refuses them in words (`input`). Needs a C-RADIO re-export with a non-square position grid (CorridorKey2.0 `spike/onnx`), or Marcy's call on a workaround (e.g. padding to square, which changes what C-RADIO sees) | bug hunt 2026-10 (docs/BUG_HUNT_2026-10.md I3) | needs research |
| 15 | One decode pass for the low-VRAM RVM and foundation phases (they decode the clip twice now): ≤ ~1 s per job, changes the staging | efficiency pass #18 | idea |
| 16 | Restart through systemd-run (the normal path): the new copy started at once, while the old one still quit | bug hunt 2026-10 (U6) | done 2026-10-22: the unit runs the shell fallback's own wait (old PID gone, ≤ 15 s) before the new copy; unit-tested, and end to end with `tools/update_e2e.sh --systemd` (a private `systemd --user` inside the isolation) |
| 17 | Multi-GPU: the engine's NVML card was CUDA_VISIBLE_DEVICES' first entry by NVML (PCI) order, not CUDA's device 0; GPU UUIDs weren't read | bug hunt 2026-10 (C6) | done 2026-10-22: the engine asks the CUDA driver for device 0 and matches NVML's card by UUID / PCI bus id; without a CUDA driver it reads the variable as CUDA does (UUID / MIG entries, CUDA_DEVICE_ORDER). Unit-tested with fake cards; one card on Marcy's machines, no multi-GPU hardware test |
| 18 | A clip the app can't read (probe error) showed its reason on its row but raised no task dot | bug hunt 2026-10 (A9) | done 2026-10-22: an error task on the Queue item (the reason in its text); pressing it selects that clip |
| 19 | A failed or cancelled job left the files it had started in the output folder (half-written videos / EXR frames), and its start had already overwritten an earlier run's results of the same names | bug hunt 2026-10 (E12) | done 2026-10-22: jobs write into a staging folder inside the output folder, moved into place on success; a failure, cancel or crash removes it (only this job's files; earlier results and the user's files untouched) and the row says what was removed |
| 20 | The PyTorch engine (kept as the benchmark reference, Marcy 2026-10-22) keeps three gaps the hunt fixed in the Rust engine: a `cancel` must come before its `run` line; upstream's writer drops the videos' transfer / primaries tags; a NaN / infinity in an EXR frame spreads over the whole matte | bug hunt 2026-10 (E13) | idea |
| 21 | After the Rust engine beats PyTorch: code audit — efficiency pass (hot paths, allocations, copies, GPU↔host round-trips, ffmpeg/decode overlap) and loop detection (every loop/timer listed mechanically with one verdict; Rust included) across engine-rs and the app | Marcy 2026-10-21 | done (docs/EFFICIENCY_PASS_2026-10.md, docs/LOOP_PASS_2026-10.md) |
| 22 | Final step after the audit: bug hunt across the Rust engine and the app (mechanical, every finding with a verdict; fixes on branches) | Marcy 2026-10-21 | done (docs/BUG_HUNT_2026-10.md) |
