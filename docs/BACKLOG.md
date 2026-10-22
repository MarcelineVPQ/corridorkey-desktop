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
| 12 | TensorRT speed option: OFF by default, opt-in in Settings with an honest explanation. Engines are built per GPU for resolution *ranges* (padded to the runtime's 128 px quantum; aspect ratio counts) and temporal-window ranges; a clip outside every range gets a one-time "Optimizing for this resolution" build or runs on the normal path. Precision BF16 (as trained) unless FP16/FP8 pass the matte-error test. Driver/TensorRT updates can invalidate cached engines: say so, rebuild. Frame rate and input bit depth don't matter (all input becomes float32 before the model) | Marcy 2026-10-21 | planned, after the ONNX spike |
| 13 | Self-update (signed Stable/Development feeds, verified AppImage install, Restart now, Back to stable) + AppImage packaging and release workflow, as in DS5/Sonata (docs/RELEASING.md) | Marcy 2026-10-21 | built on `feat/updater`; needs the GitHub repo + `CK_FEED_KEY` secret, and the UI wiring |
