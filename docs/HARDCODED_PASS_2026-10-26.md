# Hard-coded values pass (2026-10-26)

Read-only pass over every literal that encodes a decision, against the measurement or spec it rests on. No code was
changed; this file is the only output. Shipping state checked against: model set `2.0.0-onnx.4` (install.ts
`MODEL_SET`, since 9ee5e40, 2026-10-25), ONNX Runtime 1.31.0, TensorRT 10.16.1.11, app 1.0.0-dev.1, main at 1afed1c.

## How it was searched

Mechanically, per area, then each hit read in context:

- **Numbers:** `grep -E '([^a-zA-Z_0-9.#-]([3-9]|[1-9][0-9]+)(\.[0-9]+)?|[0-9]\.[0-9]+|[0-9]+_[0-9]{3})'` (every
  integer of 3 or more, every decimal, `20_000`-style literals), comment lines dropped. Rust hits inside
  `mod tests` were dropped (tests only where they pin a product value). 0, 1, 2 are not listed by the search.
- **URLs, paths, versions:** `https?://`, `\.so|\.dll|\.dylib`, `/proc|/usr|/opt|AppData|Library/|\.local|\.cache`,
  `onnx\.[0-9]`, `1\.31`, `10\.16`, `glibc`, `sha256`, machine names (`10.0.0.`, `/home/`, `RTX`).
- **User-facing claims:** strings with `GB|GiB|MB|min|×|%|fps|RTX|about N|measured` in `src/`, `electron/`, and
  the in-app docs (`docs/GUIDE.md`, shown on the About page) and the README's top sections.
- **Duplicates:** each constant that crosses app ↔ engine ↔ tools ↔ docs was grepped for its other copies, and
  `tests/unit/*.ts` / Rust tests checked for a tie.
- **Sources checked:** README Speed/Quality tables, docs/ENGINE_RUST.md, BACKLOG rows 12/41/54/56, `git log -S` for
  when a constant or doc line was written vs. when onnx.4 shipped, the upstream checkout (~/projects/CorridorKey2.0,
  infer.py, runtime.py, video_io.py, run_interactive.py), the installed set
  (~/.local/share/corridorkey-desktop/models/2.0.0-onnx.4: every size in install.ts matches; four SHA-256 spot-checked,
  all match), and sums of the pinned sizes (python over install.ts).

What the search can miss: values built at run time from other values (only their inputs are seen); literals of 0, 1,
2 (e.g. a `2.0` scale cap was found only through its `const`); numbers inside prose that the regex splits; hard-coded
behaviour without a literal (an implicit unit, a default branch). `tools/` and `engine-rs/export`, `engine-rs/tools`
are dev/bench tooling: their release-path files (release.sh, build_engine.sh, build_trt_builder.sh, build-feed.mjs,
feed-rules.mjs, sign-feed.mjs, check_targets.sh, isolated.sh, gen_notices.mjs, upload_trt_models.sh) were read hit by
hit; the rest (benches, gates, compare and export scripts: ~1,100 hit lines) were scanned for pins, model-set names,
URLs and machine-specific paths only, not literal by literal. No GPU was used: nothing here was re-measured.

## Counts

Non-FINE findings by verdict (one primary verdict each):

| Verdict | Must | Should | Nice | Total |
| --- | --- | --- | --- | --- |
| STALE | 2 | 3 | 3 | 8 |
| WRONG | 0 | 2 | 3 | 5 |
| UNSOURCED | 0 | 2 | 2 | 4 |
| DUPLICATED (no test) | 0 | 3 | 8 | 11 |
| PLATFORM | 0 | 0 | 0 | 0 |
| **Total** | **2** | **10** | **16** | **28** |

By area (hit lines read; FINE = the rest, counted, not listed):

| Area | Hit lines read | Non-FINE | FINE | Notes |
| --- | --- | --- | --- | --- |
| electron/ (main) | 223 (of which ~30 zip-format offsets in unzip.ts) | 4 | ~219 | install.ts pins all SOURCED |
| src/ (renderer, shared) | 242 (icon sizes, palette, layout px are most) | 10 | ~232 | trt.ts measured texts SOURCED (onnx.4) |
| engine-rs/crates (non-test) | 417 + vram.rs tables | 7 | ~410 | parity constants (cv2, NumPy, sRGB, x264) FINE |
| engine/ck_engine.py | 24 | 0 (shares N12) | 24 | |
| tools/ release path | ~120 | 2 | ~118 | |
| engine-rs/export, engine-rs/tools, other tools | ~1,000 (scanned for pins/sets/URLs) | 1 | — | not read literal by literal |
| docs shown in the app / README top | — | 8 | — | GUIDE.md, README Requirements and intro |

PLATFORM: none found. Per-OS paths, library names, separators and package managers are in one place
(electron/main/platform.ts, ffmpeg.ts plans, install.ts per-OS runtime sets, gpu.rs / decode.rs `cfg` lists) and each
has its Windows and macOS branch; the engine's own TensorRT cache root (pipeline/mod.rs `trt_root_for`) mirrors
platform.ts per OS and is overridden by the app (CK_ENGINE_TRT_CACHE). Linux-only items (TensorRT, /proc reads in
gpu.ts with a non-Linux fallback, appImageQuit) are Linux-only by design and guarded.

## Findings (must first)

| # | Where | Value | Verdict | Evidence / source checked | Sev | Suggested fix (size) |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | engine-rs/crates/ck-core/src/vram.rs:4-47 (NORMAL / LOW tables, UPLIFT 0.06); its claims in docs/GUIDE.md:38 (in-app: "an upper bound: never under a measured peak"), ENGINE_PROTOCOL.md:119-120/222-224, `estimate_basis: "onnxruntime-cuda-measured"` | the measured peak table, "an upper bound at every measured point" | STALE → WRONG on the shipping set | Table measured 2026-10-24 on onnx.3 (4358c3d, 21:13); onnx.4 ships since 2026-10-25 (9ee5e40). README "onnx.4" table (README.md:367): locked_backdrop 1280×1080, 48/24 low, **9.07 GiB** measured on onnx.4. The table at that point: 1280×1152 padded = 1.47456 MP, LOW col 48 = 8.47 × 1.06 = **8.98 GiB**: 0.09 GiB under a measured peak. onnx.4 added 0.86 GiB at HD (8.21 → 9.07); the 4K point still holds (9.29 vs 10.46). `measured_peaks_are_bounded` only holds onnx.3's points. The margin (× 1.1 + 0.3) still covers this point, so jobs don't fail from it yet; the in-app sentence is false | must | Re-run the row 41 sweep on onnx.4 (GPU, overnight window; tools/engine_bench.mjs, the 96 points) and regenerate both tables; add the onnx.4 points to the test. Until then, GUIDE/protocol say "measured on model set onnx.3; onnx.4 measured up to ~0.9 GiB higher at HD". Wording S, sweep M-L |
| M2 | README.md:19-22 (intro) and :50-51 (Requirements) | "2.4-2.7× faster than the original (1.5-1.8× at HD)", TensorRT "about 2× … at HD and about 3.7-4.2× at 4K" | STALE | All from onnx.3 runs (README:118 says so for the tables, but the intro and Requirements don't). The README's own onnx.4 rows against the 2026-10-24 original: CUDA HD locked_backdrop 31.3 / 24.5-25.4 s = **1.23-1.28×**; CUDA 4K 04_5d 449.5 / 180.5-189.7 s = **2.37-2.49×**; TensorRT HD 31.3 / 15.9 = **1.97×**; TensorRT 4K 449.5 / 143.7 = **3.13×** (not same-day pairs, one clip each). The HD headline is off by about a third | must | Re-run `tools/vs_original.sh` / engine_bench same-day on onnx.4 (both engines, the HD set + 4 plates) and replace the headline; or, now, state the onnx.4 figures with "one clip each, original from the day before". Wording S, bench M |
| S1 | README.md:47-48, docs/GUIDE.md:10 (in-app) | "a 4.9 GB download on Linux and Windows" | WRONG (Windows) | Sum of install.ts pins: Linux 1.553 + 3.303 = **4.86 GB**; Windows 1.336 + 3.303 = **4.64 GB** (RUNTIME_WIN wheels are smaller). macOS 3.32 GB matches "about 3.3 GB". The setup button itself shows the computed number (SetupParts.tsx:79), so only the docs are off | should | "4.9 GB on Linux, 4.6 GB on Windows" (S) |
| S2 | README.md:53-55 | "about 4.5 minutes for the five networks … about 5 at 4K; about half that once TensorRT's timing cache is warm" | STALE | onnx.3 figures (README:296-302: 270.7 s cold, 135 s warm, same range). onnx.4 (README:389-394): 4.4 min HD-ish range, 4.8 min 4K, and the 4K build ran *second, with the warm timing cache*: no halving across ranges. The app already uses the onnx.4 text (trt.ts:34 TRT_BUILD_COST "about 4.4-4.8 minutes") | should | Use TRT_BUILD_COST's wording; drop "about half once warm" or restrict it to "the same range rebuilt" with its onnx.3 date (S) |
| S3 | vram.rs:50-54 (MARGIN kept "a TensorRT job takes the same window"), select_vram_profile `low_only`; ENGINE_PROTOCOL.md:142 (`vram_budget_gb`: "the engine refuses to go past it") | margin × 1.1 + 0.3 GiB covering TensorRT | WRONG (measured point) | README.md:382 (onnx.4): TensorRT locked_backdrop at the CUDA window (48/24 low) peaked **11.0** (GiB, see N11) vs CUDA 9.1. The auto window requires 8.98 × 1.1 + 0.3 = **10.18 GiB**: a budget between ~10.2 and 11 GiB picks 48/24 for TensorRT and the job goes past it (TensorRT's memory is not under the CUDA arena cap). Row 54 says TensorRT peaks are "unmeasured"; this point is measured | should | Add the point to row 54; until TensorRT gets its own table, add the measured TensorRT excess (+1.9 GiB at HD, +1.5 at 4K) to a TensorRT job's estimate in select_vram_profile (S-M) |
| S4 | engine-rs/crates/ck-core/src/pipeline/mod.rs:528-542 (`arena_limit`) | 0.5 GiB CUDA context assumed, 0.5 GiB reserve ("measured: without it the process peaked 0.17-0.22 GiB over a 12 GiB budget"), floor 256 MiB | STALE | Written with d51e35f, 2026-10-21 (onnx.2). onnx.4's fp32 islands add working memory the arenas don't see (+0.86 GiB at HD). Whether a capped job still stays under its cap on onnx.4 is unmeasured | should | One capped run per mode on onnx.4 (e.g. 10 GiB cap, HD 48/24 and 4K 8/4), peak vs cap; adjust the reserve or cite the new run (S, GPU) |
| S5 | tools/build-feed.mjs:27, :41 | loop bound "[bounded: the feed job's timeout-minutes: 20]" | STALE | The feed CI job is gone (BACKLOG row 13: "the GitHub workflows are gone"; .github/workflows has macos.yml only). Feeds are built by tools/release.sh on this PC, where both `fetch` calls have no timeout | should | `AbortSignal.timeout(…)` on both fetches, and the verdict names it (S). The concurrent loop pass may also catch this |
| S6 | src/ui/format.ts:24-28 + src/ui/JobView.tsx:54; electron/main/queue.ts:11-13 | "Time left: about …" from `RATE_MIN_FRAMES = 3`, `RATE_MIN_SECONDS = 2` | UNSOURCED | CLAUDE.md rule 1: "Never estimate progress in the app." The time left is the app's extrapolation (labelled "about"); the rate is cumulative from the first `frames` reply, and the 3 frames / 2 s thresholds have no stated origin (low-VRAM jobs write in window-sized bursts) | should | Marcy's call: keep it, labelled as an extrapolation with its basis, or drop it; cite or measure the thresholds (S) |
| S7 | README.md:42 | "with an NVIDIA graphics card (RTX 30-series or newer)" | UNSOURCED | Every measurement is on one RTX 5080 (16 GB). The CUDA 13 runtime and the kept TensorRT kernels (install.ts:445 "Turing sm75 to Blackwell sm120") include Turing (RTX 20); nothing names why 30-series is the floor, or the smallest graphics memory that keys HD/4K | should | Measure on the RTX 2070 (second machine, 8 GB) and state the floor with that run, or say "tested on an RTX 5080 (16 GB) only" (S-M) |
| S8 | src/shared/types.ts:97 (VRAM_LIMIT_AUTO_HELP, shown in the app), docs/GUIDE.md:40 | "estimate × 1.1 + 0.3 GiB" | DUPLICATED | vram.rs:53-54 MARGIN_SCALE / MARGIN_GB; no test ties them (estimate.test.ts:17 uses 1.1 only as a fixture) | should | A trt.test.ts-style test that reads the two consts from vram.rs and checks the help text (S) |
| S9 | engine-rs/crates/ck-core/src/tensorrt.rs:27 and pipeline/keying.rs:735 | `FOUNDATION_CHUNK = 4`, defined twice | DUPLICATED | The TensorRT range's foundation batch range (bucket `f`) must equal what keying feeds C-RADIO/MoGe in low-VRAM mode; two independent consts, no test | should | One const (tensorrt.rs uses `keying::FOUNDATION_CHUNK`) (S) |
| S10 | tools/build_trt_builder.sh:19-21 and electron/main/install.ts:413-416; ORT: install.ts wheels 1.31.0, engine-rs/Cargo.toml:18 `api-31`, export/make_manifest.py:83 `onnxruntime_min` | TensorRT wheel name + SHA-256 (10.16.1.11); ONNX Runtime 1.31 | DUPLICATED | The builder (ck-trt-build) is linked against the libraries the app downloads; both copies agree today, nothing checks them. Same for the ORT version across app pin, `ort` API feature and manifest | should | A unit test reading build_trt_builder.sh's WHEEL/SHA256 against TENSORRT.libs, and Cargo.toml's `api-NN` against the runtime wheels' version (S) |
| N1 | docs/GUIDE.md:38 (in-app) | example "24 / 12 · about 11.3 GiB for an HD clip" | STALE | Written in 3a6ecf9 (2026-10-24 20:32), before the table recalibration 4358c3d (21:13). Today's table at 24/12 normal: 1920×1080 → 9.31 × 1.06 = 9.9 GiB, 1280×1080 → 7.9 GiB; no current cell gives 11.3 | nice | Recompute the example from the table (after M1) (S) |
| N2 | electron/main/queue.ts:487-489 `outputStem` | `Math.round(despill * 100)` | WRONG (dead code) | The engine (job.rs:341) and upstream (runtime.py:778 `int(despill*100)`) truncate: 0.29, 0.57, 0.58 give 029/057/058 here vs 028/056/057. `outputStem` is exported and used nowhere | nice | Delete it (or truncate) (S) |
| N3 | src/ui/JobSettings.tsx:390, src/ui/setup/SetupParts.tsx:295, engine pipeline/mod.rs:950 | "4096×2176" in text | DUPLICATED | Literal copies of TRT_MAX_AREA / MAX_AREA (tied to each other by trt.test.ts, but not these strings). JobSettings:390 "up to 4096×2176" also reads as a side limit, though 4096×3072 is out by area | nice | Build the text from TRT_MAX_AREA's factors / `MAX_AREA` (S) |
| N4 | src/shared/trt.ts:21 TRT_PIECES | the five networks, in build order | DUPLICATED | runtime.rs:18 PIECES; trt.test.ts ties ranges, MAX_SIDE, MAX_AREA, SHAPE_QUANTUM, TRT_NOT_BUILT but not this list (buildFraction weights depend on the order) | nice | Add PIECES to the existing tie test (S) |
| N5 | src/ui/setup/SetupParts.tsx:133, :119 | "TensorRT 10.16 libraries"; "4K DCI and HD to start with" | DUPLICATED | install.ts TENSORRT.libs.file (10.16.1.11); trt.ts DEFAULT_TRT_SIZES | nice | Derive both from the constants (S) |
| N6 | docs/GUIDE.md:60 (in-app) | "older than 30 days or past 500 MB" | DUPLICATED | electron/main/storage.ts:17-18 CACHE_MAX_AGE_DAYS / CACHE_MAX_BYTES (500e6); no test | nice | A docs test, or say "pruned at start" without the numbers (S) |
| N7 | electron/main/install.ts:446, tools/build_trt_builder.sh:33 vs install.ts:558 | "the wheel's 4.4 GB" vs "2.6 of 3.7 GB" | WRONG (wording) | The wheel is 3.73 GB (its size pin); 4.4 GB is presumably unpacked. The 1.8 room factor (install.ts:569) uses the 3.7 figure correctly | nice | "of the 4.4 GB it unpacks to" (S) |
| N8 | src/ui/JobSettings.tsx:138-140 | Hint trust hint "0.95 artist matte · 0.75 rough · ≤ 0.5 loose"; slider min 0.3 | UNSOURCED | 0.95 / 0.75 are upstream's (run_interactive.py:304-305); "≤ 0.5 loose" and the 0.3 floor are not (protocol and validate.ts:62 take 0–1; upstream's custom prompt takes 0.0-1.0) | nice | Drop "≤ 0.5 loose" or cite it; slider 0–1 or state why 0.3 (S) |
| N9 | src/ui/JobSettings.tsx:242 vs electron/main/validate.ts:74 | frame-folder fps 1–240 in the field, 0.001–1000 when saved | DUPLICATED (disagreeing) | Two ranges for one option | nice | One range constant in shared/types.ts (S) |
| N10 | src/shared/types.ts:421 | `OTHER_GPU_USER_MB = 512` ("desktops and browsers hold less") | UNSOURCED | No measurement cited (README:312 says the desktop holds 1.6 GB of the card in all, but gpu.ts reads compute processes only, which desktops usually aren't) | nice | Cite a reading of `--query-compute-apps` on a busy desktop, or keep and say it's a choice (S) |
| N11 | README.md:380-383 | "Graphics memory (GB), TensorRT / CUDA: 11.0 / 9.1" | WRONG (unit label) | The CUDA figure is the same run's 9.07 GiB elsewhere (README:367, GiB); every other table here is GiB | nice | Label GiB (S) |
| N12 | src/shared/types.ts:50-71, engine job.rs:237-298, engine/ck_engine.py:224-251 | run defaults: hint 0.95, carry 0.95, despill 0.5, fps 24, pivot 0.18, crf 12, chunk 80 / stride chunk/2 | DUPLICATED | All four copies match upstream (infer.py:59-60, :136-137; video_io.py:192 `or 24.0`; runtime.py:100-101), so FINE as values; no test ties app ↔ engine (the app sends most of them, so the engine's copy is the protocol default) | nice | One protocol-defaults test (Rust test reading types.ts, or a JSON both read) (S) |
| N13 | engine-rs/export/rebuild_mha.sh:9 | default `CK_ONNX_VERSION` 2.0.0-onnx.1 | STALE | build_models.sh:21 defaults to 2.0.0-onnx.4; run bare, rebuild_mha writes an onnx.1 manifest | nice | Default to onnx.4, or require the argument (S) |
| N14 | engine-rs/crates/ck-core/src/config.rs:139 and :245 | `trt_build_timeout` 1800 s, twice | DUPLICATED | Same value in Default and parse; the longest measured single build is 211.8 s (README:321) and per network 145 s on onnx.4; no reason given for 1800 | nice | One const with its reason (S) |
| N15 | docs/BACKLOG.md row 12 | "6.87 GB … TensorRT models from release `models-2.0.0-onnx.3-trt`" | STALE | Today: 5.53 GB from `models-2.0.0-onnx.4-trt` (install.ts sums; README:53 says 5.5 GB) | nice | Add a dated line to the row (S) |
| N16 | engine-rs/crates/ck-core/src/pipeline/mod.rs:1211-1225 `trt_root_for` vs electron/main/platform.ts:26-31 + storage.ts:16 | per-OS cache root + "tensorrt" | DUPLICATED | The app always passes CK_ENGINE_TRT_CACHE (engine.ts:121), so the engine's copy matters only for bare runs and benches; folder name "tensorrt" in both | nice | Comment that the app's is the source; or leave (S) |

## Status (2026-10-26, branch fix/passes-2026-10-26)

| # | Status |
| --- | --- |
| M1 | Wording fixed in d04e05e: GUIDE says the table was measured on onnx.3 and that one onnx.4 point is 0.09 GiB over its estimate, so it's a close guide until it's measured again. Deferred: the re-measurement on onnx.4 and the new table numbers (GPU, running separately); ENGINE_PROTOCOL.md's matching lines and `estimate_basis` wait for it too. Fixed 2026-10-26 (branch fix/vram-onnx4): the table re-measured on onnx.4 (85 points, 69 ran, 16 out of memory; the old table was under 31 of them) and replaced, `MEASURED` / `OUT_OF_MEMORY` hold the onnx.4 points and `measured_peaks_are_bounded` passes again; a 1920×1080 clip on a 16 GB card now gets 24/12 normal instead of 48/24 low (out of memory on onnx.4). GUIDE's "never under a measured peak" is true again; ENGINE_PROTOCOL.md names the onnx.4 measurement; `estimate_basis` stays `onnxruntime-cuda-measured` (the method is unchanged). |
| M2 | Deferred: the README headline speeds wait for the same-day onnx.4 bench (GPU, running separately). |
| S1 | Fixed in d04e05e: 4.86 GB Linux, 4.64 GB Windows, 3.32 GB macOS in README (Requirements and the comparison table) and GUIDE; test: both state the sums of install.ts's pins. |
| S2 | Fixed in d04e05e: README's build time is the onnx.4 measurement (4.4-4.8 min, 4K 4.8 with a warm timing cache), no "about half once warm". |
| S3, S4, S7 | Deferred: GPU measurements running separately. |
| S5 | Fixed in c1bc863: AbortSignal timeouts (API 60 s, download 20 min), the CI verdicts reworded; test in listLoops.test.ts. |
| S6 | Fixed in bc67bfa (Marcy's decision): "Time left" and `remaining()` removed; speed and frames stay; test jobView.test.ts. |
| S8 | Fixed in d04e05e: estimate.test.ts ties types.ts's and GUIDE's "× 1.1 + 0.3 GiB" to vram.rs MARGIN_SCALE / MARGIN_GB. |
| S9 | Fixed in 15393af: one FOUNDATION_CHUNK (tensorrt.rs); keying.rs and pipeline/mod.rs use it. |
| S10 | The TensorRT wheel name + SHA-256 was already tied (install.test.ts, "builds the shipped ck-trt-build against the same TensorRT wheel users download", reading tools/build_trt_builder.sh). Fixed in d04e05e: one ONNX Runtime version across install.ts's three runtimes' wheels, Cargo's `api-31` and make_manifest.py's `onnxruntime_min`. |
| N1-N16 | Backlog rows 67-81 (c9322e9), status idea. |

## Checked and SOURCED (the notable ones; not findings)

- install.ts: every runtime / model / TensorRT size matches the installed onnx.4 set; manifest.json,
  ck2-stage2-fp16.onnx, ck2-rvm-trt-fp16-ctx.onnx and models.json (as models-tensorrt.json) SHA-256 match. Room
  factors 2.5 (runtime: README's 2.4 GB on disk from a 1.6 GB download) and 1.8 (TensorRT: 2.6 of 3.7 GB kept).
  The PyPI URLs were not fetched (no network).
- trt.ts TRT_SPEED (0.63× / 0.76×, +1.5-2 GB), TRT_BUILD_COST (4.4-4.8 min, 2.8 GB), MEASURED_4K_BUILD_S: README
  "TensorRT on onnx.4" (2026-10-25), the shipping set.
- README Requirements TensorRT download 3.7 + 1.8 = 5.5 GB, 6.1 GB on disk; install size table (models 3.30 GB);
  the break-even "about 750 frames at 4K, 2,200 at 1280×1080" recomputes from the onnx.4 rows.
- TensorRT ranges, MAX_SIDE, MAX_AREA, SHAPE_QUANTUM, TRT_NOT_BUILT: tied app ↔ engine by tests/unit/trt.test.ts.
- TensorRT workspace 60 % of the budget, at most 8 GiB (pipeline/mod.rs:1100-1105): measured 2026-10-24; the onnx.4
  builds at HD and 4K succeeded with it (README:389-390).
- Codec hints "matte within 1.3/255", "up to 21/255" (JobSettings.tsx:27-28, GUIDE): README Quality, Video outputs.
- "at 4K on a 16 GB card it is 8" (JobSettings.tsx:397): 0.0.7-dev and the onnx.4 4K run both at 8/4.
- estimate.ts "start to pong 0.15 s"; decode.rs FOLDER_BATCH 4 (0.0.4-dev); writers QUEUE 2 and FRAMES_EVERY_S 0.25
  (protocol text); FIRST_FRAME 1001; MAX_MODEL_SCALE 2.0 (protocol); x264 CRF ranges 0-51 / 0-63; cv2 grey weights,
  Lanczos-4 constants, sRGB curve, NumPy RNG constants (bit-for-bit ports, tested).
- Upstream parity defaults (N12's values) all match the CorridorKey2.0 checkout.

## Unsure

- M1's size: one onnx.4 point is known to break the bound; how many of the 96 points do is unknown without the sweep.
  The margin hides it for now, which is why the job doesn't fail, but the in-app sentence is wrong today.
- M2 compares onnx.4 runs (2026-10-25) with the original from 2026-10-24; README:207-209 itself warns the original
  varied 10 % between days, so the true onnx.4 ratios need a same-day pair.
- S3 reads README:382's "11.0" as GiB from the same bench's convention (N11); if it were decimal GB it would be
  10.2 GiB, right at the 10.18 GiB requirement, and S3 drops to "no headroom" rather than "over".
- S6 is a rule question (is a labelled extrapolation "estimating progress"?), left for Marcy.
- S7: whether ONNX Runtime 1.31's CUDA 13 wheels carry kernels for sm75/sm86 wasn't checked (no network); the
  RTX 2070 run would settle it.
