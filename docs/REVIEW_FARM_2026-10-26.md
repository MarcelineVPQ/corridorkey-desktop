# Independent review: the farm command line (`corridorkey`) and submitters, 2026-10-26

Scope: `e7aef68..14a2e81` on main. That covers ck-cli (new), the ck-core frame range and warm-up, atomic EXR writes,
the stop request, the app-version build script, `farm/` (OpenJD, Deadline 10, OpenCue, Flamenco, shell),
build/packaging, and docs/CLI.md, ENGINE_PROTOCOL.md "Frame ranges" and farm/README.md. I did not read the earlier
review, bug-hunt or pass documents, or the plan.

## Verdict

**Grade: B+. Ready for 1.0.0-dev.2 after one small fix (M1).** The SHOULDs can follow in dev.3.

The design is right for a farm:

- Staging happens beside the output and frames are renamed only when the job is whole.
- EXR frames are written as `.partial` and then renamed.
- Exit codes say whether a retry can help, and avoid 1, 33 and 137.
- SIGTERM stops the run cleanly, and every failure is mapped to an exit code.

The code is careful, and its claims are mostly backed by tests. These all passed here (CPU only, memory-capped):

- `cargo test -p ck-cli`: 22 unit tests and 5 binary tests.
- The ignored CPU end-to-end tests, run with `cargo build -p ck-engine && cargo test -p ck-cli --test e2e -- --ignored`. Both passed in 40 s: a whole shot and a stepped list match the engine bit for bit, and SIGTERM exits 143 and leaves nothing behind.

The real problems are at the edges of the contract:

- `-s`/`-e` silently clamp to the shot.
- A failure partway through the final renames leaves a mixed set of frames.
- A few doc claims don't match what the code does.
- One overflow panic on absurd input.
- Some Windows signal and quoting details.

## Findings

### MUST

**M1. `-s` / `-e` silently drop frames outside the shot, and the run exits 0.** `crates/ck-cli/src/run.rs:263-268`
(`in_shot` filters).

- **Failure:** a Deadline task gets `-s 1001 -e 1100` for a movie of 1099 frames (or plates that start at 1002). It writes what exists and exits 0, so the farm marks frames 1100 (or 1001) done. Those frames were never written.
- **Inconsistent with `-F`:** `-F` refuses the same range with exit 2, and docs/CLI.md "Frames" says "A frame outside the shot … is exit 2 saying the shot's range".
- **Deadline has no verify step to catch it.** OpenCue's verify layer only catches it because it uses `-F`, and then it fails with exit 2 instead of 9.
- **Evidence (proved):** plates numbered 1-3. `verify … -s 0 -e 99` → `verify: all 3 file(s) there and whole`, exit 0, report `requested: [1,2,3]`. `verify … -F 0-99` → `frame 0 is outside the shot (1-3 …)`, exit 2.
- **Fix:** refuse `-s`/`-e` ends outside `first..=last`, as `-F` does. A gap inside the shot can stay filtered, because a folder may skip numbers. If clamping is wanted for open-ended ranges, it should apply only when an end is omitted.
- **Effort:** S.

### SHOULD

**S1. Docs are wrong about what a stepped or listed spec keys.** docs/CLI.md "Frames" says "`-F 1001-1100x2` keys 1001-1100 and writes 50 frames".

- **What the code does:** it keys from the first to the **last requested** frame: `run.rs:289-295` sets `frame_end = r[last]`, so it keys 1001-1099.
- **Consequence:** frames near the end of a list (`-F 1001,1050`) are near-identical to the whole-shot matte, not identical. The doc's "key one shot per task: bit for bit" promise silently doesn't hold for a step that misses the shot's last frame.
- **Evidence:** code-read. The e2e test asserts `keyed {1002,1004}` for `1002-1004x2` on a 1001-1006 shot.
- **Fix:** either key to the end of the requested range's piece (pass `frame_end` = the end of the spec's last range, clamped to the shot), or correct the doc and say a step/list is bit-identical only when it spans to the shot's ends.
- **Effort:** S.

**S2. A failure partway through the final renames breaks the "never a partial set" promise.** `run.rs:422-428`.

- **Failure:** the rename loop returns on the first error. A file locked by a reader on Windows (Nuke or RV holding the frame open makes `MoveFileEx` fail), an NFS hiccup, or a permission error on a sub-folder causes this:
  - Frames before the failure are already at their final names.
  - The rest are deleted along with the staging folder.
  - With `--overwrite`, the shot becomes a mix of old and new frames.
- **Docs contradicted:** "A failed, stopped or killed run never leaves a frame at a final name."
- **Evidence:** code-read.
- **Fix, either of:**
  - Retry each rename a few times with a short back-off; if one still fails, keep the staging folder (don't drop `RunDirs`), name it in the message and the report, and exit 4.
  - Or move the old frame aside first and roll back on failure.
- **Effort:** S-M.

**S3. Overflow panic from an absurd `--tail` / `tail`.** `crates/ck-core/src/clip.rs:167`, `(b + r.tail).min(n - 1)`.

- **Root cause:** `whole()` accepts values up to about 1.8e19, and `as usize` keeps them.
- **Debug build:** "attempt to add with overflow".
- **Release build:** the sum wraps, `k1` lands below `a`, and the `paths[k0..=k1]` slice panics.
- **Impact:** the CLI catches it as exit 8 "internal error", and ck-engine's `catch_unwind` should contain it for the app. It is still a panic on bad input in a protocol option.
- **Evidence (proved):** 2100-frame folder, `render -F 2050-2060 --tail 18446744073709549568 --device cpu` → `panicked at crates/ck-core/src/clip.rs:167:54: attempt to add with overflow`, exit 8. The run's folders were cleaned up.
- **Fix:** `b.saturating_add(r.tail)`. Better, also cap `preroll`/`tail` in `job.rs` (for example ≤ 100 000) with a bad-request message.
- **Effort:** S.

**S4. `prepare --tensorrt-size` swallows SIGTERM and then exits 0.** `run.rs:480-485`.

- **Failure:** `prepare` installs the handlers, but `Pipeline::trt_build` has no stop point. A farm's cancel during the minutes-long TensorRT build is caught and ignored. The build runs on until the scheduler's SIGKILL, or it finishes and prints `ready` with exit 0 even though it was asked to stop.
- **Before the handlers were installed,** SIGTERM ended `prepare` at once.
- **Evidence:** code-read (`grep stop_point`: only keying.rs).
- **Fix:** either don't install the handlers in `prepare`, or check `signals::stopped_by()` after the build and return 143/130. A stop point between TensorRT network builds is better.
- **Effort:** S.
- The same applies, more mildly, to the in-job TensorRT build in `render` (the "optimize" stage has no stop point).

**S5. Run-id collisions on a shared filesystem when the PID is namespaced.** `run.rs:135-138`: `pid-millis`.

- **Failure:** the docs promise "two runs never share a folder", and name containers and PID-1 launchers as targets. In containers, PIDs are small and the same on every host. Two tasks of one shot that start in the same millisecond on different workers, writing to one NFS output folder, get the same `.corridorkey-<id>` staging folder. The first to finish removes the other's staging (`RunDirs::drop`), and the second fails, or renames frames the first wrote.
- **Likelihood:** low, but farm dispatch is bursty.
- **Evidence:** code-read.
- **Fix:** add the hostname and a random part (for example 64 bits from `RandomState`/`getrandom`), and create the staging folder with `create_dir` (not `_all`) so a collision fails loudly.
- **Effort:** S.

**S6. The Deadline plugin's `quote()` breaks Windows paths that end in a backslash.** `farm/deadline10/CorridorKey/CorridorKey.py:45-46`.

- **Failure:** `'"%s"' % s` gives `"D:\shows\key\"` for a folder output (common on Windows). By the MSVC argv rules (which Rust's std uses), `\"` is a literal quote. The argument then swallows the rest of the command line (`D:\shows\key" -s 1001 …`), so the task fails with a confusing usage error or writes to a wrong path.
- **Other characters:** paths containing `"` also break, and `%` in a pattern (`%04d`) is safe only because Deadline doesn't go through `cmd.exe`.
- **Evidence:** code-read against the MSVC parsing rules.
- **Fix:** double trailing backslashes before closing the quote (`subprocess.list2cmdline` does this correctly), or strip a trailing separator from folder outputs.
- **Effort:** S.

**S7. Windows close/log-off/shut-down is documented as a clean stop, but it is not.** `crates/ck-cli/src/signals.rs:60-67` and docs/CLI.md "Signals".

- **What Microsoft documents (HandlerRoutine):** for CTRL_CLOSE/LOGOFF/SHUTDOWN, "Return TRUE … the system terminates the process" as soon as the handler returns, or after a 5 s timeout. The handler returns 1 at once, so the process is killed straight away: no cleanup, and staging is left behind.
- **Output safety still holds** (staging plus `.partial`), so this is a doc and cleanup issue.
- **Ctrl+C and Ctrl+Break** (OpenJD's Windows notify) are fine.
- **Evidence:** code-read plus the Microsoft docs.
- **Fix:** for events 2, 5 and 6, wait in the handler (up to about 4 s) for the main thread to finish cleanup, or say in the docs that these end the run like a SIGKILL.
- **Effort:** S.

**S8. Nothing cleans up abandoned staging folders, and some farms always leave them.**

- **Where they come from:** Flamenco cancels with SIGKILL (farm/README.md says so). OpenCue's and Deadline's kill signals are unconfirmed. Every cancelled or killed task leaves `.corridorkey-<id>/` (partial EXRs, potentially GBs per 4K chunk) inside the **output** folder. The temp folder holds RVM states of GBs.
- **Over a show's retries** these accumulate silently on the shared filesystem.
- **Evidence:** code-read (`RunDirs` only runs on a normal unwind).
- **Fix:** on start, remove sibling `.corridorkey-<host>-<pid>-*` folders whose PID is not alive on this host (this needs S5's hostname), or older than N days. Have `verify` list any it sees.
- **Effort:** S-M.

### NICE

- **N1. `--report` is not written for a clap usage error** (`run.rs:37-44` returns before the report). Proved: `render --report r.json --frame 3` exits 2 with no report. The docs say "however it ends". Write a minimal report (exit 2, clap's message) when `--report` can be fished out of argv. Effort: S.
- **N2. `OPENJD_SESSION_WORKING_DIR` is unconfirmed as a real OpenJD variable.** I know of `{{Session.WorkingDirectory}}`, a template variable, not an environment variable. If the variable doesn't exist, temp files go to `TMPDIR`. The templates should pass `--temp "{{Session.WorkingDirectory}}"` explicitly. Effort: S.
- **N3. Chunks of one shot overwrite each other's `<clip>_settings.txt`** (`run.rs:429`, errors ignored). The survivor describes one chunk's "Frame Range"/"Keyed Frames", not the shot. Name it per range, or write it only for whole-shot jobs. Effort: S.
- **N4. `frame_times` (report.rs:155) zips over the span, not the frames written.** For a stepped spec it includes keyed-but-unkept frames. docs/CLI.md calls them "each written frame". Rename the field or filter it to `kept`. Effort: S.
- **N5. `a_launcher_that_exits_first_doesnt_end_the_task` proves little.** It runs `verify`, which finishes instantly and never reaches any code that could watch the parent. A `render` on a model-less path won't do either. The claim is true by construction (ck-cli has no watch), so either say that or drop the test's claim in docs/CLI.md.
- **N6. A movie chunk decodes from frame 0 every time.** `trim=start_frame=` in decode.rs:46 is frame-exact but O(start). The last chunk of a long movie decodes the whole movie in every task. It is accurate, so it's fine for dev; a later `-ss` input seek plus trim would cost less.
- **N7. The OpenCue submitter quotes with `shlex.quote`,** which is POSIX only. A Windows RQD host gets single-quoted arguments. Say "Linux hosts" or quote per OS. The PyOutline string `command` path is fine: on master, `backend/cue.py` uses a `str` command as-is, and rqd sets `CUE_GPU_CORES` from `GPU_LIST`, as the code assumes.
- **N8. Deadline GPU affinity order:** the README already flags the CUDA vs PCI order question. Consider exporting `CUDA_DEVICE_ORDER=PCI_BUS_ID` from the plugin (`SetProcessEnvironmentVariable`) whenever it passes `--gpu`, so indices match `nvidia-smi` on mixed-card workers. ck-core's NVML pick already honours that variable.
- **N9. A farm can't run the shipped binary in place.** It ships inside the AppImage, which needs FUSE or extraction. The docs mention a future standalone archive. Until then, farm/README.md should show `--appimage-extract` or the path in an extracted tree.
- **N10. An input folder that also receives the outputs** (`-i plates/ -o plates/key.####.exr`) works once. Every later task (another chunk, a retry) is then refused with exit 3, because `input_folder` sees the key frames. Refuse an output pattern inside the input folder up front, with exit 2.

## Done well

- **Staging and renames:** the hidden staging folder beside the output (same filesystem, so renames are atomic), plus `.partial` EXR writes in ck-core that the app's own jobs benefit from too. The SIGKILL child-process test in writers.rs is a good proof.
- **Exit codes:** one mapping point (exit.rs). A signal wins over the error it surfaced as (the Ctrl+C-reaches-ffmpeg case is thought through). 1, 33 and 137 are avoided.
- **`select_range`:** clean, and it refuses the hard cases loudly: a video output for part of a shot, a first-frame hint on a chunk that starts later, and a range landing in a folder gap. It also numbers chunk frames exactly as the whole-shot job does. The pipeline tests (`jobs.rs`) check the RVM/stage-1 runs of a ranged job against the span job run for run, and that warm-up and tail never reach stage 2.
- **End-to-end tests** against the real engine protocol, bit for bit, plus a real SIGTERM test. Both pass on CPU.
- **Option parity:** every run option has a flag or a stated reason not to (`RUN_OPTIONS` drives both parsing and the test). Engine messages are translated into flag words.
- **Honest submitters:** the docs say what is untested, and each submitter follows its scheduler's real idioms: OpenJD `openjd_progress`/`openjd_status`/`openjd_fail` plus `NOTIFY_THEN_TERMINATE`, Deadline's `CheckExitCode` instead of failing from the stdout handler, PyOutline `#FRAME_START#` tokens with `use_pycuerun=False`, and Flamenco `frameChunker`/`exec`. `--overwrite` on retried tasks is the right call, given that frames appear only on success.
- **GPU selection:** a clear order of precedence (`--gpu` > `CUDA_VISIBLE_DEVICES` > `CUE_GPU_CORES`). It is set before ONNX Runtime or CUDA starts, and an explicitly empty `CUDA_VISIBLE_DEVICES` is respected.

## Counts

MUST 1 · SHOULD 8 · NICE 10. Proved by a run: M1, S3, N1, plus the existing unit/binary/e2e tests passing. The rest
are code-read; S7 is checked against Microsoft's documentation and N7 against OpenCue's source.

## Status

Marcy approved the MUST and all eight SHOULDs (2026-10-26); the NICE items went to the backlog. Branch
`fix/farm-review`.

| finding | done in | how |
|---|---|---|
| M1 | 84c98a5 | `-s` / `-e` and a job file's `frame_start` / `frame_end` outside the shot are exit 2 with `-F`'s message (render and verify) |
| S1 | 19e6950 | the code changed, not the doc: a spec keys to the end of its ranges (`1001-1100x2` keys 1001-1100), so its frames are bit for bit a `1001-1100` run's (e2e test) |
| S2 | 3128453 | all-or-nothing placement: old frames moved aside first, each rename retried, everything undone on a failure (exit 4); staging kept only if the undo fails |
| S3 | dcdb64e | `saturating_add` in select_range; `preroll` / `tail` above 100000 are a bad-request |
| S4 | cf24ff1 | a stop point before each TensorRT network's build; `prepare` exits 143 / 130 without `ready` |
| S5 | bb57d30 | run ids `<host>-<pid>-<64 random bits>`; both run folders made with create_dir, a new id when taken |
| S6 | c481677 | MSVC quoting (`subprocess.list2cmdline`) on Windows; `farm/deadline10/test_quote.py` in `npm run check` |
| S7 | e0be24f | the handler waits up to 4.5 s for the run's own stop on close / log-off / shut-down; docs say what a longer stop means |
| S8 | bb57d30 | a lock file per run folder; `render` sweeps folders with no live lock whose process is gone on this host, or untouched for 7 days |
| N1-N10 | BACKLOG rows 96-105 | ideas, not fixed |
