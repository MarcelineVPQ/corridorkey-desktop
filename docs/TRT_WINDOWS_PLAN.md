# TensorRT on Windows (BACKLOG row 178): implementation plan

Written 2026-10-30, read-only research (no builds, no runs, no GPU, nothing in the repo changed); Marcy's decisions
are at the end. Line numbers are the working tree of 2026-10-30, before commit 68d2e99 (the TensorRT checklist
changed index.ts, trtPrebuild.ts, SetupParts.tsx, types.ts and pipeline code), so re-check them before editing.

## 1. Verdict

**Feasible in the current release flow, with one change to it: `ck-trt-build.exe` can't be built with MinGW, so
GitHub's Windows runner builds it with MSVC and `tools/release.sh` downloads it from that run, the same way it
already takes the macOS image (`release.sh:81-101`).** Everything else is in place or is a small change.
*Superseded by decision 1 (end of this file): the builder is built on Marcy's PC with clang-cl + lld-link + xwin, not
on GitHub's runner, so Steps 4 and 6 change accordingly.*
NVIDIA publishes a `win_amd64` wheel of the exact TensorRT version Linux uses (10.16.1.11, 1.91 GB). ONNX Runtime
1.31's Windows wheel, which users already download, contains `onnxruntime_providers_tensorrt.dll`. The Windows
engine is already built with `tensorrt`. The app's PATH setup already covers `<runtime>\tensorrt_libs`.

**The hardest blocker is the C++ ABI.** TensorRT's C++ API is a set of virtual interfaces whose first slot is a
virtual destructor (`apiv::VRoot`, NvInferImpl.h:252-255). GCC/MinGW (Itanium ABI) and MSVC lay out those vtables
differently, so a MinGW-built builder would call the wrong methods. The fix is cheap but needs a real Windows
compiler. The wheel ships no `.lib` import libraries, so the Windows builder loads the two entry points with
`LoadLibraryW`/`GetProcAddress`. CI then needs no TensorRT download at all. Only the GPU behaviour is unproven:
WDDM memory, the build itself, and the EPContext stub on Windows paths. That needs the one rented-server test
(section 5).

## 2. Verified facts

| # | Fact | Source |
|---|---|---|
| F1 | `tensorrt_cu13_libs-10.16.1.11-py3-none-win_amd64.whl` exists; **sha256 `96262c3e8c64a45abd29aa3482d99480fac6845bd420b6de125699bb1ae365ff`** | https://pypi.nvidia.com/tensorrt-cu13-libs/ (index fragment) |
| F2 | Its size is **1,911,173,812 bytes** (HTTP Content-Range of a range request); URL `https://pypi.nvidia.com/tensorrt-cu13-libs/tensorrt_cu13_libs-10.16.1.11-py3-none-win_amd64.whl` | read 2026-10-30 (the wheel's central directory only) |
| F3 | Contents: `tensorrt_libs/nvinfer_10.dll` (375,812,208), `nvinfer_plugin_10.dll` (43,440,240), `nvonnxparser_10.dll` (3,268,208), `nvinfer_builder_resource_{sm75,sm80,sm86,sm89,sm90,sm100,sm120,ptx}_10.dll`, `__init__.py`, `dist-info/LICENSE.txt` (47,141). **All DLLs together unpack to 2,326,271,184 bytes (2.33 GB).** **There are no `.lib` import libraries and no headers.** | the wheel's central directory, read 2026-10-30 |
| F4 | Unpacked/packed ratio on Windows is **1.22** (Linux keeps 2.6 of 3.7 GB). `runTrtInstall` reserves `libs.size * 1.8` (install.ts:918) but needs about 2.22× here (wheel + unpacked side by side): **under-reserves about 0.8 GB on Windows** | F2, F3, install.ts:918 |
| F5 | The licence is NVIDIA's TensorRT SLA (LICENSE.txt sha256 `c86915fd…88b4`). Redistribution is granted only for libnvinfer and libnvinfer_plugin as part of an app, not for the builder resources. **So keep the Linux model: the user's machine downloads from NVIDIA; we never mirror or ship the DLLs.** The licence folder is kept beside the libraries (install.ts `TRT_DIST_INFO`; the regex `LICENSE[^/]*` matches `LICENSE.txt`) | LICENSE.txt §12.1 (fetched from the wheel); install.ts:736 |
| F6 | The pinned Windows ONNX Runtime wheel (`onnxruntime_gpu-1.31.0-cp312-cp312-win_amd64.whl`, 168,098,204 B, already in `RUNTIME_WIN`, install.ts:105-108) contains **`onnxruntime/capi/onnxruntime_providers_tensorrt.dll`, 912,184 B**. `keepFromWheel` leaves it out on Windows (install.ts:350-351) | the wheel's central directory, read 2026-10-30 |
| F7 | That provider DLL imports `nvinfer_10.dll` (`createInferBuilder_INTERNAL`, `createInferRuntime_INTERNAL`, `createInferRefitter_INTERNAL`, `getInferLibVersion`, `getPluginRegistry`), `nvonnxparser_10.dll`, `cublas64_13.dll`, `cudnn64_9.dll`, `MSVCP140`/`VCRUNTIME140(_1)` and `onnxruntime_providers_shared.dll`. It is MSVC-built (`.?AVILogger@nvinfer1@@` RTTI). **It therefore matches TensorRT 10's DLL names and CUDA 13 (cuBLAS 13, cuDNN 9), all present in the existing runtime download or the TensorRT wheel.** | PE import table of the extracted DLL |
| F8 | `nvonnxparser_10.dll` exports `createNvOnnxParser_INTERNAL`, `createNvOnnxParserRefitter_INTERNAL` and `getNvOnnxParserVersion`. Its imports are only KERNEL32, dbghelp and api-ms-win-crt (static C++ runtime) | PE tables of the DLL from F1 |
| F9 | The TensorRT API's entry points are `extern "C"` (`createInferBuilder_INTERNAL(void* logger, int32_t version)`, NvInfer.h:12484; `createNvOnnxParser_INTERNAL(void*, void*, int)`, NvOnnxParser.h:592). The inline `createInferBuilder`/`createParser` wrap them (NvInfer.h:12498-12500, NvOnnxParser.h:618-620). Everything else is virtual calls | pinned headers, engine-rs/target/trt-build/include |
| F10 | **MinGW can't build it:** `apiv::VRoot` starts with `virtual ~VRoot() noexcept` (NvInferImpl.h:252-255). The Itanium ABI (GCC, MinGW, clang `-windows-gnu`) gives a virtual destructor 2 vtable slots, MSVC gives it 1, and MSVC also orders overloaded virtuals differently. Every call after the destructor would land one slot off. *Inferred from the ABIs' documented layouts (Itanium C++ ABI §2.5; MSVC behaviour), not tested.* | NvInferImpl.h:252-255; https://itanium-cxx-abi.github.io/cxx-abi/abi.html#vtable |
| F11 | GitHub's `windows-latest` is Windows Server 2025 with **Visual Studio Enterprise 2022 17.14, VC.Tools.x86.x64, Windows SDK 10.0.26100** | https://github.com/actions/runner-images (label table); https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md |
| F12 | ck_trt_build.cpp is already Windows-ready in source: `wmain` with UTF-8 conversion, `SetDllDirectoryW(L"")`, wide paths, `MoveFileExW` (ck_trt_build.cpp:15-16, 81-95, 173-181, 232-245). Only the two `create*` calls (lines 167, 171) and the build need changing | file |
| F13 | The engine already finds `ck-trt-build.exe` next to itself (tensorrt.rs:122-134, `EXE_SUFFIX`). It already probes `nvinfer_10.dll` (gpu.rs:381-401). The Windows engine is built with `--features ort-dynamic,cuda,tensorrt,ocio` (tools/build_engine.sh:43). The builder child joins the engine's job object on Windows (proc.rs:88-95), so it dies with the engine | files |
| F14 | The app's PATH for the engine already includes `<runtime>\tensorrt_libs`, the CUDA `bin\x86_64` folders and the MSVC runtime folder (engine.ts:62-79). The builder inherits that environment (tensorrt.rs:153, `Command::new`), so nvinfer and its builder-resource DLLs load by name through PATH. **No change is needed there** | engine.ts, tensorrt.rs |
| F15 | The Linux-only switches are `trtSupported` (install.ts:872), `storageItems` `platform === "linux"` (storage.ts:71,77), `TRT_BUILDER = "ck-trt-build"` without `.exe` (engineFind.ts:114), `TRT_PROVIDER` `.so` (install.ts:732), `keepTensorrt` `.so` regexes (install.ts:781-785), the unpack check `libnvinfer\.so` (install.ts:933), and `index.ts:203 trtAllowed` (follows `trtSupported`) | files |
| F16 | `gpu.ts isOurs` follows parents through `/proc` only (gpu.ts:105-131). **On Windows a running `ck-trt-build.exe` counts as "another program on the graphics card"**, and that can block or pause the background build (index.ts `othersOnGpu`, :447). *Whether `nvidia-smi --query-compute-apps` lists processes under WDDM at all: unknown.* | files |
| F17 | The release cross-builds Windows with MinGW (`npm run dist:win`, package.json:15). It already requires a green `windows.yml` run of HEAD (release.sh:133). Precedent for taking a binary from a CI run: `gh run download` of the macOS run (release.sh:91) | files |
| F18 | The TensorRT 10.16.1 release notes apply to "x86 Linux and Windows users". **The Windows OS, driver and compute-capability minimums for 10.16 were not retrievable** (the interactive support matrix didn't render): unknown. The wheel carries builder resources for sm75 to sm120 plus PTX, so Turing and newer is *inferred* | https://docs.nvidia.com/deeplearning/tensorrt/10.16.1/getting-started/release-notes-10/10.16.1.html |
| F19 | ONNX Runtime's TensorRT EP page lists versions only up to ORT 1.22. **There is no published 1.31 + TensorRT 10.16 statement for Windows.** Compatibility rests on F7 and on Linux's working 1.31 + 10.16.1 pair | https://onnxruntime.ai/docs/execution-providers/TensorRT-ExecutionProvider.html |
| F20 | Microsoft's STL (static with `/MT`) is Apache-2.0 WITH LLVM-exception. *The static vcruntime/UCRT parts fall under Visual Studio's "Distributable Code" terms: inferred, not checked today* | https://github.com/microsoft/STL/blob/main/LICENSE.txt |

## 3. The plan (one pass)

**Step 1. Builder: load TensorRT at run time on Windows** (`engine-rs/tools/trt-build/ck_trt_build.cpp`)
- Under `#ifdef _WIN32`, before line 167: `LoadLibraryW(L"nvinfer_10.dll")` and `LoadLibraryW(L"nvonnxparser_10.dll")`.
  Search order: exe folder, System32, PATH; the current folder is already removed by `SetDllDirectoryW(L"")`.
  Then `GetProcAddress` `createInferBuilder_INTERNAL` / `createNvOnnxParser_INTERNAL`, and call them exactly as the
  inline wrappers do: `(&log, NV_TENSORRT_VERSION)` and `(net.get(), &log, NV_ONNX_PARSER_VERSION)`.
- A missing DLL or symbol → `fail("TensorRT libraries: nvinfer_10.dll not found (…GetLastError)")`, which prints
  the one JSON line, not a loader dialog. Linux keeps linking as today (no change).
- Update the header comment (line 15: "MinGW builds with -municode" → MSVC).
- Check: the Step 4 CI job runs the exe with no TensorRT present and expects
  `{"ok":false,"error":"TensorRT libraries: …"}` and exit 1. A second run with no arguments expects `missing --onnx`.

**Step 2. Builder build script: an MSVC mode** (`engine-rs/tools/trt-build/build.sh`)
- Add `--msvc`: the same pinned headers and sha256 checks, the same stand-in `cuda_runtime_api.h`, then
  `cl -nologo -O2 -std:c++17 -EHsc -MT -utf-8 -W3 -wd4996 -I"$INC" ck_trt_build.cpp -Fe"$OUT/ck-trt-build.exe"`.
  Use dash switches: Git Bash rewrites `/O2`-style arguments into paths. Link only kernel32 (the default).
- `/MT`: no MSVCP/VCRUNTIME DLL needed, like nvonnxparser itself (F8).
- Check: Step 4 runs `dumpbin /dependents` and requires KERNEL32.dll only. Any other DLL fails the job, the
  same rule as build_engine.sh:50-52.

**Step 3. Downloads: a Windows TensorRT pin** (`electron/main/install.ts`)
- `TENSORRT.libs` becomes per platform (`tensorrtLibsFor(platform)`). Windows: file
  `tensorrt_cu13_libs-10.16.1.11-py3-none-win_amd64.whl`, url `https://pypi.nvidia.com/tensorrt-cu13-libs/<file>`,
  size `1911173812`, sha256 `96262c3e8c64a45abd29aa3482d99480fac6845bd420b6de125699bb1ae365ff`, plus an
  `unpacked: 2326271184` used by the room check. Linux stays as it is. `trtCatalogFor` passes `platform` through
  (line 806).
- `TRT_PROVIDER`: `onnxruntime_providers_tensorrt.dll` on win32 (used by `trtPaths`, `trtReady` and the provider
  step, lines 732, 818, 866, ~950).
- `keepFromWheel` (line 351): keep `onnxruntime_providers_tensorrt.dll` too (912 KB), so new Windows runtimes need
  no second ORT download. Older ones get it through the existing provider step.
- `keepTensorrt`: add `^tensorrt_libs/(nvinfer|nvinfer_plugin|nvonnxparser)_10\.dll$` and
  `^tensorrt_libs/nvinfer_builder_resource_(ptx|sm\d+)_10\.dll$` (all of F3 except `__init__.py`).
- The unpack check (line 933) per platform (`nvinfer_10\.dll`).
- Room (line 918): `libs.size + libs.unpacked` instead of `libs.size * 1.8` (F4). **USERS' DISK: flagged.**
- `trtSupported` (line 872): `platform === "linux" || platform === "win32"`. `index.ts:203` keeps `!AMD_GFX`.
- Checks (tests/unit/install.test.ts, runs on Linux and macOS CI with `platform` injected):
  - "Windows pins NVIDIA's win_amd64 TensorRT wheel": file, url, size, sha256.
  - "the Windows and Linux TensorRT wheels are the same version" (both 10.16.1.11).
  - `keepTensorrt` keeps every F3 DLL and the licence, and drops `__init__.py`.
  - `trtSupported` is `[true, true, false]` (the existing assertion at line 794 changes).
  - The room check refuses at 1.8× and passes at size + unpacked.

**Step 4. CI: build and smoke-test the builder on Windows** (`.github/workflows/windows.yml`)
- New job `trt-builder` (windows-latest):
  - checkout;
  - `shell: cmd`: `call` vcvars64.bat, located with `vswhere -latest -property installationPath`, then
    `"C:\Program Files\Git\bin\bash.exe" engine-rs/tools/trt-build/build.sh --msvc engine-rs/target/trt-build`;
  - `dumpbin /dependents` (KERNEL32 only);
  - the two smoke runs from Step 1;
  - upload artifact `ck-trt-build-windows` (the exe and its sha256), `retention-days: 30`.
- The `app` job gets `needs: trt-builder`. It downloads the artifact into `engine-rs/target/dist/`, so the packaged
  app in CI carries the real builder.
- Check: the job is green, and the packaged `release/win-unpacked/resources/engine/ck-trt-build.exe` exists (one
  `test -f` line in the app job).

**Step 5. Packaging** (`electron-builder.yml` win `extraResources`, after line 73)
- `engine-rs/target/dist/ck-trt-build.exe` → `engine/ck-trt-build.exe`.
- `package.json` `dist:win`: fail with a clear message when the file is missing
  (`test -f engine-rs/target/dist/ck-trt-build.exe || { echo 'run tools/fetch_trt_builder_win.sh'; exit 1; }`).
- Check: Step 4's `test -f`; tests/unit/packaging.test.ts asserts the win extraResources entry.

**Step 6. Release: take the builder from the green Windows run** (`tools/release.sh`, new
`tools/fetch_trt_builder_win.sh`). **RELEASE PATH: flagged** (no change to feed signing or the updater)
- After the green-run check (release.sh:133), take that run's `databaseId`. Then
  `gh run download <id> -n ck-trt-build-windows -D engine-rs/target/dist`, compare the sha256 file, and check the
  imports with `x86_64-w64-mingw32-objdump -p` (KERNEL32 only), before `npm run dist:win` (line 146).
- The exe reaches users inside the NSIS installer, which `SHA256SUMS` (signed) already covers. The update feeds name
  the AppImage only, so the updater is unchanged.
- Check: the release refuses a run without the artifact, a hash mismatch, or extra imports. Dry-run the script's
  refusal paths with a fake directory (a unit test of the import-list parser, as for build_engine.sh's list).

**Step 7. Finding the builder; the GPU readout** (`electron/main/engineFind.ts:114`, `electron/main/gpu.ts`)
- `TRT_BUILDER` per platform (`ck-trt-build.exe` on win32), like `findCli` (engineFind.ts:136-138).
  Test: engineFind.test "finds ck-trt-build.exe beside a Windows engine".
- gpu.ts `readGpu`: on win32, a compute process whose executable path equals the builder path the app found
  (`findTrtBuilder`) counts as ours. nvidia-smi's `process_name` is the full path on Windows (*inferred; confirm in
  section 5*). Test: gpu.test "Windows: the app's ck-trt-build.exe is ours, another program is not".

**Step 8. Storage and removal** (`electron/main/storage.ts:71,77`, `install.ts removeTensorrt` line 1012).
**USERS' FILES: flagged**
- Replace `platform === "linux"` with `trtSupported(platform)`.
- On Windows a running engine holds `nvinfer_10.dll` open, so `rmSync(p.libs)` fails part-way, after the mark
  (`models-tensorrt.json`) is already gone. Removal must happen only with no engine running: stop the prebuild and
  quit an idle engine first, or refuse in words while a job runs. Also make `removeTensorrt` remove the libraries
  through `removeAside` (rename first, so in use means nothing changed).
- Check: storage.test "Windows lists TensorRT"; install.test "removeTensorrt leaves the parts installed when the
  libraries folder can't be renamed" (injected rename failure).

**Step 9. Words, docs, notices** (re-check SetupParts.tsx:125 and types.ts:353/448/560/770 after commit 68d2e99)
- SetupParts.tsx:125: drop "Linux-only … later". index.ts:1074 comment. install.ts:722/871/874 comments.
  engineFind.ts:113. storage.ts:69.
- Wiki: TensorRT.md title "(Linux)", Installing-on-Windows.md:69, Uninstall.md:11/26, Your-First-Key.md:21/73/88,
  Troubleshooting.md:217, Home.md:29/46. Add a "Windows" section to TensorRT.md: download 1.91 GB, 2.33 GB on disk,
  plus the models.
- README.md:60/66 ("Windows coming"); ENGINE_RUST.md (TensorRT section: the Windows builder is MSVC-built in CI and
  loads TensorRT at run time); RELEASING.md step 2 (the artifact); BACKLOG row 178 status; CHANGELOG.
- `tools/gen_notices.mjs:341,378-385`: the builder row covers Windows (Apache-2.0 headers; Microsoft STL
  Apache-2.0 WITH LLVM-exception, static). Add the Windows TensorRT wheel to the downloads list (the host rule at
  line 230 already covers pypi.nvidia.com). Regenerate THIRD_PARTY_NOTICES.md.
- Checks: `npm run check` gates (check_texts, check_platform_docs, check_docs_touch, check_wiki, check_backlog,
  check_notices_downloads) and `node tools/gen_notices.mjs --check` in linux.yml.

**Step 10. Engine (Rust): no functional change expected.**
- Verify only: the TensorRT-provider readiness check and `tensorrt_version()` on Windows; error texts for a Windows
  crash exit (`0xC0000005` / exit code instead of "signal 9") in tensorrt.rs's classification (lines ~740-775).
  Add a unit test so that a Windows crash code counts as transient, not "can't be built".
- Check: `windows.yml` engine job (`cargo test`) and `tools/check_targets.sh`.

## 4. CI / release changes

**Decided (Marcy 2026-10-30): build `ck-trt-build.exe` on her PC with new tooling: clang-cl + lld-link + xwin (much
faster there).** It replaces the CI-artifact route below. Consequences:
- The Microsoft CRT/SDK (~1 GB via xwin) is downloaded once onto her PC, after she accepts Microsoft's licence.
- `tools/check_targets.sh` and `npm run dist:win` gain the clang-cl step.
- release.sh needs no artifact download (step 8 changes).

- **MinGW vs MSVC:** the engine and CLI stay MinGW cross-builds (C API to ONNX Runtime, unaffected). Only
  `ck-trt-build.exe` needs MSVC (F10).
  - The cross-build is clang-cl + lld-link + `xwin`, which downloads Microsoft's CRT/SDK onto Marcy's PC (a licence
    acceptance, about 1 GB): the route decided above (the research had recommended the CI route instead).
  - Zig's `-windows-msvc` target also needs the MSVC libraries: same problem.
- **Runner:** windows-latest (VS 2022 17.14, F11). Expected time *(inferred)*: about 1-2 min (header fetch + one
  250-line C++ file). No TensorRT download in CI.
- **Release dependency:** `release.sh` already needs a green `windows.yml` run of HEAD. It now also needs that
  run's artifact, which lives 30 days.
- **Artifact sizes** *(inferred)*: the `/MT` exe is about 0.3-1 MB, so the installer grows by under 1 MB. The
  user's opt-in TensorRT download on Windows is 1.91 GB (Linux 3.73 GB) plus the same TensorRT models; it unpacks
  to 2.33 GB. Room needed during the install is about 4.2 GB plus the models.
- **Code signing:** the Windows installer is unsigned today, and this adds one more unsigned exe inside it.
  SmartScreen/Defender reaction: unknown. Feed signing is untouched.

## 5. The final Windows + NVIDIA test (rented HOSTKEY server, on Marcy's call only)

Preconditions: the code is ship-ready, a dev build's Setup.exe exists, and the server has an NVIDIA card of 16 GB
or more with a CUDA 13 capable driver. One pass, in order, each step one run:

1. Install the app and the normal runtime and models (as the VM check). Switch on TensorRT. The download (1.91 GB
   wheel + TensorRT models) installs; Storage shows the TensorRT item with its size.
2. Background build of the 4K range, then the HD range. Watch that the GPU readout doesn't call
   `ck-trt-build.exe` "another program" (Step 7).
3. **One 48-frame 4K clip** on TensorRT. The job page says TensorRT ran (Technology for this run).
4. **One ~100-frame HD clip** on TensorRT.
5. Storage → remove TensorRT with the app idle; the folders are gone.

Minutes *(estimates from Linux numbers; Windows build speed unknown)*:

| Item | Minutes |
|---|---|
| Server setup, app install | 15 |
| Downloads: runtime, models and TensorRT, about 1 Gbps | 10 |
| TensorRT builds: 4K, five networks (Linux about 5 min) | 6 |
| TensorRT builds: HD (about 3-4 min) | 4 |
| 4K 48-frame run (load + about 20 s) | 2 |
| HD 100-frame run | 2 |
| Removal and log collection | 5 |

**About 45 min of server time in all, about 15 of it on the GPU.** Collect the job logs and the engine's stderr.

## Decisions (Marcy 2026-10-30)

1. **Builder:** built on her PC with clang-cl + lld-link + xwin (section 4).
2. **Removing TensorRT while an engine holds its DLLs** (recommended, awaiting her OK):
   - Refuse while a job is keying, as today.
   - Quit an idle engine (estimate, windows read) and wait for it to exit, then delete.
   - Remove the "installed" mark last, so a failed delete leaves it installed and names the file.
3. **Release:** it ships together with other work in a dev build, not on its own.
4. **Order:**
   - Build all of it first.
   - Then an independent senior review of the work.
   - Then publish as a dev build with Windows TensorRT labelled **experimental**.
   - The rented Windows + NVIDIA server test (section 5) counts as the confirmation of the driver and Windows
     minimums; no separate NVIDIA check. It runs after the review, on her call.
   - Development build: the extra care still applies only to users' files, disk space and the updater (the steps
     flagged USERS' DISK, USERS' FILES and RELEASE PATH).

## 6. Open questions for Marcy (answered above)

1. CI-built `ck-trt-build.exe` downloaded by `release.sh` (recommended), or a cross-build on your PC with
   clang-cl + xwin (new tooling, Microsoft SDK download)?
2. Removing TensorRT on Windows while an engine is idle: should Storage quit the engine itself, or refuse with
   "close the queue first"?
3. Ship Windows TensorRT in the same dev build as other work, or a dev build of its own, so the HOSTKEY test
   covers it alone?
4. Do we need the TensorRT 10.16 Windows minimums (driver, Windows 10 vs 11) from NVIDIA's interactive matrix
   before shipping, or does the rented-server test count as proof (setup text: "NVIDIA driver 580 or newer"
   *inferred* for CUDA 13)?
