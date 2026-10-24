# Senior Rust review, 2026-10-24

An independent review of the Rust engine (rule 17): a fresh agent given the code and the docs, none of our conclusions.
Kept verbatim. How each finding was handled: phases A and B (merged), C (the pipeline split and its tests, `933aebc`), D (finding 16: the loop gate narrowed for Rust).

## Independent review: corridorkey-desktop/engine-rs (ck-core, ck-engine, tools/trt-build)

I read every source file. ck-core and ck-engine were all read in full, about 7,000 lines. I also read the two docs and CLAUDE.md. I ran `cargo clippy --workspace --all-targets -- -W clippy::pedantic` under a 12 GB cap and nothing else: no GPU, no edits. The default clippy gate is clean.

The pedantic run gives about 600 warnings, nearly all low value:
- 217 doc-backtick warnings.
- About 100 `must_use` suggestions.
- 38 missing `# Errors` sections.
- About 120 numeric-cast warnings. Most are benign usize/f64/u64 conversions; the f64→u64/usize casts saturate, so they are safe.
- 13 redundant closures and 13 implicit raw-pointer borrows (the FFI code).
- The ones that matter: `too_many_lines` on `Pipeline::run_job` (219 lines) and `keying` (356 lines), and `unnecessary_wraps` on `job_key` (`pipeline.rs:738`, it never returns Err).

### Findings, most severe first

**1. MUST, effort L: the core pipeline has no in-cargo tests.** `pipeline.rs:491-1308` covers windowing, low-VRAM staging, the halve-on-oom retry, the TensorRT fallback and stage-2 streaming. Cargo tests none of it. The only end-to-end check is `tools/e2e_cpu.sh`, which needs real models and is not in `check:engine`. Every benchmark clip runs the low-VRAM path, and the OOM retry is the main safety net, yet both are tested only by hand.
- Why it is hard to test now: `keying` is 356 lines with 13 parameters, there are three `#[allow(clippy::too_many_arguments)]`, and per-network stats live in an anonymous `(f64, f64, usize, f64)` tuple. `Pipeline` is tied to a `&'static Runtime` global, real ORT `Session`s and real ffmpeg.
- Fix: put a `trait Network { fn run(&mut self, Vec<Input>) -> Result<Vec<Output>> }` between the pipeline and ORT, with the ORT `Net` as one implementation. Split `keying` into `rvm_pass`, `foundation_pass`, `stage1_windows` and `stage2_pass`, plus a `JobPlan` struct carrying chunk, stride, low_vram and key. Then a fake network that returns shaped constants can assert window coverage, blend weights, the frame count and the OOM-retry behaviour in milliseconds.

**2. MUST, effort S–M: output can change silently depending on what is installed on the user's machine.**
- `decode.rs:111-141, 161-165`: JPEG goes through `libturbojpeg.so.0` when that library happens to be installed. Otherwise it falls back to the `image` crate, which the code itself says "differs by a few levels". The Windows (`turbojpeg.dll`) and macOS (`.dylib`) names are never tried, so Windows always takes the fallback.
- ffmpeg and ffprobe come from the system. `pipeline.rs:502` runs `ffmpeg -version` on every job and throws the output away. The "bit-identical to cv2" decode claim holds only for the ffmpeg build it was measured with, since swscale's bicubic path has changed between releases.
- Why it matters: the house rule is accuracy, and today two machines can produce different mattes from the same clip with no record of why.
- Fix: put the JPEG decoder used and the ffmpeg version in the pong and in `_settings.txt`. Either statically link turbojpeg (the `turbojpeg` crate has a vendored build) or always use one decoder.

**3. MUST for the macOS work, effort S per item, M–L for Core ML: Linux-only assumptions in cross-platform code.**
- `gpu.rs:363` `host_available` reads `/proc/meminfo`. On Windows and macOS it returns None, so the CPU auto-window budget becomes 0 (`pipeline.rs:570`).
- Its test, `gpu.rs:426` `host_memory_readable`, calls `unwrap()` with no cfg gate. My prediction (not observed): it fails `npm run check:engine` on the macOS runner as soon as the job gets that far. The latest macOS run failed after 45 s, earlier than that step.
- `gpu.rs:344` `tensorrt_version` tries only the `.so` names.
- `tensorrt.rs:98` `builder_path` looks for `ck-trt-build` with no `.exe`.
- `pipeline.rs:1436-1440` `trt_root` falls back to `$HOME`, and to `"."` (the working directory) on Windows. It should use LOCALAPPDATA there, or the `dirs` crate.
- Architecture: `Provider` is {Cuda, TensorRt, Cpu} and `Runtime::provider()` (`runtime.rs:249`) requires NVML plus the CUDA EP. On macOS that means every job fails `no-gpu`.
- Fix: a device layer with a `Provider::CoreMl` variant and per-platform memory budgets (sysctl `hw.memsize` on macOS, `GlobalMemoryStatusEx` on Windows), and cfg-gate or rewrite the test.

**4. SHOULD, effort M: error codes are stringly typed and OOM is detected by matching message text.** `lib.rs:25-64` stores `code: &'static str`, and `pipeline.rs:687` decides to retry with `e.code == "oom"`. `Error::ort` classifies an error as OOM by substring ("failed to allocate", "bad_alloc" and so on).
- Why it matters: a typo in a code, or a changed ORT or CUDA message, compiles fine and quietly turns off the retry.
- Fix: `enum ErrorCode { Oom, Input, Assets, NoGpu, Cancelled, Engine, BadRequest }` with `as_str()` for the protocol, and one unit test per known ORT and CUDA OOM message.
- Also make the error handling consistent: `ModelSet::open`, `Runtime::new` and `tensorrt.rs` return `String`, and an unwritable output folder or a full disk is reported as `engine` (`pipeline.rs:521-522`, `temp_err`).

**5. SHOULD, effort S: panics in producer threads look like a clean end of stream.** In `ahead.rs:44-48` and `decode.rs:401-405`, `recv()` returning Err maps to `Ok(None)`. A panic in decode or preprocessing therefore turns into a misleading later error, depending on the phase: "decoded only N/T frames", "window input thread ended early", or `temp file: failed to fill whole buffer` (when the foundations pass is cut short).
- `Ahead` keeps no JoinHandle, and `Prefetch` keeps one it never joins.
- Fix: keep the handle. On disconnect, `join()` and turn the panic payload into `Error::engine("<thread name> panicked: …")`. Name the threads (`thread::Builder::name`) so stderr does not say `<unnamed>`.

**6. SHOULD, effort S: the Pipeline is reused after a caught panic.** `ck-engine/src/lib.rs:162` wraps `backend.run` in `catch_unwind(AssertUnwindSafe(..))` and the next job reuses the same `Pipeline`, whose `nets`, `key` and `pending` loads may be half-updated.
- Fix: add `Backend::reset()` (unload plus `drop_pending`) and call it after a caught panic, or decide that a panic ends the process and let the app restart it.

**7. SHOULD, effort S: a transient TensorRT build failure is remembered permanently.** At `pipeline.rs:866-871` and `tensorrt.rs:210`, any failure is written to `.failed`, including a timeout or OOM because another process held the card (Sonata, for example). That range then runs on CUDA silently until the driver, models or workspace change.
- Fix: record only deterministic failures (no tactic, parse errors). Do not record timeouts or OOM, or expire them.

**8. SHOULD, effort S–M: writer failures are opaque, and writer options are not validated.**
- `writers.rs:108` sends ffmpeg's stderr to the engine's stderr. The user then sees `ffmpeg writer: Broken pipe` (line 121) or `exit code 1` (line 192), never the reason.
- `job.rs:131-135` passes `preset`, `pix_fmt` and `crf` straight to ffmpeg. A bad value only shows up at the first frame, after model load and the RVM pass.
- Fix: validate against known sets when parsing. Capture the last stderr lines into the error, as `output_timeout` already does.

**9. SHOULD, effort M: about 20 environment variables are read at the point of use, some on every call, and none are reported.**
- Examples: `CK_ENGINE_PRECISION` is read on every `precision()` call (`runtime.rs:259`), `CK_ENGINE_ARENA_SHRINK` on every load, `CK_ENGINE_PROFILE` in `Drop`, and `CK_ENGINE_VRAM_BUDGET_GB` inside `job::parse` (`job.rs:164`), which makes parsing depend on the environment.
- `runtime.rs:206-208` calls `std::env::set_var`. It is sound today only because it runs before any thread reads the environment; edition 2024 makes it `unsafe`.
- `--device`, the precision value and the graph-optimisation level are free strings, so `--device gpu` silently means auto (`main.rs:75`, `runtime.rs:183`).
- Fix: one `EngineConfig` struct parsed once at startup with enums and errors on bad values, printed to stderr and included in the pong. Pass the flash-attention choice through ORT session config instead of changing the process environment.

**10. SHOULD, effort S–M: large host allocations on every window.** `pipeline.rs:1118-1120, 1170` builds a zero-filled `f32` hint tensor of `tc × H × W` (about 280 MB for 48 frames at 1152×1280) even when there is no hint, then converts it to f16 (another 140 MB).
- The engine's own log puts host-side float16 conversion at about 3.2 s and stage-1 host inputs at about 3.3 s of walking_sitting's 62 s.
- Fix: build the hint directly in the type the graph takes, and cache the all-zero hint for clips without hints.
- NICE, effort M: decode allocates about four buffers per frame of 17 MB or more (`rgb8_to_planar` → pad → two bf16 views; at 4K each exceeds glibc's mmap threshold, so every frame pays page-fault zeroing), and render allocates four output buffers per frame. A small buffer pool, returned by the writer threads, removes that churn.

**11. NICE, effort S: hand-written FFI declarations.** `prctl`, `getppid`, `malloc_trim` and kernel32 are declared by hand (`proc.rs:61-89`, `pipeline.rs:1416`) instead of using `libc` / `windows-sys`. I checked them and they are correct: the struct layouts match `nvmlProcessInfo_t` v3 and `nvmlPciInfo_t` v3, the 144-byte const assert on the job-object struct is a nice touch, and the SAFETY comments are honest.
- Two invariants should be written down or asserted. First, `PR_SET_PDEATHSIG` fires when the spawning thread exits, not the process, so `die_with_parent` must stay on the main thread; today it is. Second, `Nvml::info` looks up symbols again on every call; cache the function pointers once.

**12. NICE, effort S: thread-to-thread plumbing.** `outputs.rs:41,78` sends frame counts over a blocking `sync_channel(1 << 16)`; if some future path stops calling `done()`, the render thread deadlocks after 65,536 frames. An `AtomicUsize` is simpler and cannot block. The `Arc<Mutex<f64>>` "seconds" pattern appears about six times; return the value from `join()` or use an atomic. `Inbox` uses an anonymous `(VecDeque, bool)` tuple (`lib.rs:62`); name the fields.

**13. NICE, effort S: API surface and dead code.**
- Every module is `pub`, so the compiler cannot flag dead code. Unused today: `Runtime::get`, `ClipMeta::is_frames`, and the `trt` parameter threaded through `session`, `Net::load` and `ensure`.
- `npy.rs` is test-only, ships in the library, and panics on a malformed header (`buf[start..start+hlen]`).
- `ENGINE_VERSION = "0.2.0"` duplicates the workspace version; use `env!("CARGO_PKG_VERSION")`.
- Fix: `pub(crate)` by default, and move `npy` to `tests/common` or behind a feature.

**14. NICE, effort S: small protocol and parsing edges.**
- A non-UTF-8 stdin line silently ends input (`lib.rs:101`).
- A `cancel` with no id is stored as `"null"` (`lib.rs:135`).
- `"nan"` and `"inf"` are accepted as numbers (`job.rs:46`).
- The documented 0–1 ranges for `hint_quality`, `carry_hint_quality` and `despill_strength` are not checked.

**15. NICE, effort S: trt-build and the TensorRT cache.**
- `std::rename` does not overwrite an existing file on Windows, so a rebuild fails there.
- The timing-cache write is unchecked and shares one `.tmp` name between processes.
- Two engine processes (the bench and the app) can build the same range at once; a lockfile per range folder would stop that.
- Engine files themselves are written atomically, and a killed build cannot leave a usable-looking engine, because `.source` is written last.

**16. Judgement on the `// loop: VERDICT — reason` rule.** It is worth keeping. There are 267 annotations: 151 NOT-WORTH, 64 HOT-PATH-OK, 50 SERIAL-REQUIRED and 2 PARALLELIZE.
- The waits, threads and deadlines with `[bounded: …]` are the valuable part. That audit evidently found the unbounded ffprobe, writer and TensorRT waits that `proc.rs` now handles well.
- The 151 NOT-WORTH notes on `.iter().any()` over four items are noise, and they break method chains in the middle.
- 19 annotations carry "this pass: was…" history, a changelog that will go stale in the code.
- Suggestion: limit the gate to waits, threads, blocking calls and loops over per-frame data, and move the history into git or the pass docs.

### What is genuinely good
- Deadline discipline on every child process (`proc.rs`), with both pipes drained.
- Process lifetime: PDEATHSIG with the check for a parent that is already gone, a Windows job object, and kill-and-reap in `Drop` for every ffmpeg child.
- Careful mapping of CUDA device 0 to NVML (by UUID or PCI) with good tests.
- Python-fixture parity tests, protocol tests with a fake backend (including the cancel race), and a real-binary lifetime test.
- Data handling: `Data`/`Arc` frames avoid copies, rendering writes rows in parallel straight into the output buffers, and rendezvous channels bound memory.
- Comments that carry measurements rather than opinions.

### What a senior reviewer would say overall
This is unusually disciplined engine code for its age. Process lifetimes, deadlines and parity with upstream have clearly been fought for, and the FFI is sound. The weak spot is structure: the 1,450-line `pipeline.rs` holds the logic that matters most and has no automated tests, error codes and configuration are stringly typed and spread across the code, and "Linux is the platform" assumptions keep leaking into code that is meant to be cross-platform. None of it is on fire; it is the debt that turns a Core ML provider or the next ORT upgrade into a regression hunt.

### Top 5 to do first
1. Add a `Network` trait seam, split `keying`, and test windowing, staging and the OOM retry in cargo (#1).
2. Fix the platform gaps (meminfo, Windows paths and names, the failing test) before macOS CI reaches cargo, and design the Core ML provider (#3).
3. Report and pin the external decoders: the JPEG decoder used and the ffmpeg version in the pong and settings, and bundle or statically link turbojpeg (#2).
4. Introduce an `ErrorCode` enum plus OOM-message tests (#4), and propagate producer-thread panics (#5).
5. Write one `EngineConfig` parsed and reported at startup (#9), together with the ffmpeg-option validation and stderr capture (#8) and not recording transient TensorRT failures (#7).

Clippy output (pedantic, full): /home/nhukette/.cache/clippy-ck.txt. Delete it when you no longer need it.
