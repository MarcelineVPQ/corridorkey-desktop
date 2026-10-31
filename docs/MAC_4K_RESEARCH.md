# Row 177: 4K at ~1 fps on the 16 GB M6 Mac mini (independent research, read-only, 2026-10-30)

"Documented" means a repo record or a public source says it. "Inferred" means it is the reviewer's reasoning, not measured. Nothing was run.

## Conclusion
1 fps at 4K (2.6x over today's 0.38 fps) is **plausible but not proven, and no single cheap setting is documented to give it**.

- **Memory:** 4K is only ~25% slower than pixel-linear scaling from 1920×1080 (inferred), so removing swap and memory overhead caps near 1.25x.
- **What could reach 2.6x:**
  - (a) The Neural Engine running at the same time as the GPU: one network per unit, pipelined. This needs graphs the ANE compiles and runs in fp16 without CPU fallbacks.
  - (b) Graphs that move fewer bytes on the GPU.
- **Why (b):** the CUDA/Mac gap at 4K (4.9x) is close to the bandwidth gap (960 vs 170 GB/s = 5.6x). That suggests a bandwidth-bound run (inferred).
- **First step:** one diagnostic run with Core ML's compute-plan profile, for per-network and per-op time at 4K. The repo doesn't have it.

## Key facts
- **Today's 4K run:** 04_5d, 12 frames, window 4/2 low-memory, cpu-gpu. 0.38 fps steady, peak 9.8 GB, 0.8 GB swap, alpha max 2.44e-3 vs CUDA (ENGINEERING.md:693).
- **CUDA on the same job:** 1.88 fps (ENGINEERING.md:695-696).
- **1920×1080:** 2.02 fps steady (ENGINEERING.md:692). Pixel-linear scaling predicts 0.50 fps at 4K.
- **HD split:** stage 1 is about 0.68 s per frame and stage 2 is 0.56 s per frame (docs/ENGINE_RUST.md:436-439). The 4K split is unknown.
- **ANE history** (docs/ENGINE_RUST.md:410-419):
  - On onnx.4, stage 2 crashed the ANE compiler and recompiled for ~145 s on every load.
  - C-RADIO, MoGe and RVM ran 2-8x slower, because their fp32 casts and norms fell back to the CPU.
- **onnx.5 on the ANE:** not measured (docs/ONNX_EXPORT.md:575).
- **Precision policy:** since onnx.4, norms, softmax and sums stay fp32 (engine-rs/export/autocast_policy.py:1-31). The ANE has no fp32 path (coremltools docs).
- **fp16 on CUDA:** the all-fp16 onnx.3 was 12% faster at 4K (ENGINEERING.md:470-471).
- **M6:** 12-core GPU with Neural Accelerators, a dual 16-core Neural Engine, 170 GB/s (Apple newsroom, 2026-08).
- **Engine:** ORT Core ML EP in MLProgram format, one global compute-units setting, static shapes, a model cache. FastPrediction and low-precision GPU are env knobs that are off (runtime.rs:452-481).
- **`ProfileComputePlan`:** in the ort crate (`with_profile_compute_plan`) but not wired.

## Ranked changes
| # | Change | Expected gain | Effort | Matte risk | Touches |
|---|---|---|---|---|---|
| 0 | Wire `ProfileComputePlan` (env knob), one diagnostic run | 0x by itself; shows where the time goes | S | none | engine |
| 1 | ANE and GPU at once: compute units per network, stage 1 / stage 2 pipelined | up to ~1.8x if the halves are balanced (inferred); today's evidence is against the ANE | M-L | medium (ANE fp16, accumulation undocumented) | engine, export |
| 2 | Leaner 4K memory plan (no swap) | ≤ ~1.25x (inferred) | S-M | none | engine |
| 3 | fp16 throughout in the Core ML set | 12% on CUDA; Mac unknown; needed for #1 | M | medium-high; reverses onnx.4 policy (Marcy's call) | export |
| 4 | ANE-shaped graphs (Apple ml-ane-transformers layout) | unknown for us; only matters with #1 | L | low-medium | export |
| 5 | FAST_PREDICTION=1 | unknown | none | low | env |
| 6 | LOW_PRECISION_GPU=1 | unknown, likely small | none | real | env |
| 7 | coremltools conversion instead of ORT's EP | unknown | XL | medium | everything; breaks the Rust + ONNX stack |
| 8 | Palettization / int8 | likely small | M | high | export |

**Reviewer push-back:**
- **#7:** it breaks the house stack. Only consider it if #0 shows ORT's translation is the bottleneck.
- **#3:** it is Marcy's call.

**Likely route (inferred):** #2 × #3 × #1 ≈ 2.0-2.4x, which is 0.75-0.9 fps. Reaching 1 fps needs the ANE half to be as fast as the GPU half. GPU-only changes reach about 0.45-0.55 fps.

## Proving runs (for Marcy's approval; one 12-frame 4K run each on the M6, ~2-3 min)
| # | Run | Go / no-go |
|---|---|---|
| 0 | Today's command with ProfileComputePlan | No verdict; picks the next lever |
| 1 | Load-only probe of onnx.5 on cpu-ane, then per-network units plus pipelining | Go: ≥ 0.55 fps, no swap growth, compile cached, mattes in bar |
| 2 | Leaner memory plan | Go: no swap and ≥ 0.45 fps |
| 3 | All-fp16 Core ML set (CPU parity on Linux first) | Go: ≥ 10% faster and in bar |
| 5 | FAST_PREDICTION=1 | Go: ≥ 5% faster and in bar |
| 6 | LOW_PRECISION_GPU=1 | Go: ≥ 10% and in bar; otherwise dropped for good |

## Open questions
1. Per-network time at 4K (run #0).
2. Does onnx.5 compile on the ANE (load-only probe)?
3. Does Core ML use the M6 GPU Neural Accelerators, and at which precision (Instruments)?
4. How precise is the ANE's accumulation (run #1's matte check)?
5. Is the run bandwidth-bound (GPU counters)?
6. Where do the 9.8 GB go at 4K (run #0 and #2)?
7. How far is an all-fp16 set from onnx.4?
8. ~~ENGINEERING.md:678 says 6 CPU cores; Apple says the M6 has 12.~~ Answered 2026-10-30: 12 (2 super + 4 performance + 6 efficiency, the Mac's own `sysctl hw.perflevel*`); ENGINEERING.md fixed in afb4934.
9. ORT EP vs coremltools: no public benchmark found.
