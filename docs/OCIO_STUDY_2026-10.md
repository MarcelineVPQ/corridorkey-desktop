# OCIO / ACES study, 2026-10-24

A research study for backlog row 29 (colour management), kept verbatim. Its scripts and raw numbers were in the
study's scratch folder (`~/.cache/claude-scratch/ocio-study/`) on the PC where it ran; the decisions in section 8 are open.

Everything that was written lives under `~/.cache/claude-scratch/ocio-study/`:
- **Scripts:** `scripts/e1_exactness.py`, `e1b_refine.py`, `e2_lutbake.py`, `e2b_lut_own.py`, `e3_compare.py`, `e4_make_studio_config.py`, `e4_compare.py`, and the Rust harnesses `bind-test/`, `bind-test-win/`, `pure-test/`.
- **Raw numbers:** `work/e1.json`, `e1b.json`, `e2.json`, `e2b.json`, `e3/e3.json`, `e4.json`.
- **MinGW fixes:** `work/mingw-ocio-sys.patch` and `work/mingw.cmake`.
- **Clean-up:** I removed my build folders and the Wine prefix (about 2.1 GB). The venv (104 MB, PyOpenColorIO 2.6.0) and the crate sources in `dl/` are left in place.

## Summary

- **What the model expects.** The main networks take a signed asinh of scene-linear RGB in Rec.709/sRGB primaries (D65). The foundation networks (C-RADIO, MoGe, RVM) get an sRGB-coded copy clipped to [0, 1]. The primaries are never written down; they follow from the code, which goes linear ↔ sRGB with no matrix.
- **The transforms themselves are exact.** Camera log → linear is a 1D curve plus a 3x3 matrix, and OCIO's CPU processor computes both to float32 rounding.
- **Baked 3D LUTs are not exact.** Even a 129³ LUT leaves p99 errors of 0.24 % (2.4 bf16 steps) on LogC4 and RED, so LUTs should stay off the keying path.
- **Recommendation: the real OCIO C++ library, statically linked through the `ocio-rs` bindings (`bundled`).**
  - Its output was bit-identical to PyOpenColorIO 2.6.0 on 11 transforms, including the ACES 2.0 output transform. It also matched exactly on a studio-style config with a show LUT, a context variable and a CDL.
  - The MinGW cross-build from Linux fails out of the box. After five build fixes it works, and its output under Wine is byte-identical to Linux.
- **Pure-Rust alternative.** The `ocio` crate was also bit-identical on all 11 built-in transforms and cross-builds for Windows without patches. But it is 3 weeks old and 94 of its 98 commits are by an AI agent. Worth watching, too young to depend on.
- **Configs: ship no files.** OCIO has the ACES configs built in. Honour `$OCIO` first; otherwise use `ocio://studio-config-latest`, resolved to its versioned name and written into the job's settings so a key can be reproduced.

## 1. What the model expects (evidence)

**Network RGB input:** `asinh(x/0.008)/asinh(16/0.008)` of scene-linear RGB.
- Upstream (`~/projects/CorridorKey2.0`, commit c1b8e41):
  - `corridorkey/color_utils.py:4-5` sets knee 0.008 and ref 16.
  - `color_utils.py:98-117` (`linear_to_asinh`) calls this "the model RGB contract for HDR-capable training".
  - `model.py:4`: "rgb: signed asinh encoded scene-linear RGB".
- Our port:
  - `engine-rs/crates/ck-core/src/color.rs:4-13, 52-61`.
  - It is applied in `decode.rs:388-397` (`prep_frame_views`: `lin = exr_linear ? v : srgb_to_linear(v)`, then asinh, then bf16 rounding).
- The encoding is odd and unbounded: negatives and values above 1 pass through and can be reversed. `ref` is not a clamp.

**Second input, for the foundation networks.** This copy is `clip(linear_to_srgb(max(x,0)),0,1)`.
- Upstream: `color_utils.py:131-138`, used at `video_io.py:247-255` and `:311`.
- Ours: `decode.rs:377-384`.
- Negative and above-1 values are lost here on purpose. Upstream README "Input Color Handling": these networks "receive SDR-style RGB proxies".

**Transfer function:** IEC 61966-2-1 sRGB with 12.92 / 0.04045 (`color_utils.py:32-91`, `color.rs:15-49`).

**Primaries: Rec.709/sRGB D65, implied but never stated.**
- For linear EXR input, the display copy is made as `linear_to_srgb(linear)` with no matrix (`video_io.py:247-251`). That is only correct if "linear" means linear Rec.709.
- The upstream README (lines 509-549) says the runtime "does not automatically convert ACEScg, Rec.2020, LogC, S-Log…" and asks users to "convert upstream".
- The training data's colour space can't be checked: no training code or dataset is published.

**Outputs:**
- The foreground comes back asinh-coded (`model.py:15`). `asinh_to_linear` decodes it into the same linear Rec.709 space.
- EXR outputs are scene-linear and unclamped; video outputs are IEC sRGB, clamped. See `render.rs:87-130` (EXR) and `132-180` (video), upstream `runtime.py:642-727`.
- Despill works in linear Rec.709 (`render.rs:117`). Its "green" is Rec.709 green, so it has to run in the model's space, before any output transform.
- Alpha is coverage, i.e. data.

**"EXR = scene-linear" therefore means linear Rec.709.** Our Tears of Steel test plates are exactly that. Per mango.blender.org, they were converted from the F65 raw "using ACES color", then "with OpenColorIO to Rec709 'scene linear'".

**Yardstick: bf16 rounding.** The model input is rounded to bf16, a step of 2^-8 ≈ 0.39 % relative (`color.rs:126-131`). A transform error far below one bf16 step can't change what the network sees.

**Decode caveat for colour-managed video.** Video is decoded with the BT.601 matrix to copy OpenCV (`decode.rs:19`, `CV2_SCALE`).
- A camera-log ProRes 4444 plate is YCbCr. Decoded with the wrong matrix or range, its code values are wrong before OCIO even starts.
- So when a colour space is set, the decode must use the stream's tagged matrix and range (BT.709/2020, full/limited). BT.601 stays only for the "as CorridorKey 2.0" default.

## 2. Measurements

Reference: PyOpenColorIO 2.6.0, all in float32.

### Exactness of the transforms themselves (`work/e1.json`, `work/e1b.json`)

**OCIO's sRGB vs the model's IEC sRGB.**
- OCIO's "sRGB Encoded Rec.709 (sRGB)" is off by at most 7.6e-7 absolute.
- In the toe (codes below 0.04045) it is off by up to 2.5e-4 relative. OCIO's curve has a slightly different linear-segment slope, about 12.923 instead of 12.92 (measured ratio 0.99975).
- That is 1/16 of a bf16 step, so the network can't see it, but it is not bit-identical. sRGB sources should keep our own IEC formula.

**OCIO's default optimisation vs LOSSLESS.** The default includes FAST_LOG_EXP_POW, a 15-bit fast pow/log.
- sRGB curve: max error 2.5e-5 with the default vs 7.6e-7 with LOSSLESS.
- Camera logs: the two settings differ by up to 4.7e-5 of the pixel's largest channel.

**Matrix round trips are exact within float rounding.**
- Tested: ACEScg, ACES2065-1, ARRI Wide Gamut 4, S-Gamut3.Cine and REDWideGamutRGB ↔ linear Rec.709.
- Inputs: 1 M signed pixels from 2^-14 to 2^8.
- Worst error: 2.8 to 3.1 float32 eps of the pixel's largest channel.

**Log-curve round trips (LOSSLESS):**
- LogC4, LogC3, S-Log3, Log3G10 and ACEScct round-trip to within 1.8e-4 of one 10-bit code value.
- Grey pixels through the full chain (log → linear Rec.709 → log): within 1.2e-4 of a code.
- Random saturated log codes: up to 0.42 of a code (LogC4). This is float32 cancellation when one channel is about 400× another; OCIO does the same thing in float32, so it is not a library fault.

**The curves follow the camera makers' formulas.** OCIO's LogC4 decode matches ARRI's published formula, computed in float64, to 1.1e-5 relative.

**Wide gamut.** 94.5 % of random positive ACEScg colours fall outside Rec.709, i.e. arrive with at least one negative channel. Real plates are unmeasured.

### Baked LUT accuracy against the exact processor (`work/e2b.json`)

These are my own lattice bakes with tetrahedral interpolation, on near-neutral, plate-like colours. bf16 steps are counted in the model's asinh domain. Each cell is p99 relative error / p99 bf16 steps.

| Transform | 33³ | 65³ | 129³ (25.8 MB) |
|---|---|---|---|
| LogC4 → linear 709 | 3.7 % / 28 | 0.96 % / 9.6 | 0.24 % / 2.4 |
| S-Log3 S-Gamut3.Cine → linear 709 | 3.5 % / 3.7 | 0.61 % / 0.85 | 0.13 % / 0.18 |
| Log3G10 RWG → linear 709 | 3.8 % / 33 | 0.96 % / 9.5 | 0.24 % / 2.4 |

- With random saturated codes at 65³, the worst pixel is off by up to 31× relative.
- OCIO's own baker (`work/e2.json`, as `ociobakelut` would produce) agrees: 65³ LogC4 has a median error of 0.27 %.
- Baking into the asinh domain instead of linear does not help, because the matrix mixes the channels.

### The two Rust crates against PyOpenColorIO 2.6.0 (`work/e3/e3.json`)

Same built-in config (`studio-config-v4.0.0_aces-v2.0_ocio-v2.5`), default optimisation, 200 k pixels. "`ocio-rs`" is the binding to the C++ library (OCIO 2.5.2, static); "`ocio`" is the pure-Rust port.

| Transform | `ocio-rs` | `ocio` |
|---|---|---|
| LogC4, S-Log3 S-Gamut3.Cine, Log3G10, V-Log, ACEScct, sRGB → linear 709 | bit-identical | bit-identical |
| ACEScg, ACES2065-1 → linear 709 | bit-identical | bit-identical |
| linear 709 → ACEScg; linear 709 → LogC4 | bit-identical | bit-identical |
| ACEScg → sRGB Display (ACES 2.0 SDR output transform) | bit-identical | bit-identical |
| Speed, one thread, 200 k pixels | 1.3-2.7 ms | 1.0-3.7 ms |

At that speed a 4K frame takes about 0.1 to 0.16 s on one thread, and under 10 ms spread over the cores. For comparison, a 4K EXR decode is 46 ms on one thread.

### A studio's own config (`work/e4.json`)

The test config is the ACES studio config plus one extra colour space built from:
- a `${SHOT}_grade.cube` LUT found on the config's search path, with `$SHOT` read from the environment;
- a CDL.

Results:
- `ocio-rs`: bit-identical in both directions.
- `ocio`: off by up to 3.7e-6 of the pixel's largest channel; only 48 % of values identical (79 % in the other direction).

**Reaching the model's space from any config.** `GetProcessorFromConfigs(studio config, space, built-in config, "Linear Rec.709 (sRGB)")` was bit-identical to the same conversion done inside the studio config. It joins the two configs through their `aces_interchange` role, so it works even if the studio config has no linear Rec.709 space of its own.

### Builds

**`ocio` (pure Rust):**
- Linux: 27 s to build, 5.5 MB test program.
- Windows (MinGW cross-build from Linux): 27 s, 5.2 MB, needs only Windows' own DLLs. Run under Wine, its output was byte-identical to Linux.

**`ocio-rs` with the bundled C++ library, Linux:**
- About 5 minutes clean: CMake builds OCIO plus yaml-cpp, expat, minizip-ng, zlib, pystring and Imath. Peak 2.1 GB RAM.
- 7.2 MB test program after strip and LTO.
- It links the system libstdc++ and, here, glibc 2.43. Shipping it at glibc 2.28 needs the Zig toolchain, which I did not verify.

**`ocio-rs`, Windows (MinGW cross-build from Linux):** it fails out of the box. It works after five fixes, giving an 8.0 MB program that needs only standard Windows DLLs (kernel32, user32, gdi32, msvcrt, ntdll). Its output under Wine was byte-identical to Linux. The fixes:
1. OCIO's `FileTransform.cpp:221` builds an `ifstream` from a `wstring`, which MinGW's libstdc++ rejects; it needs `.c_str()`. This is open upstream issue #2283. OCIO's MinGW build is also reported broken for 2.4.2 (#2136) and 2.6.0 (#2358).
2. The binding's `build.rs` uses `cfg!(target_os)`, which in a build script means the host. So it links `-ldl` and picks Linux library names for a Windows target.
3. `OpenColorIO_SKIP_IMPORTS` was missing for the static bridge.
4. OCIO's bundled dependencies were built for Linux inside the Windows build. A CMake toolchain file (`CMAKE_TOOLCHAIN_FILE_x86_64_pc_windows_gnu`) fixes it.
5. zlib is named `zlibstatic` on Windows, and the link needs `-lgdi32 -lbcrypt`.

**macOS:** neither crate was built.

## 3. Options

**(a) `ocio-rs` 0.3.0 bindings, bundled and static (OCIO 2.5.2).**
- Exactness: bit-identical to the reference (measured).
- Platforms: Linux works; MinGW works with the five fixes, which we'd carry; macOS is claimed by the author, not verified.
- Size: about +7 MB.
- Maintenance:
  - OCIO itself is the industry reference, maintained by the Academy Software Foundation.
  - The binding has one main author (463 of 475 commits) and 4 stars, but is active (0.3.0 released 2026-10-23).
  - By default it silently builds a stub that does no colour work.
- Licence: BSD-3. Honours a studio's `$OCIO` config: yes, it is OCIO.

**(b) Our own small C-ABI shim around OCIO,** built like our TensorRT builder (`ck-trt-build`), either as a static library or as a DLL loaded with `libloading` the way we load ONNX Runtime.
- Exactness: the same as (a).
- Platforms: Linux with Zig's C++ (unverified for OCIO's CMake); Windows with the same MinGW fixes, or an MSVC-built DLL with a C ABI built on CI; macOS with native clang.
- Size: about +7 MB.
- Maintenance: we own about 300 lines of C++ plus OCIO's builds, but can use any OCIO version, including 2.6 (the VFX Reference Platform's CY2027 version).
- Licence: BSD-3. Honours `$OCIO`: yes.

**(c) Baked LUTs, applied in Rust.**
- Exactness: not exact. 65³ is about 1 % off at p99; 129³ is 0.24 % / 2.4 bf16 steps.
- Size: 8 to 26 MB per transform.
- Studio configs: only as a bake that still needs OCIO; looks and context variables are frozen.

**(d) Hand-written Rust input transforms (matrices plus published log curves).**
- Exactness: exact for what we write (LogC4 vs ARRI's spec 1e-5; matrices 3 eps).
- ACES 2.0 output transforms are large. They aren't needed for keying, only for previews.
- Studio configs: no LUT files, CDLs, looks or context variables. That rules it out for studios.

**(e) `ocio` 0.2.2, a pure-Rust port of OCIO.**
- Exactness: bit-identical on the 11 built-in transforms, 3.7e-6 off with LUT plus CDL.
- Platforms: builds trivially everywhere; the Windows build needed no patches and gave byte-identical output.
- Size: about +5 MB.
- Maintenance risk:
  - 3 weeks old; 94 of its 98 commits are by an AI agent ("claude").
  - 1 star, bus factor 1.
  - 125 k lines we would inherit if abandoned.
- Licence: MIT and BSD-3. Honours `$OCIO`: yes, with the small drift above.

## 4. Recommendation

**Use the real OCIO C++ library through `ocio-rs` with `bundled` (option a).** If keeping the binding's build working becomes a burden, fall back to our own shim (b).
- **Exact, and checkable.** It is the library Nuke, Resolve and PyOpenColorIO use, and it was bit-identical in every case I measured. "Same numbers as OCIO" is a claim a studio can check themselves with `ocioconvert`.
- **Studios bring their own config.** Only a real OCIO implementation reads arbitrary configs: file rules, show LUTs, CDLs, looks, context variables, `ocio://` names. That rules out (c) and (d).
- **The Windows cost is known and small.** Fixes 2-5 belong in the binding's `build.rs` and could be offered upstream; fix 1 is OCIO's open issue #2283.
- **Guard against the stub.** The engine must refuse to run if `ocio_rs::is_stub_build()` is true, both at startup and in a unit test, so a stub can never ship.
- **Use OCIO's LOSSLESS optimisation** (or the default without FAST_LOG_EXP_POW) and record it in the job settings. Otherwise "round trip exact within float rounding" fails: the sRGB round trip is off by 1.8e-5 with the default vs 1.2e-7 with LOSSLESS.
- **Keep our own sRGB for "as CorridorKey 2.0" sources.** OCIO's sRGB curve differs by up to 2.5e-4 in the toe; invisible after bf16 rounding, but not bit-identical to the original.
- **Watch the pure-Rust crate.** Re-evaluate `ocio` later, as a test oracle or a replacement, once it has history, more maintainers and exact LUT/CDL parity. Don't build on it now.

## 5. Configs to ship

**No config files.** OCIO has the ACES configs built in:
- OCIO 2.5 (what `ocio-rs` bundles): `studio-config-v4.0.0_aces-v2.0_ocio-v2.5` and the matching `cg-config-…`.
- OCIO 2.6: `…v5.0.0_aces-v2.1_ocio-v2.6`.
- Shortcuts: `ocio://studio-config-latest`, `ocio://cg-config-latest`, and `ocio://default` (the latest CG config).

The published files are small anyway. OpenColorIO-Config-ACES v4.0.0 (2025-10-02, the latest release on GitHub, BSD-3): studio 71.8 KB, CG 32.8 KB, reference 60.6 KB.

**Use the Studio config, not CG.** Measured in v5.0.0:
- Studio has 57 colour spaces, including all the camera logs: ARRI LogC3/LogC4; Sony S-Log3 (S-Gamut3, S-Gamut3.Cine, Venice); RED Log3G10; Canon; Panasonic V-Log; DJI; Blackmagic; Apple Log and Log 2; DaVinci Intermediate.
- CG has 25 colour spaces and no camera logs.
- Both define `scene_linear` = ACEScg, `aces_interchange` = ACES2065-1, `compositing_log` = ACEScct and `data` = Raw.

**Which config a job uses:**
1. the job's own config, if given;
2. else `$OCIO`, which is how studios point every tool at the show's config;
3. else `ocio://studio-config-latest`, resolved to its versioned name.

Record the versioned name and the config's cache ID in `_settings.txt` and in the EXR header (row 30).

The VFX Reference Platform specifies OCIO 2.5.x for CY2026 and 2.6.x for CY2027, with ACES 2.0 in both. `ocio-rs` 0.3 covers OCIO 2.4.1 to 2.5.x.

## 6. Where the transforms go

**Decode**
- EXR is read as float, as today.
- Video uses the stream's own matrix and range when a colour space is set; BT.601 only for "as CK2.0".

**Input processor:** studio input space → "Linear Rec.709 (sRGB)".
- Built with `GetProcessorFromConfigs(studio config, input space, built-in config, "Linear Rec.709 (sRGB)")`.
- Special case: "sRGB/Rec.709 display, as CorridorKey 2.0" keeps today's IEC path, bit-identical.

**The two views made from that, as today**
- Model view: bf16 of asinh of the linear Rec.709 values. Signed, negatives kept, so it stays reversible.
- Display view: bf16 of IEC sRGB of the values clipped at 0, then clipped to [0, 1].

**After the network**
- **Alpha is never colour-transformed.** It is data (the EXR channel A); chromaticities don't apply to it.
- **Foreground:** asinh → linear Rec.709 → despill in linear Rec.709 (as trained) → output processor to the output space.
  - The output space is chosen per output. The default is the input's working space, e.g. ACEScg for ACES plates.
  - Video outputs in a camera log only if asked.
- **Cutout:** premultiplied only in a linear output space. Log and display outputs get straight colour plus alpha (the Nuke convention).
- The checker preview stays on the display path.
- Run the processors in float32, in parallel over rows, before the bf16 rounding.

**EXR metadata**
- Write `chromaticities` plus the OCIO colour-space and config names into the header (row 30 g).
- On input, read `chromaticities`, `acesImageContainerFlag` and the config's file rules to suggest an input space. Always show the suggestion; never apply it silently (row 10).

**Protocol (additive, protocol 1 stays)**
- `run` gains:
  - `color_config`: a path or `ocio://` name. Absent means `$OCIO`, else the built-in studio config.
  - `input_colorspace`: absent means today's behaviour (video/PNG as sRGB, `frame_dir_linear` for EXR).
  - `output_colorspace`: absent means linear Rec.709, as today.
  - optionally `ocio_optimization`.
- A new `colorspaces` command `{config}` replies with:
  - the resolved config: versioned name, cache ID, OCIO version;
  - its roles;
  - every colour space with name, family, encoding, `isdata` and aliases, so the app can build grouped menus.
- `pong` adds `"ocio": "2.5.2"`.
- An unknown space or config is a `bad-request` carrying OCIO's message.
- Old apps keep working, and old engines ignore the new fields.

**UI**
- Per clip: an Input space menu grouped by family, with any suggestion marked as a suggestion, and an Output space menu.
- In Settings, the config choice:
  - "Use $OCIO", with the path shown;
  - "Built-in ACES Studio vX";
  - Browse….
- The job log names both spaces and the config.

## 7. Test plan

1. **Round trip without the model** (engine unit test).
   - What: input space → model space → back, with output = input.
   - Inputs: a 64³ lattice, random signed HDR values and log codes, for every space in the studio config.
   - Pass: within 4 float32 eps of the pixel's largest channel for linear spaces, and within 1e-3 of a 10-bit code for log spaces with LOSSLESS.
   - Measured today: 3.1 eps and 1.8e-4 of a code.
2. **Agreement with OCIO's reference.** The engine's processors against PyOpenColorIO pinned to the same OCIO version, on the same inputs.
   - Pass: bit-identical (already measured for `ocio-rs`).
   - Across OCIO versions or flags: within 5e-5 of the pixel's largest channel.
3. **Today's keys unchanged.** The "sRGB/Rec.709 display, as CK2.0" input and EXR as linear Rec.709 must give today's mattes bit-identically.
4. **Tears of Steel, re-encoded.**
   - Convert 04_5d to ACES2065-1 and to ACEScg with `ocioconvert`.
   - Key with the input space set and output linear Rec.709, then run matte_compare against today's key.
   - Expect identical mattes except where bf16 rounding flips; count and report those.
   - Then key with output ACES2065-1 and compare with `ocioconvert` applied to today's foreground.
5. **Camera log, synthetic then real.**
   - Synthetic: 04_5d converted to LogC4 and S-Log3 as 12-bit ProRes 4444 / DNxHR 444 (tagged BT.709, full or limited range), keyed with the matching input space, against the EXR baseline. The only difference should be 12-bit quantisation.
   - Real: a manufacturer sample plate (ARRI ALEXA 35 LogC4, Sony Venice S-Log3, RED Log3G10), keyed directly, vs the same plate converted to linear Rec.709 EXR with `ocioconvert` and keyed on the linear path. They should match.
6. **Alpha stays data:** byte-identical alpha for every choice of output space.
7. **A studio config:** the E4 config (show LUT, `$SHOT`, CDL, a look) with `$OCIO` honoured, bit-identical to PyOpenColorIO.
8. **Same output on every platform.** The same plate gives byte-identical processor output on Linux, real Windows and the Mac. Apple Silicon has no SSE2, so its numbers may differ; measure, and state the tolerance if so.
9. **Wide gamut, on a real ACEScg plate.**
   - Report the share of pixels outside Rec.709.
   - Compare mattes keyed with signed values against mattes keyed with values clipped at 0 before the model. This shows whether the model handles negatives.
10. **Build guard.** A unit test fails on a stub build, and the release script checks OCIO's version in `pong`.

## 8. Decisions for Marcy

1. **Default EXR output space:** back to the clip's input working space (ACEScg in → ACEScg out), or the config's `scene_linear` role? My pick: the input's own space, since that is what "comes back in the studio's space" means.
2. **Camera-log video outputs:** offer foreground video in camera log (LogC4 DNxHR/ProRes), or EXR only for colour-managed outputs?
3. **Out-of-gamut colours:** colours outside Rec.709 reach the model as negatives — exact and reversible, but possibly never seen in training (unknown). Keep them signed and measure with test 9 (my pick), or gamut-compress before the model, which changes colours and can't be undone? It's also worth asking Corridor / Zachary Harris which colour space the training data used.
4. **Bindings or our own shim:** bindings (a) or our own shim (b)? If (a), should we offer the four `build.rs` fixes upstream to `ocio-rs`?
5. **OCIO version:** OCIO 2.5 (CY2026) now, and 2.6 (CY2027) once the binding supports it?
6. **When `$OCIO` is set:** use it automatically with the path shown (what studios expect, my pick), or ask the first time?

## Not verified

- macOS builds of either crate.
- Building OCIO's CMake with Zig for glibc 2.28.
- Runs on real Windows (only Wine).
- Apple Silicon numerics.
- The training data's colour space.
- Behaviour on real camera-log and real ACEScg plates.
- ARRI's LogC4 PDF was not fetched. I used the constants published in it, and OCIO matched them to 1e-5.

## Sources

- CorridorKey 2.0 upstream: https://github.com/nikopueringer/CorridorKey2.0 (read from the local checkout `~/projects/CorridorKey2.0`, commit c1b8e41)
- OpenColorIO releases (v2.6.0 2026-10-01, v2.5.2 2026-05-13; BSD-3): https://github.com/AcademySoftwareFoundation/OpenColorIO/releases
- OCIO 2.6 release notes: https://opencolorio.readthedocs.io/en/latest/releases/ocio_2_6.html
- OCIO 2.2 notes (`ocio://` names, `CreateFromBuiltinConfig`): https://opencolorio.readthedocs.io/en/main/releases/ocio_2_2.html
- OCIO 2.3 notes (`studio-config-latest`): https://opencolorio.readthedocs.io/en/main/releases/ocio_2_3.html
- Using OCIO (`$OCIO`, `OCIO_ACTIVE_DISPLAYS`): https://opencolorio.readthedocs.io/en/latest/guides/using_ocio/using_ocio.html
- ACES Studio config (built-in names up to v5.0.0 / ACES 2.1): https://opencolorio.readthedocs.io/en/latest/configurations/aces_studio.html
- ACES CG config: https://opencolorio.readthedocs.io/en/latest/configurations/aces_cg.html
- ACES config releases (v4.0.0, file sizes; BSD-3): https://github.com/AcademySoftwareFoundation/OpenColorIO-Config-ACES/releases
- OCIO MinGW issues:
  - https://github.com/AcademySoftwareFoundation/OpenColorIO/issues/2283
  - https://github.com/AcademySoftwareFoundation/OpenColorIO/issues/2284
  - https://github.com/AcademySoftwareFoundation/OpenColorIO/issues/2358
  - https://github.com/AcademySoftwareFoundation/OpenColorIO/issues/2136
  - https://github.com/AcademySoftwareFoundation/OpenColorIO/issues/2187
  - MinGW support PR: https://github.com/AcademySoftwareFoundation/OpenColorIO/pull/1485
- `ocio-rs` / `ocio-sys` 0.3.0 (BSD-3; README and STATUS.md describe the stub default and the bundled OCIO 2.5.2): https://crates.io/crates/ocio-rs and https://github.com/shaloong/ocio-rs
- `ocio` 0.2.2 (MIT and BSD-3; README, PORTING.md, UPSTREAM.md; contributor list from the GitHub API): https://crates.io/crates/ocio and https://github.com/doubleailes/ocio-rs
- `opencolorio` 0.1.0, an empty placeholder from 2020: https://crates.io/crates/opencolorio
- VFX Reference Platform: https://vfxplatform.com/
- Tears of Steel colour pipeline: https://mango.blender.org/production/4-tb-original-4k-footage-available-as-cc-by/
