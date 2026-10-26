# Rust engine review, 2026-10-26 (before 1.0.0-dev.1)

Independent senior review of `engine-rs/` at `main` f32ba6d: ck-core, ck-engine and the C++ TensorRT builder
(`tools/trt-build`). I read CLAUDE.md, docs/ENGINE_RUST.md, docs/ENGINE_PROTOCOL.md, the README's engine sections and
every source file under `engine-rs/crates` and `engine-rs/tools` in full. I did not read the earlier reviews, bug
hunts or passes. `engine-rs/vendor` was skipped.

What I ran (memory-capped, CPU only, own target dir, removed afterwards):
- `cargo clippy --workspace --all-targets -- -W clippy::pedantic`: builds clean. It gives 1023 pedantic warnings,
  almost all documentation style, `must_use` and numeric-cast lints. None of them points at a real defect beyond the
  ones below.
- `cargo test --workspace`: all 168 pass (136 ck-core unit, 16 parity, 1 OCIO round trip, 14 protocol, 1 lifetime).
- The engine binary, `--device cpu`, driven over its protocol with crafted inputs (M1, NICE 1).
- ffmpeg 8.0.1's DNxHR encoder at small sizes (S1).

## Verdict

**Grade: A−. Ready for a first public dev build once M1 is fixed. M1 is a small change (S).**

This is a careful engine. The protocol loop is small and robust. Every child process and wait has a deadline, and
the engine ends with its parent on all three systems. Errors carry protocol codes and plain words. The ported maths
is pinned against the Python reference with real fixtures. The pipeline itself is tested end to end on fake
networks, and those tests assert the right things: window coverage, the Hann blend, phase order, retry rules and
clean stops. The unsafe/FFI surface (NVML, the CUDA driver, TurboJPEG, prctl, the Win32 job object, mach) is small.
It is commented and sized correctly as far as I can check.

What is left falls into three groups:
- one robustness gap that can take the whole engine down on a single bad input (M1);
- three cases where a job wastes a lot of work, or the engine dies, before it reports an error (S1 to S3);
- a set of smaller edge cases and maintainability points.

## Findings

### MUST

**M1. No upper limit on frame size: one frame whose header claims a huge size aborts the engine (no error reply,
the rest of the queue is lost).** Proved.
- Where:
  - `clip.rs:145-155` `model_shape_supported` checks only the lower bound.
  - `clip.rs:460` takes the size from the first frame's header.
  - `decode.rs:296-305` allocates the EXR buffer from the header's data window (`res.width() * res.height() * 3`).
  - `decode.rs:281`: TurboJPEG allocates from the header in the same way.
  - `decode.rs:619-620`: later frames of a folder are fully decoded before their size is compared with the first's.
- Failure: I patched the header of a 320×200 EXR to claim 100000×100000.
  - `estimate` answered normally.
  - A `run` (CPU, real onnx.4 RVM) loaded RVM. Then the decoder thread died with `memory allocation of
    120000000000 bytes failed` and the process exited with 134 (SIGABRT).
  - The `ping` and `quit` queued behind the run were never answered. `catch_unwind` cannot catch an allocation
    abort.
  - Any frame in a folder can trigger it, not only the first, because a frame is decoded before its size is
    checked.
- A real file does it too, not only a crafted one. A legitimate 8K-16K plate gets no early refusal, and host memory
  in flight scales with frame area:
  - `FOLDER_BATCH` = 4 float frames decoded in parallel;
  - 8 prefetched frames per reader, and two or three readers at once;
  - the window cache.
  - At 16K that is tens of GB before any GPU check, on a desktop that also runs the user's apps.
- Fix (S):
  - Refuse sizes past a stated limit at probe time, as an `input` error with words. `trt_build` already caps at
    16384 a side (`ck-engine/src/lib.rs:187`); `run` and `estimate` have no cap.
  - Read each folder frame's header size (`image_size`) before allocating its pixels.
  - Optionally scale the prefetch depth with frame area.

### SHOULD

**S1. DNxHR 444 at a width under 256 keys the clip and then fails, and the error shows "Broken pipe" without
ffmpeg's reason.** Proved for the encoder; the engine path is code-read.
- Where: `writers.rs:228-234` checks `odd_size_for` only for `h264-crf12`; `writers.rs:147` sets `TAIL_LINES = 6`.
- The engine accepts any side above 128 px.
- ffmpeg 8.0.1's `dnxhd`/`dnxhr_444` refuses widths below 256. I tested 200×150, 255×130, 129×300 and 255×2000:
  all print "Input dimensions too small, input must be at least 256x120". 256×129 and 321×199 work.
- The writer's ffmpeg dies at its first frame. In low-VRAM mode the first frame is only written after the RVM pass,
  the foundations and every stage-1 window, so the whole stage-1 cost is spent first.
- At `-loglevel error`, ffmpeg prints 10 lines for this failure and the reason is the first one. The writer keeps
  only the last 6, so the job's message ends in "Nothing was written into output file".
- This is the same class as the odd-size `pix_fmt` bug fixed in the 2026-10-26 hunt.
- Fix (S): refuse width < 256 or height < 120 for `dnxhr444` in `VideoWriter::new`, as a `bad-request`, the way
  `odd_size_for` does. Also keep the first error line next to the tail.

**S2. The out-of-memory retry halves the window for any OOM before the first frame is written, including OOMs in
phases the window doesn't affect.** Code-read.
- Where: `pipeline/mod.rs:570`. The condition is `Oom && !manual && nothing_written && chunk > 1`, whatever the
  phase.
- In low-VRAM mode, stage 2, RVM, the foundations' 4-frame batches and every session load are independent of the
  window.
- Failure: stage 2 runs out of memory on its first frame. Examples: the card is shared, the clip is large, or a
  game started.
- The job then re-runs the full RVM pass, foundations and every stage-1 window up to 7 times (80 → 40 → … → 1)
  before it fails anyway. Stage 1 is about half of a job's time, so for a 4K clip that can be hours of GPU time
  for a certain failure.
- Each retry also sends a `memory` reply, and its window changes the matte, for nothing.
- Fix (S-M): make the OOM error say which network or phase failed. `Error::ort` already receives `what`; keep the
  piece in a field. Halve only for stage 1, or for the normal mode's window phase. Fail at once otherwise, saying
  the frame size doesn't fit.

**S3. `estimate`, `colorspaces` and `ping` run outside `catch_unwind`, so a panic there kills the engine; the
`trt_build` panic path skips `reset`.** Code-read.
- Where: `ck-engine/src/lib.rs:379-403`. `run` (`lib.rs:441`) and `trt_build` (`lib.rs:196`) are protected.
- `estimate` parses untrusted file headers through the `exr`/`image` crates (`clip::probe_size`).
  `colorspaces` loads an arbitrary OCIO config through FFI.
- A panic in either dependency on a malformed file ends the process, and every queued request is lost. A `run` on
  the same file would only fail.
- After a `trt_build` panic, `backend.reset()` is not called, unlike `run_job` (`lib.rs:446`).
- Fix (S): wrap the whole per-request dispatch in one `catch_unwind` that replies `engine` with the panic text, and
  call `reset` on every caught panic.

### NICE

1. **A numeric `id` comes back as a string** (proved: `"id":7` → `"id":"7"`; `lib.rs:263-268` `str_field`).
   Echo the request's own JSON value, or refuse a non-string id. S.
2. **`hann_chunk` has no upper bound in `run`** (`job.rs:208-218`), while `estimate` caps windows at 4096
   (`vram.rs:174`). A large manual window in normal mode keeps every decoded frame of the clip in host memory
   (`WindowReader` cache plus `stage2_frames`), about 0.1 GB per 4K frame. Use one cap for both. S.
3. **`Ahead` has no `Drop` that joins its producer** (`ahead.rs:247-314`).
   - After an error or an OOM retry, the previous attempt's producer threads (a whole window's decode, prefetchers
     with their ffmpeg) keep running and holding host memory while the next attempt starts its own.
   - The overlap is transient, but it lands exactly in the retry path.
   - Fix: drop `rx`, then join in `Drop`. S.
4. **One wait has no deadline.** The ffmpeg feed thread's `write_all` (`writers.rs:256-262`) and the render
   thread's queue (`outputs.rs:95-101`) can block for as long as ffmpeg stops reading, for example on a stalled
   network mount. ENGINE_RUST.md says "No open-ended waits"; only `release` has `FINISH_TIMEOUT`. Either reword the
   doc or add a progress watchdog. S.
5. **A huge `CK_ENGINE_TRT_BUILD_TIMEOUT_S` panics on Duration overflow.** `config.rs:241-244` accepts any `u64`.
   `pipeline/mod.rs:1122` (`timeout + 120 s`, then `* 5`) and `proc.rs:242` (`Instant::now() + timeout`) panic
   past `Duration`/`Instant` range. It is an environment knob, but the config's own rule is "an unknown value is an
   error". Cap it (for example at 1 day) at parse time. S.
6. **The TensorRT cache prunes other versions' engines** (`tensorrt.rs:322-332`, `pipeline/mod.rs:991-1003`).
   `stale_dirs` deletes every folder of the same card with another driver, TensorRT or ORT version. Two installed
   app builds with different ORT versions (dev next to stable) sharing the cache root would delete each other's
   engines on alternate jobs, costing minutes of rebuild each time. Prune only by age or on driver change, or key
   the root by app channel. S.
7. **The build-lock holder check is Linux-only** (`tensorrt.rs:220-226` `pid_alive`). On Windows and macOS, an
   engine killed mid-build (the app's pause) leaves a lock that is taken over only after `stale_after` (about
   32 min). Not shipped today (the builder is Linux-only), but it will matter once it is: `OpenProcess` on Windows,
   `kill(pid, 0)` on macOS. S.
8. **The parent-death signal has a fork/exec race** (`proc.rs:305-308`). If the spawning thread exits between
   fork and `prctl`, the builder is not killed. The canonical fix is to compare `getppid()` with the parent's pid
   inside the `pre_exec` closure, and exit if it changed. The `prctl` declaration (a fixed `arg2` before `...`) is
   fine on x86-64 and aarch64 Linux. S.
9. **`Xform::apply` panics on an OCIO error** (`ocio.rs:171-173`). Inside rayon, the job then ends as "internal
   error: OCIO …". Returning a `Result` up through the decoder and renderer would give a clean `engine` or `input`
   message. M.
10. **Normal-mode stage 2 converts on the main thread.** Its bf16 → f16 input (`keying.rs:666`, converted in
    `runtime.rs:661`) runs on the main thread between GPU calls: about 6.6 M values per frame at 1152×1920, a
    few ms. The low-VRAM path already does it on its producer thread. Doing the same in `baton_frames` would take
    it off the card's critical path. S.
11. **Some tests pass green when their tools are missing.** `clip.rs:653`, `writers.rs:567/599` and `decode.rs:920`
    print "no ffmpeg: skipped" and pass. `default_reading_is_corridorkey_byte_identical` asserts the video bytes
    only on x86-64 Linux. Mark them `#[ignore]` unless the tool is present, or fail when `CI` is set and the tool is
    missing, so a runner without ffmpeg can't report coverage it didn't run. S.
12. **Maintainability.**
    - `pipeline/mod.rs` (1240 lines) holds job setup, Core ML keys, TensorRT range, lock and build orchestration,
      and the retry.
    - `run_job` alone is about 330 lines.
    - `trt_build` re-implements `run_job`'s budget arithmetic (`mod.rs:1064-1065` vs `743-751`).
    - Suggested split: a `JobSetup` (probe, window, colour, writers, settings) and the TensorRT orchestration
      (`trt_range`, `trt_prepare`, `trt_drop_stale`, `job_key`) next to `tensorrt.rs`, with one budget function.
    - M, no behaviour change.
13. **Small things, each S.**
    - The pong's `version` is the workspace's `0.2.0` (`lib.rs:160`), not the app release that ships it. A bug
      report can't tell builds apart; add the git hash or the app version as an additive field.
    - `pending_cancel` (`lib.rs:352`) is never pruned. The app doesn't send `cancel` today.
    - `clip::normpath` (`clip.rs:190-212`) normalises only `/`, so `..` in a Windows path isn't folded.
      `Path::file_name` covers the common cases.
    - `job.rs` documents "A bad option is an `input` error", but range errors are now `bad-request`. Update the
      module comment.

## What is done well

- **The protocol loop** (`ck-engine/src/lib.rs`).
  - A reader thread with a condvar inbox means a cancel for a waiting job works wherever it sits in the stream.
  - Non-UTF-8 lines, non-object JSON and missing fields are answered and reading continues.
  - Panics in `run` reset the backend.
  - stdout carries only replies. Every child's stdout is piped or nulled; ffmpeg's and ORT's logs go to stderr.
- **Lifetime on three systems** (`proc.rs`): `PR_SET_PDEATHSIG` with the "parent already gone" check, a
  kill-on-close job object plus a wait on the parent handle on Windows, a `getppid` watch on macOS. There is a real
  end-to-end test (`tests/lifetime.rs`), and the thread invariant for `die_with_parent` is written down where it
  matters.
- **Deadlines everywhere they count**: ffprobe 120 s, `-version` 30 s, writer finish 300 s with kill and reap,
  each TensorRT build, and the build lock with stale and deadline takeover. The lock test proves it doesn't spin
  on a read-only folder.
- **Error taxonomy**: `Error::ort` maps ORT and CUDA OOM texts to `oom`, each with a test. `Error::write` turns
  ENOSPC, EROFS and EACCES (and their Windows forms) into `output` with words. ffmpeg's stderr tail is merged
  into writer failures.
- **Request validation before anything loads**: non-finite numbers, documented ranges, libx264 presets, pix_fmts,
  CRF per bit depth, odd sizes for subsampled formats, stride ≤ chunk (with the measured failure written next to
  the check), OCIO spaces and configs.
- **Numerics**:
  - `finite_input` at every decode and colour boundary (NaN/inf would otherwise spread through attention).
  - `lin()` kept finite after `sinh`.
  - bf16 and f16 rounding exactly where the reference rounds.
  - Lanczos-4 reproduces cv2's arithmetic and SIMD summation order bit for bit, and the parity tests prove it.
- **The pipeline's seams** (`network.rs` `Loader`/`Network`, `frames.rs` `FrameSource`). The real path is
  monomorphised. The fakes run whole jobs and pin a digest of the stage inputs and outputs, so low-VRAM against
  all-loaded and fp16 against fp32 equivalence is tested, not only claimed.
- **Memory discipline**: per-session arena limits derived from the budget and the measured CUDA context,
  `malloc_trim` with the measured reason, `Arc`-shared frames across overlapping windows, borrowed all-zero hint
  tensors, features kept in the network's own dtype.
- **The VRAM table**: a measured upper bound with every measured point in a test (`measured_peaks_are_bounded`),
  monotonicity tested, and the reading rule documented next to the data.
- **The TensorRT path**: strongly typed builds in a child process, deterministic and transient failures told apart
  (only deterministic ones remembered), per-process temp files and atomic replace (MoveFileEx on Windows), and a
  C++ builder that answers one JSON line even on exceptions.
- **NVML card matching** follows CUDA's own device 0 (UUID or PCI), MIG and `CUDA_VISIBLE_DEVICES` semantics, so it
  never reads the wrong card's numbers. This is the kind of detail that usually gets missed.
- **Comments state the measured reason** for nearly every non-obvious choice, which makes later review and change
  safe.

## Counts

| severity | count |
|---|---|
| MUST | 1 |
| SHOULD | 3 |
| NICE | 13 |

Evidence: M1 and S1 proved by runs; NICE 1 proved by a run; the rest code-read.
