# Loop pass: every loop, chain, timer, wait and thread, with a verdict

_2026-10-21, branch `audit/efficiency-loops` (off `feat/rust-engine` 47943b6). Done per CLAUDE.md "Loop pass"
(rule 7, the AVIEW / DS5 pass, `~/projects/DS5Dongle-OLED-Config-Web/docs/LOOP_PASS_2026-10.md`), extended to
the Rust + ONNX Runtime engine and its C++ TensorRT builder. Marcy delegated the decisions for this pass; the
fixes are on the branch, not merged. The measured side (what each fix bought) is
[EFFICIENCY_PASS_2026-10.md](EFFICIENCY_PASS_2026-10.md)._

## How the list is made

`tools/list_loops.mjs` lists every candidate mechanically; nothing is sampled by eye. It reads `electron/`,
`src/`, `tools/`, `.hooks/` (TypeScript / JavaScript, shell), `engine/` and the Python tools, `engine-rs/crates/*/src`
(Rust) and `engine-rs/tools` (shell, Python, the `ck-trt-build` C++). Tests are left out (`tests/`, `*.test.*`,
`test_*.py`, Rust `#[cfg(test)]` modules). One row per source line; a line with several kinds gets them joined.

| Kind | What is listed |
|---|---|
| loop | `for` / `while` / `do` / `loop` statements (shell: `for` / `while` / `until`) |
| iter | iterator chains and array callbacks: Rust `.iter()` / `.par_iter()` / `.into_iter()` / `.chunks*()` / `(a..b).map`…, TS `.map` / `.forEach` / `.filter` / `.reduce` / `.some` / `.every` / `.find*` / `.flatMap` / `.sort`, Python comprehensions |
| timer | `setTimeout` / `setInterval` / `requestAnimationFrame`, sleeps |
| wait | a blocking wait: child processes (`output` / `status` / `wait` / `execFile` / `subprocess`), channel `recv`, thread `join`, blocking file reads, `fetch` |
| thread | a thread started (`std::thread::spawn`, `threading.Thread`) |
| sync | a synchronous fs / child call on the Electron main process (`electron/main`, it blocks the UI) |

The special-attention column (flags, mechanical):

| Flag | Meaning | Gate rule |
|---|---|---|
| no-timeout | a wait with no deadline in its call | the reason must say what bounds it: `[bounded: …]` |
| retry | a loop that retries | `[bounded: …]` |
| spin | a poll loop with no sleep or blocking call in it | `[bounded: …]` |
| alloc | allocates inside the loop / chain (per frame when the verdict is HOT-PATH-OK in the engine) | — |
| nested / pixel | inside another loop, chain or timer; `pixel` when both run over rows / pixels | — |
| main-blocking | blocks the Electron main process | — |

**Every row has exactly one verdict**, a comment on its line or the comment lines right above it
(`// loop: VERDICT — reason`, `# loop: …` in Python and shell, `{/* loop: … */}` in JSX). A row inside a
statement the formatter wrapped takes the comment above the statement. **Rust exception** (since 2026-10-24): in
`engine-rs/crates` a verdict is required only on a wait, thread, timer (sleep) or blocking call, on a plain
`while` / `loop` statement, and on a `for` loop or iterator chain flagged no-timeout, retry, spin, pixel, nested or
alloc. A plain Rust `for` loop or chain with none of those (an `.iter().any()` over a few items) is exempt: listed
as `exempt`, never failing the gate. History ("this pass: was …") belongs in the commit log or this doc, not in
the comment. The gate (`node tools/list_loops.mjs
--check`, part of `npm run gates` and so of `npm run check` and CI) fails on a required row without a valid verdict, and
on a no-timeout / retry / spin row whose reason doesn't say what bounds it. `node tools/list_loops.mjs --md`
prints the tables below; line numbers are as of this commit (if code moves, the code column finds the row).
`tests/unit/listLoops.test.ts` pins the lister.

| Verdict | Meaning |
|---|---|
| PARALLELIZE | independent work; run it alongside, with a bound |
| BATCH | one call / read instead of N |
| SERIAL-REQUIRED | must stay in order: one GPU job at a time, frame order to the writers, a recurrent state, one child process |
| HOT-PATH-OK | runs per frame / window / poll / render, with N or the rate stated |
| FIX-HOT-PATH | per-frame work that shouldn't be there |
| NOT-WORTH | tiny N, or once per job / start / user action |

## Summary

| Verdict | .hooks | electron | engine-rs | engine | src | tools | All |
|---|---|---|---|---|---|---|---|
| PARALLELIZE | 0 | 0 | 2 | 0 | 0 | 0 | 2 |
| BATCH | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| SERIAL-REQUIRED | 0 | 19 | 56 | 1 | 0 | 45 | 121 |
| HOT-PATH-OK | 0 | 8 | 66 | 2 | 19 | 7 | 102 |
| FIX-HOT-PATH | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| NOT-WORTH | 8 | 230 | 112 | 1 | 32 | 86 | 469 |
| exempt (Rust, no verdict needed) | 0 | 0 | 49 | 0 | 0 | 0 | 49 |
| **Total** | 8 | 257 | 285 | 4 | 51 | 138 | **743** |

Kinds: loop 231, iter 338, sync 124, wait 58, timer 36, thread 12. Flags: nested 116, alloc 161, main-blocking 132, no-timeout 37, pixel 4, retry 3.

Since 2026-10-24 (senior Rust review, finding 16) a plain Rust `for` loop or iterator chain needs no verdict;
the 49 such rows whose note was only NOT-WORTH lost it and show as **exempt**. 676 of the 743 rows need a verdict
and have one.

Before this pass the gate listed 111 rows (loops only, in electron/, src/, engine/ and the Rust crates: SERIAL-REQUIRED
20, HOT-PATH-OK 34, NOT-WORTH 57). At the pass, 503: the chains, timers, waits, threads, main-process calls, tools/, .hooks/,
the C++ builder and the shell and Python tools are listed too. **No FIX-HOT-PATH row is left**: every per-frame row
that shouldn't have been there was fixed on the branch (its reason says "this pass: …"), and every wait without a
deadline in its call says what bounds it.

## What the pass found, and what was done

Measured before / after in [EFFICIENCY_PASS_2026-10.md](EFFICIENCY_PASS_2026-10.md) (numbers there; walking_sitting
61.3 → 54.4 s, peak RAM −2.7 GB, mattes identical).

| # | Found | Where | Done |
|---|---|---|---|
| 1 | A stage-1 window's frames deep-copied out of the reader's cache (~850 MB per 48-frame window) | `pipeline.rs` WindowReader / HintWindows | frames `Arc`-shared |
| 2 | Stage 1's rgb converted bf16 → f32 → f16 with a float32 copy of the window | `pipeline.rs`, `runtime.rs` | one pass, in the graph's type (`Data`) |
| 3 | Stage 1's float16 batons copied to float32 for the blend (566 MB per window) | `hann.rs` | the blend reads float16 |
| 4 | Stage 2's float16 logits converted on the card's thread; its inputs converted twice | `runtime.rs`, `pipeline.rs` | logits rendered as float16 on the render thread; inputs one pass |
| 5 | RVM features / state and foundation features: float16 → float32 → float16 round trips, float32 temp files | `pipeline.rs` | kept in their type; files half the size |
| 6 | Render: per-row vectors plus a join copy; video writer: a per-frame byte copy | `render.rs`, `writers.rs` | rows written in place; samples go to ffmpeg as they are |
| 7 | Per-frame image passes on one thread (rgb8 → planar, pad, area / bilinear resize) | `decode.rs`, `image.rs` | rows in parallel |
| 8 | Low-VRAM session loads serial between phases (3.4 s per job) | `pipeline.rs` | the next phase loads on its own thread (CUDA); host memory trimmed after each unload (it grew job to job without) |
| 9 | Waits with no deadline: ffprobe, ck-trt-build, a writer's ffmpeg finishing, `ffmpeg -version` | `clip.rs`, `tensorrt.rs`, `writers.rs`, `pipeline.rs` | 120 s / 1800 s (`CK_ENGINE_TRT_BUILD_TIMEOUT_S`) / 300 s / 30 s via `proc.rs` |
| 10 | App: nvidia-smi, ffprobe and the stills' ffmpeg with no timeout; GPU reads could overlap | `electron/main/gpu.ts`, `media.ts`, `index.ts` | 5 s / 120 s / 60 s; one GPU read at a time |
| 11 | App: state pushed to a hidden window | `electron/main/index.ts` | held while hidden, one push on show |
| 12 | engine_bench waited forever on a silent engine (a profiling run held the GPU lock 13 minutes); its nvidia-smi sampler had no timeout; drive.mjs's fetch neither | `tools/` | `--stall-s` 600 s watchdog; 5 s; 2 s |

Busy-waits: none. The one `spin`-flagged row (`outputs.rs` `done()`) drains a channel with `try_recv` and returns at
the first Empty; the deadline loops (`proc.rs`, `writers.rs` release) sleep 50 ms between checks. Unbounded retries:
none; the one engine retry (an automatic window that runs out of memory before any frame was written) halves the
window each round (≤ 7 rounds).

## Verdicts that weren't true (Console Phase 4 senior review, 2026-10-27)

The gate checks that every loop has a verdict, not that the verdict is true. The senior review of Console Phase 4
(docs/REVIEW_CONSOLE_P4_2026-10-27.md, S7) found bounds the code didn't keep; each was fixed so the verdict holds:

| Where | The verdict said | What the code did | Done |
|---|---|---|---|
| `src/shared/console/script.ts` `lineOf` | NOT-WORTH, once per command | counted new lines from the start for every command: quadratic (30 000 lines: 5.1 s) | line starts found once, a binary search per command (S5) |
| `electron/main/console/runner.ts` `forItems` | bounded: ITEMS_MAX | spread every match before the cap was checked (> 130 000: RangeError) | the cap is checked first, items added one by one (M4) |
| `runner.ts` `runList` and its `for` | bounded: ITEMS_MAX items | the cap was per loop: nested loops multiplied it (10⁴ × 10⁴), and the loop never yielded | `PROGRAM_COMMANDS_MAX` for the whole program, a turn of the event loop before each command (M4) |
| `runner.ts` `walk` | 200 000 entries, once per sudo confirmation | also du's walk, and a script's confirmation counts several folders | the verdict says per folder counted; du's budget and Ctrl+C at each entry (S6) |

**A `[bounded: …]` must name a limit the code enforces where the loop runs.** Check it when writing the verdict: a
per-loop cap inside another loop multiplies; a cap checked after the work is no cap.

## History moved out of the code (2026-10-24)

The senior Rust review (finding 16) found engine annotations that carried this pass's history ("this pass:
was ..."), a changelog that goes stale in code. The history clause was cut from each comment; the verdict and its
current reason stay. What each one said, in `engine-rs/crates/ck-core/src/` (line of the annotation at the cut):

| Where | Code under the annotation | History clause that was cut |
|---|---|---|
| runtime.rs:462 | `out.par_extend(p.par_iter().with_min_len(PAR_MIN).map(\|&x\| f(x)));` | this pass: one pass, was two plus a float32 copy |
| runtime.rs:535 | `res.push((s.iter().map(\|&x\| x as usize).collect(), Data::F16(d.to_vec())));` | this pass: was converted to float32 here, on the card's thread |
| clip.rs:250 | `let out = crate::proc::output_timeout(&mut cmd, PROBE_TIMEOUT).map_err(\|e\| {` | added in this pass; it had no deadline |
| render.rs:70 | `let mut rows: Vec<Row<'_, T>> = (0..h).map(\|_\| [None, None, None, None]).collect();` | this pass: per-row vectors and a join copy |
| decode.rs:79 | `r.par_chunks_mut(w).zip(g.par_chunks_mut(w)).zip(b.par_chunks_mut(w)).zip(rgb.par_chunks(w` | this pass: was one thread |
| pipeline/frames.rs:46 | `let out = (t0..t1).map(\|t\| self.cache[&t].clone()).collect();` | this pass: each frame was deep-copied, ~850 MB per 48-frame window |
| pipeline/frames.rs:71 | `let out = (t0..t1).map(\|t\| self.cache[&t].clone()).collect();` | this pass: were deep copies |
| pipeline/mod.rs:313 | `let started = crate::ahead::spawn_named(&format!("load-{piece}"), move \|\| {` | this pass; measured: 1.3-1.5 s less per job |
| pipeline/temps.rs:72 | `self.f.seek(SeekFrom::Start((t0 * self.frame * 2) as u64)).and_then(\|_\| self.f.read_exact(` | this pass: no byte buffer + conversion |
| pipeline/temps.rs:112 | `self.f.read_exact(bytemuck::cast_slice_mut(&mut out)).map_err(temp_err)?;` | this pass: float16, half the bytes |
| hann.rs:53 | `sum.par_iter_mut().zip(baton.par_iter()).with_min_len(1 << 14).for_each(\|(s, b)\| *s += b.t` | this pass: no float32 copy of the window's batons |
| hann.rs:73 | `(k, sum.into_par_iter().with_min_len(1 << 14).map(\|v\| half::f16::from_f32(v / d)).collect(` | this pass: was float32 then rounded again |
| pipeline/keying.rs:459 | `("rgb", vec![1, tc, 3, sh, sw], Data::Bf16(models.iter().map(\|m\| &m[..]).collect())),` | this pass: bf16 -> f32 -> f16 was two passes and an 850 MB float32 copy per 48-frame window |
| image.rs:95 | `dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).enumerate().for_each(\|(y, drow)\| {` | this pass: were one thread |
| image.rs:144 | `dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).zip(ys.par_iter()).for_each(\|(drow, &(y0, y1` | this pass: were one thread |
| image.rs:191 | `dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).zip(ys.par_iter()).for_each(\|(drow, &(y0, y1` | this pass: were one thread |
| writers.rs:271 | `Some(mut c) => match crate::proc::wait_timeout(&mut c, end.saturating_duration_since(std::` | this pass: it had no deadline |

## Special attention

### Waits without a deadline in the call (30)

| Where | Kind | Verdict | Flags | Reason |
|---|---|---|---|---|
| electron/main/desktopTheme.ts:71 | wait | NOT-WORTH | no-timeout | one gdbus portal read per palette refresh (Desktop theme only) [bounded: its 2 s timeout option] |
| electron/main/index.ts:395 | wait | NOT-WORTH | no-timeout | one local file per media request (thumbnails / stills from the app's cache) [bounded: a local file: URL] |
| electron/main/updater.ts:100 | wait | NOT-WORTH | no-timeout | the fetch the feed reader is given; every caller passes an AbortSignal.timeout [bounded: FEED_TIMEOUT_MS at the call site] |
| engine-rs/crates/ck-core/src/ahead.rs:44 | wait | SERIAL-REQUIRED | no-timeout | the consumer takes items in order [bounded: the producer ends at its sequence's end or first error, which closes the channel] |
| engine-rs/crates/ck-core/src/decode.rs:68 | wait | NOT-WORTH | no-timeout | reaps the decoder after kill() [bounded: a killed child exits] |
| engine-rs/crates/ck-core/src/decode.rs:364 | wait | SERIAL-REQUIRED | no-timeout | frames in order [bounded: the prefetch thread ends at the clip's end (ffmpeg closes its pipe) or an error] |
| engine-rs/crates/ck-core/src/outputs.rs:91 | wait | SERIAL-REQUIRED | no-timeout | the render thread already stopped (its channel closed) [bounded: it has ended or is ending] |
| engine-rs/crates/ck-core/src/outputs.rs:110 | wait | SERIAL-REQUIRED | no-timeout | waits for the queued frames (≤ QUEUE = 2) to be rendered and handed off [bounded: the sender is dropped first, so the thread ends after them] |
| engine-rs/crates/ck-core/src/outputs.rs:117 | wait | SERIAL-REQUIRED | no-timeout | joins the render thread after dropping its sender [bounded: ≤ 2 queued frames, then the thread ends] |
| engine-rs/crates/ck-core/src/outputs.rs:130 | wait | NOT-WORTH | no-timeout | drop path: the same join [bounded: the sender is dropped first] |
| engine-rs/crates/ck-core/src/pipeline.rs:153 | wait | HOT-PATH-OK | no-timeout | one RVM window or baton frame from the local temp file, read straight into float16 (this pass: no byte buffer + conversion) [bounded: a local file read] |
| engine-rs/crates/ck-core/src/pipeline.rs:193 | wait | HOT-PATH-OK | no-timeout | one window's foundation features from the local temp file, in their own type (this pass: float16, half the bytes) [bounded: a local file read] |
| engine-rs/crates/ck-core/src/pipeline.rs:198 | wait | HOT-PATH-OK | no-timeout | the float32 (CPU / fp32) case of the same read [bounded: a local file read] |
| engine-rs/crates/ck-core/src/pipeline.rs:339 | wait | SERIAL-REQUIRED | no-timeout | takes a network loaded ahead; waits only for the part not yet done [bounded: ORT session creation ends (succeeds or fails)] |
| engine-rs/crates/ck-core/src/pipeline.rs:442 | wait | NOT-WORTH | no-timeout | joins loads that were started ahead [bounded: ORT session creation ends] |
| engine-rs/crates/ck-core/src/pipeline.rs:1255 | wait | SERIAL-REQUIRED | no-timeout | stage 2's next input, in order [bounded: the producer sends every frame or its error, then ends] |
| engine-rs/crates/ck-core/src/pipeline.rs:1264 | wait | SERIAL-REQUIRED | no-timeout | joins the producer after the receiver is dropped [bounded: its next send fails and it ends] |
| engine-rs/crates/ck-core/src/proc.rs:22 | wait | NOT-WORTH | no-timeout | reaps the child after kill() [bounded: a killed child exits] |
| engine-rs/crates/ck-core/src/proc.rs:40 | wait | SERIAL-REQUIRED | no-timeout | reads one pipe to its end [bounded: the pipe closes when the child exits or is killed at the deadline] |
| engine-rs/crates/ck-core/src/proc.rs:51 | wait | SERIAL-REQUIRED | no-timeout | joins the two pipe readers [bounded: the child has exited or was killed, so both pipes are closed] |
| engine-rs/crates/ck-core/src/writers.rs:172 | wait | SERIAL-REQUIRED | no-timeout | joins the feeding thread [bounded: it finished, or ffmpeg was just killed so its blocked write fails] |
| engine-rs/crates/ck-core/src/writers.rs:199 | wait | NOT-WORTH | no-timeout | drop path: reaps ffmpeg after kill() [bounded: a killed child exits] |
| engine-rs/crates/ck-core/src/writers.rs:302 | wait | SERIAL-REQUIRED | no-timeout | joins the EXR thread after closing its queue [bounded: ≤ 2 queued frames, each one local file write] |
| tools/build-feed.mjs:28 | wait | SERIAL-REQUIRED | no-timeout | one release asset download per feed build (CI) [bounded: the feed job's timeout-minutes: 20] |
| tools/build-feed.mjs:42 | wait | SERIAL-REQUIRED | no-timeout | one GitHub API read per feed build (CI) [bounded: the feed job's timeout-minutes: 20] |
| tools/engine_bench.mjs:135 | wait | NOT-WORTH | no-timeout | pgrep once per clip (the GPU guard) [bounded: pgrep reads /proc and exits] |
| tools/engine_bench.mjs:265 | loop+wait | NOT-WORTH | no-timeout | a few install paths, du once each [bounded: du over a local folder] |
| tools/matte_compare.py:39 | wait | SERIAL-REQUIRED | no-timeout | one ffprobe per compared file [bounded: a local file; the caller runs under timeout] |
| tools/matte_compare.py:69 | wait | SERIAL-REQUIRED | no-timeout | reaps ffmpeg after its frames were read [bounded: its pipe was read to the end] |
| tools/verify-feed.mjs:14 | wait | SERIAL-REQUIRED | no-timeout | one feed read per check (CI / by hand) [bounded: the feed job's timeout-minutes: 20] |

### Retries and spins (4)

| Where | Kind | Verdict | Flags | Reason |
|---|---|---|---|---|
| engine-rs/crates/ck-core/src/outputs.rs:99 | loop | NOT-WORTH | spin | drains what is queued (at most a few counts), never waits [bounded: ends at the first Empty] |
| engine-rs/crates/ck-core/src/pipeline.rs:681 | loop | SERIAL-REQUIRED | retry, alloc | one attempt at a time [bounded: the window halves each round, and only while nothing was written: ≤ log2(80) ≈ 7 rounds] |
| tools/list_loops.mjs:181 | loop | NOT-WORTH | retry, alloc | at most six wrapped lines up to the statement's first line [bounded: i - head < 6] |
| tools/list_loops.mjs:290 | loop | NOT-WORTH | retry, nested | once per gate run over the rows (its "retry" is the flag's name) [bounded: the rows] |

### Per-frame allocations (engine, hot path) (23)

| Where | Kind | Verdict | Flags | Reason |
|---|---|---|---|---|
| engine-rs/crates/ck-core/src/clip.rs:107 | loop | HOT-PATH-OK | alloc | one pass over the folder's entries |
| engine-rs/crates/ck-core/src/decode.rs:51 | loop | HOT-PATH-OK | alloc | read() fills the frame in a few large pieces |
| engine-rs/crates/ck-core/src/decode.rs:249 | iter | HOT-PATH-OK | alloc | one pass per frame, parallel; the frame's display view (bf16) is the output, one allocation per frame |
| engine-rs/crates/ck-core/src/decode.rs:254 | iter | HOT-PATH-OK | alloc | one pass per frame, parallel; the model view (bf16) is the output, one allocation per frame |
| engine-rs/crates/ck-core/src/decode.rs:414 | iter | HOT-PATH-OK | alloc | per hint frame (float EXR hints only), one pass; hints are optional |
| engine-rs/crates/ck-core/src/hann.rs:60 | iter | HOT-PATH-OK | alloc | first window covering a frame: its weighted baton is the accumulator (one allocation per frame, kept until the frame is final) |
| engine-rs/crates/ck-core/src/hann.rs:69 | iter | HOT-PATH-OK | alloc | the frames a window finishes (≤ stride); each frame's values in parallel |
| engine-rs/crates/ck-core/src/hann.rs:75 | iter | HOT-PATH-OK | alloc, nested | frames a window finishes (≤ stride), each frame parallel; output float16 (this pass: was float32 then rounded again) |
| engine-rs/crates/ck-core/src/pipeline.rs:232 | iter | HOT-PATH-OK | alloc | a window's frames (≤ 80): Arc clones, no pixel copies (this pass: each frame was deep-copied, ~850 MB per 48-frame window) |
| engine-rs/crates/ck-core/src/pipeline.rs:254 | iter | HOT-PATH-OK | alloc | a window's hint frames (≤ 80): Arc clones (this pass: were deep copies) |
| engine-rs/crates/ck-core/src/pipeline.rs:1142 | loop | HOT-PATH-OK | alloc, nested | the window's frames |
| engine-rs/crates/ck-core/src/pipeline.rs:1152 | iter | HOT-PATH-OK | alloc, nested | the window's frames (≤ 80): moves the model views out, the display views are dropped before the run |
| engine-rs/crates/ck-core/src/pipeline.rs:1160 | iter | HOT-PATH-OK | alloc, nested | ≤ 80 slice references; converted once inside the run (this pass: bf16 -> f32 -> f16 was two passes and an 850 MB float32 copy per 48-frame window) |
| engine-rs/crates/ck-core/src/pipeline.rs:1184 | iter | HOT-PATH-OK | alloc, nested | carry hints: only the frames the next window takes (≤ stride), in parallel, each a small upsample |
| engine-rs/crates/ck-core/src/pipeline.rs:1393 | loop | HOT-PATH-OK | alloc | the window's frames |
| engine-rs/crates/ck-core/src/render.rs:71 | iter | HOT-PATH-OK | alloc | one small array per output row (h ≤ 2160), per frame; the pixels go straight into the outputs (this pass: per-row vectors and a join copy) |
| engine-rs/crates/ck-core/src/runtime.rs:428 | iter | HOT-PATH-OK | alloc | float16 -> float32 where a graph takes float32 (the CPU / fp32 path), one parallel pass |
| engine-rs/crates/ck-core/src/runtime.rs:439 | iter | HOT-PATH-OK | alloc | float32 -> float16 for the fp16 graphs' float32-made inputs (hints, foundation inputs on CPU), one parallel pass |
| engine-rs/crates/ck-core/src/runtime.rs:449 | iter | HOT-PATH-OK | alloc | carry hints: one small aux plane per frame the next window takes |
| engine-rs/crates/ck-core/src/runtime.rs:544 | iter | HOT-PATH-OK | alloc, nested | the output's shape (≤ 5 dims) + one copy out of ORT's buffer (the session's outputs are freed right after) |
| engine-rs/crates/ck-core/src/runtime.rs:548 | iter | HOT-PATH-OK | alloc, nested | the output's shape (≤ 5 dims) + one copy out of ORT's buffer, kept as float16 (this pass: was converted to float32 here, on the card's thread) |
| engine-rs/crates/ck-core/src/writers.rs:232 | iter | HOT-PATH-OK | alloc | EXR only: ≤ four channels per frame, each one pass (the exr crate takes owned channel buffers) |
| engine-rs/crates/ck-core/src/writers.rs:266 | loop | HOT-PATH-OK | alloc, nested | the frames of one batch (1 at the default batch size) |

### Nested loops on per-pixel data (engine) (29)

| Where | Kind | Verdict | Flags | Reason |
|---|---|---|---|---|
| engine-rs/crates/ck-core/src/decode.rs:83 | loop+iter | HOT-PATH-OK | nested, pixel | one row of pixels |
| engine-rs/crates/ck-core/src/hann.rs:75 | iter | HOT-PATH-OK | alloc, nested | frames a window finishes (≤ stride), each frame parallel; output float16 (this pass: was float32 then rounded again) |
| engine-rs/crates/ck-core/src/image.rs:96 | iter | HOT-PATH-OK | nested | rows of one plane in parallel (this pass: were one thread); a gather over the column table |
| engine-rs/crates/ck-core/src/image.rs:100 | iter | HOT-PATH-OK | nested | one row's gather (≤ 4096) |
| engine-rs/crates/ck-core/src/image.rs:114 | loop | HOT-PATH-OK | nested | row copies |
| engine-rs/crates/ck-core/src/image.rs:143 | iter | HOT-PATH-OK | nested | output rows in parallel (this pass: were one thread) |
| engine-rs/crates/ck-core/src/image.rs:145 | loop+iter | HOT-PATH-OK | nested | output columns of one row (wo ≤ 960) |
| engine-rs/crates/ck-core/src/image.rs:148 | loop | HOT-PATH-OK | nested | the cell's rows (4 for C-RADIO, ~5 for MoGe) |
| engine-rs/crates/ck-core/src/image.rs:150 | iter | HOT-PATH-OK | nested | one cell row (4-5 values) |
| engine-rs/crates/ck-core/src/image.rs:190 | iter | HOT-PATH-OK | nested | output rows in parallel (this pass: were one thread) |
| engine-rs/crates/ck-core/src/image.rs:194 | iter | HOT-PATH-OK | nested | one output row (≤ 2176) |
| engine-rs/crates/ck-core/src/image.rs:253 | loop | HOT-PATH-OK | nested | horizontal pass over the source rows |
| engine-rs/crates/ck-core/src/image.rs:256 | loop+iter | HOT-PATH-OK | nested | output columns |
| engine-rs/crates/ck-core/src/image.rs:267 | loop+iter | HOT-PATH-OK | nested | vertical pass, output rows |
| engine-rs/crates/ck-core/src/image.rs:269 | loop | HOT-PATH-OK | nested | output columns |
| engine-rs/crates/ck-core/src/pipeline.rs:1114 | loop+iter | HOT-PATH-OK | nested | the window's frames |
| engine-rs/crates/ck-core/src/pipeline.rs:1123 | loop | HOT-PATH-OK | nested | the window's frames |
| engine-rs/crates/ck-core/src/pipeline.rs:1142 | loop | HOT-PATH-OK | alloc, nested | the window's frames |
| engine-rs/crates/ck-core/src/pipeline.rs:1152 | iter | HOT-PATH-OK | alloc, nested | the window's frames (≤ 80): moves the model views out, the display views are dropped before the run |
| engine-rs/crates/ck-core/src/pipeline.rs:1160 | iter | HOT-PATH-OK | alloc, nested | ≤ 80 slice references; converted once inside the run (this pass: bf16 -> f32 -> f16 was two passes and an 850 MB float32 copy per 48-frame window) |
| engine-rs/crates/ck-core/src/pipeline.rs:1184 | iter | HOT-PATH-OK | alloc, nested | carry hints: only the frames the next window takes (≤ stride), in parallel, each a small upsample |
| engine-rs/crates/ck-core/src/pipeline.rs:1198 | loop | HOT-PATH-OK | nested | the window's frames; each frame's values blended in parallel, read in stage 1's type |
| engine-rs/crates/ck-core/src/render.rs:27 | loop | HOT-PATH-OK | nested, pixel | one row |
| engine-rs/crates/ck-core/src/render.rs:78 | loop+iter | HOT-PATH-OK | nested | one slice per output row (h ≤ 2160) |
| engine-rs/crates/ck-core/src/runtime.rs:464 | iter | HOT-PATH-OK | nested | each frame converted bf16 -> f16 / f32 straight into the input tensor, parallel (this pass: one pass, was two plus a float32 copy) |
| engine-rs/crates/ck-core/src/runtime.rs:544 | iter | HOT-PATH-OK | alloc, nested | the output's shape (≤ 5 dims) + one copy out of ORT's buffer (the session's outputs are freed right after) |
| engine-rs/crates/ck-core/src/runtime.rs:548 | iter | HOT-PATH-OK | alloc, nested | the output's shape (≤ 5 dims) + one copy out of ORT's buffer, kept as float16 (this pass: was converted to float32 here, on the card's thread) |
| engine-rs/crates/ck-core/src/writers.rs:236 | iter | HOT-PATH-OK | nested | EXR only: one channel's samples (a strided read), per frame |
| engine-rs/crates/ck-core/src/writers.rs:266 | loop | HOT-PATH-OK | alloc, nested | the frames of one batch (1 at the default batch size) |

### Blocking calls on the Electron main process (47)

| File | Rows | Verdicts | What they are |
|---|---|---|---|
| electron/main/appImageQuit.ts | 1 | NOT-WORTH 1 | once at quit, per process of the app's tree: its threads (a few dozen) and their children (a few) |
| electron/main/desktopTheme.ts | 5 | NOT-WORTH 5 | one pass over the process list, once per app run (isKde caches it); one /proc read per process while scanning for Plasma, once per app start (the result is cached); one stat, once per app start (cached in `kde`) |
| electron/main/download.ts | 4 | NOT-WORTH 4 | removes one partial download before an update download (a local unlink); removes a failed download (a local unlink) |
| electron/main/engine.ts | 1 | NOT-WORTH 1 | a few stats + one readdir per engine spawn (the CUDA library folders) |
| electron/main/gpu.ts | 1 | HOT-PATH-OK 1 | one /proc/<pid>/cmdline read per compute process (a few), every 2 s only while a job runs and the window is shown |
| electron/main/index.ts | 2 | SERIAL-REQUIRED 1, NOT-WORTH 1 | one ffmpeg at a time while the next job may be keying on the same machine; one stat per output, once per finished job |
| electron/main/media.ts | 14 | HOT-PATH-OK 1, NOT-WORTH 13 | one readdir per added folder, not per frame of playback; a handful of dropped paths, once per drop; one stat per dropped path, once per drop (blocking but local; the drop is a user action) |
| electron/main/queue.ts | 1 | NOT-WORTH 1 | removes a cancelled / crashed job's temp folder once (the killed engine's float16 temp files, up to a few GB: a few unlinks on a local disk) |
| electron/main/settings.ts | 5 | NOT-WORTH 5 | reads the settings file (a few KB) once at start; a few stats + one readdir per Engine-page check (when the paths are set); one mkdir per settings save (a user action) |
| electron/main/updatePrefs.ts | 4 | NOT-WORTH 4 | reads the update prefs (a few bytes) once at start; one mkdir per prefs save (a user action); writes the prefs file per save |
| electron/main/updater.ts | 9 | NOT-WORTH 8, SERIAL-REQUIRED 1 | one realpath, once per start (the running AppImage); the update folder's few files, once per update action; one unlink per stale AppImage, once per update action |

## Every row, per file

#### .hooks/check_theme_colors.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 31 | loop | NOT-WORTH |  | the source folders' entries, once per gate run | `for (const name of readdirSync(dir)) {` |
| 35 | iter | NOT-WORTH | nested | a few skip patterns per file, once per gate run | `else if (/\.(css\|tsx?)$/.test(p) && !SKIP.some((r) => r.test(p))) files.push(p);` |
| 39 | iter | NOT-WORTH |  | two roots | `ROOTS.forEach(walk);` |
| 41 | iter | NOT-WORTH | alloc | a few token sources | `const staleSources = [...TOKEN_SOURCES.keys()].filter((f) => !files.includes(f));` |
| 49 | iter | NOT-WORTH | alloc | a few token sources | `const exempt = [...TOKEN_SOURCES].map(([file, why]) => '${file}: (whole file) token source: ${why}');` |
| 62 | loop | NOT-WORTH |  | the source files, once per gate run | `for (const file of files) {` |
| 71 | loop | NOT-WORTH | nested | one file's characters, once per gate run (comment stripping) | `for (let k = 0; k <= noComments.length; k++) {` |
| 88 | iter | NOT-WORTH | nested | one file's lines, once per gate run | `source.split("\n").forEach((line, i) => {` |

#### electron/main/appImageQuit.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 31 | loop | NOT-WORTH |  | once at quit; the app's process tree, about 10 processes (capped at MAX_PIDS) | `while (queue.length && out.length < MAX_PIDS) {` |
| 33 | loop | NOT-WORTH | nested | the direct children of one process, a few | `for (const pid of childrenOf(queue.shift()!)) {` |
| 50 | iter | NOT-WORTH | alloc | ≤ MAX_PIDS process ids, once at quit | `export const mountGuardArgs = (pids: number[]): string[] => ["-c", WAIT_SCRIPT, "sh", ...pids.map(String)];` |
| 56 | iter+sync | NOT-WORTH | main-blocking | once at quit, per process of the app's tree: its threads (a few dozen) and their children (a few) | `return readdirSync('/proc/${pid}/task').flatMap((tid) => readFileSync('/proc/${pid}/task/${tid}/children', "ut` |

#### electron/main/desktopTheme.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 28 | loop+sync | NOT-WORTH | main-blocking | one pass over the process list, once per app run (isKde caches it) | `for (const pid of readdirSync("/proc")) {` |
| 32 | sync | NOT-WORTH | main-blocking | one /proc read per process while scanning for Plasma, once per app start (the result is cached) | `if (/^(plasmashell\|kwin_wayland\|kwin_x11)$/.test(readFileSync('/proc/${pid}/comm', "utf8").trim())) return tru` |
| 48 | sync | NOT-WORTH | main-blocking | one stat, once per app start (cached in `kde`) | `kde ??= isKdeSession(process.env, existsSync(kdeGlobals), plasmaRunning);` |
| 50 | sync | NOT-WORTH | main-blocking | one stat per palette read (Desktop theme only, on a theme change) | `return kde && existsSync(kdeGlobals);` |
| 72 | wait | NOT-WORTH | no-timeout | one gdbus portal read per palette refresh (Desktop theme only) [bounded: its 2 s timeout option] | `execFile(` |
| 92 | iter | NOT-WORTH |  | three channels | `resolve([m[1], m[2], m[3]].map((v) => Math.round(Math.min(1, Math.max(0, Number(v))) * 255)) as Rgb);` |
| 105 | sync | NOT-WORTH | main-blocking | reads kdeglobals (a few KB) per palette refresh, Desktop theme only | `text = readFileSync(kdeGlobals, "utf8");` |
| 127 | timer | NOT-WORTH |  | one-shot 300 ms debounce per settings-file change | `timer = setTimeout(onChange, 300); // lifetime: OK — one-shot 300 ms debounce, cleared by the next fire()` |

#### electron/main/download.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 33 | sync | NOT-WORTH | main-blocking | one stat per resumed download | `size = statSync(path).size;` |
| 40 | loop | SERIAL-REQUIRED |  | stream order: the partial file is hashed in sequence before the rest arrives | `for await (const chunk of createReadStream(path, { signal: abort })) hash.update(chunk as Buffer);` |
| 71 | sync | NOT-WORTH | main-blocking | removes one stale partial download (a local unlink) | `rmSync(path, { force: true });` |
| 77 | sync | NOT-WORTH | main-blocking | removes one partial download before an update download (a local unlink) | `rmSync(path, { force: true });` |
| 85 | timer | NOT-WORTH | alloc | one connect deadline per download [bounded: CONNECT_TIMEOUT_MS] | `const connectTimer = setTimeout(() => connect.abort(new DOMException("the download server didn't answer", "Tim` |
| 120 | timer | NOT-WORTH | alloc | one stall deadline per download [bounded: stallMs without data] | `const stallTimer = setTimeout(() => {` |
| 130 | loop | SERIAL-REQUIRED | alloc | stream order: each chunk is hashed and written in sequence, with a stall deadline | `for (;;) {` |
| 151 | sync | NOT-WORTH | main-blocking | removes a failed download (a local unlink) | `if (!opts.resume) rmSync(path, { force: true });` |
| 157 | sync | NOT-WORTH | main-blocking | removes a failed download (a local unlink) | `rmSync(path, { force: true });` |
| 162 | sync | NOT-WORTH | main-blocking | removes a failed download (a local unlink) | `rmSync(path, { force: true });` |

#### electron/main/engine.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 54 | loop | NOT-WORTH |  | six names, once per engine spawn | `for (const k of ["LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "ELECTRON_RUN_A` |
| 70 | sync | NOT-WORTH | main-blocking | a few stats + one readdir per engine spawn (the CUDA library folders) | `list: (p: string) => string[] = (p) => readdirSync(p),` |
| 77 | loop | NOT-WORTH |  | five names, once per engine spawn | `for (const k of ["LD_PRELOAD", "ELECTRON_RUN_AS_NODE", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LI` |
| 87 | loop+iter | NOT-WORTH |  | a handful of CUDA library folders | `for (const d of list(nvidia).sort()) {` |
| 89 | loop | NOT-WORTH | nested | two candidate folders per CUDA package | `for (const sub of win ? [join("bin", "x86_64"), "bin"] : ["lib"]) if (exists(join(nvidia, d, sub))) dirs.push(` |
| 96 | loop+iter | NOT-WORTH |  | the runtime folder's few entries, once per engine spawn | `for (const d of list(site).filter((n) => /^msvc_runtime-[\d.]+\.data$/.test(n))) if (exists(join(site, d, "dat` |
| 102 | iter | NOT-WORTH | alloc | a user's extra library folders, once per engine spawn | `if (env.CK_ENGINE_LD_LIBRARY_PATH) dirs.push(...env.CK_ENGINE_LD_LIBRARY_PATH.split(win ? ";" : ":").filter(Bo` |
| 161 | timer | SERIAL-REQUIRED | alloc | the ping deadline (PING_TIMEOUT_MS), once per engine start | `const timer = setTimeout(() => {` |
| 179 | loop | NOT-WORTH |  | drops at most one line per added line | `while (this.stderr.length > STDERR_LINES) this.stderr.shift();` |
| 201 | timer | SERIAL-REQUIRED |  | the quit grace (QUIT_GRACE_MS), then kill; once per engine stop | `setTimeout(() => {` |

#### electron/main/engineFind.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 25 | sync | NOT-WORTH | main-blocking | lists the models / runtime folders (a few entries), once per Engine check | `list: (p) => readdirSync(p),` |
| 27 | sync | NOT-WORTH | main-blocking | reads one small manifest.json per model set, once per Engine check | `read: (p) => readFileSync(p, "utf8"),` |
| 36 | iter | NOT-WORTH |  | sorts a few folder names | `.filter((n) => !n.startsWith("."))` |
| 47 | iter | NOT-WORTH |  | a few version parts | `return v.split(".").map((n) => Number.parseInt(n, 10) \|\| 0);` |
| 51 | loop | NOT-WORTH |  | a few version parts | `for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (` |
| 63 | loop | NOT-WORTH | alloc | one folder per installed model set (one or two) | `for (const name of dirs(modelsRoot, d)) {` |
| 74 | iter | NOT-WORTH | alloc, nested | ten models per manifest | `precisions = [...new Set((m.models ?? []).map((x) => x.precision).filter((p): p is string => !!p))].sort();` |
| 81 | iter | NOT-WORTH |  | sorts one or two model sets | `models.sort((a, b) => b.created.localeCompare(a.created) \|\| b.label.localeCompare(a.label));` |
| 86 | loop | NOT-WORTH |  | one folder per installed runtime (one or two) | `for (const name of dirs(runtimeRoot, d)) {` |
| 90 | iter | NOT-WORTH | nested | a dozen files in ONNX Runtime's capi folder | `const lib = dirs(capi, d).find((f) => o.match.test(f));` |
| 95 | iter | NOT-WORTH | nested | a few folders in one runtime | `.map((f) => /^onnxruntime(?:_gpu)?-([\d.]+)\.dist-info$/.exec(f)?.[1])` |
| 97 | iter | NOT-WORTH | nested | as above | `.find(Boolean);` |
| 105 | iter | NOT-WORTH |  | sorts one or two runtimes | `ort.sort((a, b) => newerFirst(a.key, b.key));` |
| 108 | iter | NOT-WORTH |  | strips the sort keys from a few entries | `return { binary, models: models.map(({ path, label }) => ({ path, label })), ort: ort.map(({ path, label }) =>` |
| 121 | iter | NOT-WORTH |  | two candidates, two stats per engine start | `return [binary ? join(dirname(binary), TRT_BUILDER) : null, distDir ? join(distDir, TRT_BUILDER) : null].find(` |

#### electron/main/ffmpeg.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 22 | wait | SERIAL-REQUIRED |  | one ffmpeg/ffprobe check or one install at a time, with its own timeout | `execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20, windowsHide: true }, (err, stdout, stderr) => (e` |
| 67 | iter | NOT-WORTH | alloc | a few words from os-release | `const ids = [field("ID"), ...field("ID_LIKE").split(/\s+/)].filter(Boolean);` |
| 79 | iter | NOT-WORTH |  | a few os-release ids | `if (ids.some((i) => i === "debian" \|\| i === "ubuntu"))` |
| 82 | iter | NOT-WORTH |  | a few os-release ids | `if (ids.some((i) => i === "arch")) return { command: "sudo pacman -S ffmpeg", argv: ["pacman", "-S", "--noconf` |
| 84 | iter | NOT-WORTH |  | a few os-release ids | `if (ids.some((i) => i === "rhel"))` |
| 91 | iter | NOT-WORTH |  | a few os-release ids | `if (ids.some((i) => i === "fedora"))` |
| 98 | iter | NOT-WORTH |  | a few os-release ids | `if (ids.some((i) => i.startsWith("opensuse") \|\| i === "suse"))` |
| 109 | wait | SERIAL-REQUIRED |  | one check at a time [bounded: CHECK_TIMEOUT_MS] | `await run("ffprobe", ["-version"], CHECK_TIMEOUT_MS);` |
| 117 | wait | SERIAL-REQUIRED |  | one check at a time [bounded: CHECK_TIMEOUT_MS] | `encoders = await run("ffmpeg", ["-hide_banner", "-encoders"], CHECK_TIMEOUT_MS);` |
| 123 | iter | NOT-WORTH | alloc | two encoder names | `const missing = ["libx264", "prores_ks"].filter((e) => !new RegExp('\\s${e}\\s').test(encoders));` |
| 148 | sync | NOT-WORTH | main-blocking | a few readdirs of winget's folders, once per ffmpeg check on Windows | `export function wingetFfmpegDirs(localAppData: string, list: (p: string) => string[] = (p) => readdirSync(p)):` |
| 160 | loop+iter | NOT-WORTH |  | winget's package folders (a few), once per ffmpeg check on Windows | `for (const pkg of ls(join(root, "Packages")).filter((n) => n.startsWith("Gyan.FFmpeg")))` |
| 162 | loop | NOT-WORTH |  | the one ffmpeg-<version> folder inside | `for (const sub of ls(join(root, "Packages", pkg))) if (ls(join(root, "Packages", pkg, sub)).includes("bin")) o` |
| 169 | sync | NOT-WORTH | main-blocking | reads /etc/os-release (a few hundred bytes) once per check | `return readFileSync("/etc/os-release", "utf8");` |
| 181 | wait | SERIAL-REQUIRED |  | one install at a time [bounded: the user's password prompt and the package manager; never killed mid-install] | `await (plan.elevate === false ? run(plan.argv[0], plan.argv.slice(1), INSTALL_TIMEOUT_MS) : run("pkexec", plan` |
| 191 | iter | NOT-WORTH |  | the failed install's output lines, once per failure | `.map((l) => l.trim())` |

#### electron/main/gpu.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 16 | iter | NOT-WORTH |  | four fields, every GPU_POLL_MS while a job runs and the window is shown | `const parts = line.split(",").map((s) => s.trim());` |
| 30 | iter | NOT-WORTH |  | a few compute processes, every GPU_POLL_MS while a job runs and the window is shown | `.map((l) => /^\s*(\d+)\s*,\s*(.*?)\s*,\s*([\d.]+\|\[N\/A\])\s*$/.exec(l))` |
| 32 | iter | NOT-WORTH |  | as above | `.filter((m): m is RegExpExecArray => m !== null)` |
| 34 | iter | NOT-WORTH |  | as above | `.map((m) => ({ pid: Number(m[1]), exe: m[2], usedMb: Number(m[3]) \|\| 0 }))` |
| 52 | sync | HOT-PATH-OK | main-blocking | one /proc/<pid>/cmdline read per compute process (a few), every 2 s only while a job runs and the window is shown | `return readFileSync('/proc/${pid}/cmdline', "utf8");` |
| 62 | wait | HOT-PATH-OK |  | nvidia-smi every 2 s while a job runs and the window is shown; GPU_READ_TIMEOUT_MS 5 s and one read at a time (this pass) | `run("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits` |
| 64 | wait | HOT-PATH-OK |  | the same read's second query, same timeout | `run("nvidia-smi", ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"], { ti` |
| 70 | iter | HOT-PATH-OK |  | a few compute processes, every GPU_POLL_MS only while a job runs and the window is shown | `const processes: GpuProcess[] = parseApps(apps.stdout).map(({ pid, exe, usedMb }) => ({ pid, usedMb, name: pro` |

#### electron/main/index.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 194 | iter | HOT-PATH-OK | alloc | one shallow copy per job per state push (≤ 10/s while shown) | `jobs: queue.jobs.map((j) => (j.log.length > LOG_SHOWN ? { ...j, log: j.log.slice(-LOG_SHOWN), logLines: j.log.` |
| 228 | timer | HOT-PATH-OK |  | state pushes coalesced to ≤ 10/s, only while the window is shown (this pass); measured ~2/s during a job (engine replies), 3-134 KiB each | `sendTimer = setTimeout(() => {` |
| 268 | timer | HOT-PATH-OK |  | two nvidia-smi calls every 2 s, only while a job runs and the window is shown | `gpuTimer = setInterval(() => void pollGpu(), GPU_POLL_MS);` |
| 303 | loop | SERIAL-REQUIRED | main-blocking | one ffmpeg at a time while the next job may be keying on the same machine | `for (const output of order) {` |
| 305 | iter | NOT-WORTH | nested | ≤ four outputs, once per finished job | `const file = job.outputs.find((f) => basename(f).includes('_${output === "checker" ? "checker_comp" : output}'` |
| 307 | sync | NOT-WORTH | main-blocking | one stat per output, once per finished job | `if (!file \|\| !existsSync(file)) continue;` |
| 319 | loop | SERIAL-REQUIRED | alloc | ffprobe/ffmpeg per clip, one at a time so a big drop doesn't fork dozens | `for (const { path, kind } of expandPaths(paths)) {` |
| 321 | iter | NOT-WORTH | nested | the queue's jobs per dropped clip (a drop of N clips is N × jobs comparisons) | `if (queue.jobs.some((j) => j.clip.path === path && j.status === "waiting")) continue;` |
| 376 | iter | NOT-WORTH | alloc | seven extensions, once per file dialog | `filters: [{ name: "Video", extensions: [...VIDEO_EXT].map((e) => e.slice(1)) }],` |
| 387 | iter | NOT-WORTH | alloc | a few extensions, once per file dialog | `filters: kind === "hint-image" ? [{ name: "Matte image", extensions: [...HINT_IMAGE_EXT].map((e) => e.slice(1)` |
| 419 | iter | NOT-WORTH |  | one or two found copies, once per list choice | `const offered = engineFiles[whatArg].some((f) => f.path === pathArgIn) \|\| pathArgIn === settings[key];` |
| 439 | wait | NOT-WORTH | no-timeout | the fetch the install is given; downloadVerified sets a connect timeout and a stall deadline [bounded: CONNECT_TIMEOUT_MS / STALL_TIMEOUT_MS] | `fetch: (url, init) => net.fetch(url, init),` |
| 481 | iter | NOT-WORTH |  | three items, once per click | `const item = storageItems(enginePlaces().data, cacheDir, systemSupport(PLATFORM, process.arch, existsSync, pro` |
| 656 | wait | NOT-WORTH | no-timeout | one local file per media request (thumbnails / stills from the app's cache) [bounded: a local file: URL] | `return net.fetch(pathToFileURL(file).toString());` |

#### electron/main/install.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 262 | iter | NOT-WORTH |  | sums a dozen sizes, once per plan | `const total = (d: Download[]) => d.reduce((n, x) => n + x.size, 0);` |
| 293 | sync | NOT-WORTH | main-blocking | one statfs per install start | `const s = statfsSync(dir);` |
| 332 | sync | NOT-WORTH | main-blocking | one mkdir per install (the disk check needs the folder) | `mkdirSync(data, { recursive: true });` |
| 338 | sync | NOT-WORTH | main-blocking | one mkdir per install | `mkdirSync(downloads, { recursive: true });` |
| 345 | sync | NOT-WORTH | main-blocking | clears a half-unpacked runtime once per install | `rmSync(partial, { recursive: true, force: true });` |
| 347 | loop | SERIAL-REQUIRED | alloc | one wheel at a time (download, then unpack), see fetchOne | `for (const w of RUNTIME.wheels) {` |
| 355 | iter | NOT-WORTH | alloc, nested | the few names one wheel unpacked | `if (!unpacked.some((n) => LIBRARY_FILE.test(n))) throw new Error('${w.file} had none of the expected libraries` |
| 358 | sync | NOT-WORTH | main-blocking | one rename: the runtime appears whole | `renameSync(partial, join(data, RUNTIME_DIR, RUNTIME.name));` |
| 362 | sync | NOT-WORTH | main-blocking | eight local unlinks, once per install | `if (existsSync(join(data, RUNTIME_DIR, RUNTIME.name))) for (const w of RUNTIME.wheels) rmSync(join(downloads, ` |
| 367 | sync | NOT-WORTH | main-blocking | one mkdir per install | `mkdirSync(partial, { recursive: true });` |
| 370 | loop | SERIAL-REQUIRED |  | one file at a time, see fetchOne | `for (const f of MODELS.files) await fetchOne(f, 'Downloading the CorridorKey models (${f.file})', join(partial` |
| 372 | sync | NOT-WORTH | main-blocking | one rename: the model set appears whole | `renameSync(partial, join(data, MODELS_DIR, MODELS.name));` |
| 375 | sync | NOT-WORTH | main-blocking | one readdir of the (now empty) downloads folder | `if (readdirSync(downloads).length === 0) rmSync(downloads, { recursive: true, force: true });` |
| 456 | iter | NOT-WORTH |  | a dozen model files, once per plan | `return c.models.files.find((m) => m.sha256 === f.sha256 && m.size === f.size);` |
| 462 | iter | NOT-WORTH |  | eight wheels, once per plan | `const w = c.runtime.wheels.find((x) => /^onnxruntime/.test(x.file));` |
| 486 | iter | NOT-WORTH |  | sixteen model files, once per plan | `const modelBytes = total(c.trtModels.files.filter((f) => !copied(f)));` |
| 491 | iter | NOT-WORTH |  | sixteen model files, once at load | `const TRT_MODEL_DOWNLOAD = TENSORRT.models.files.filter((f) => !localTwin(f, CATALOG));` |
| 517 | sync | NOT-WORTH | main-blocking | reads one small models.json per install / removal | `const readJson = (p: string): ModelsJson => JSON.parse(readFileSync(p, "utf8")) as ModelsJson;` |
| 521 | sync | NOT-WORTH | main-blocking | one small file written once per install / removal | `writeFileSync('${p}.tmp', text);` |
| 523 | sync | NOT-WORTH | main-blocking | one rename, as above | `renameSync('${p}.tmp', p);` |
| 530 | sync | NOT-WORTH | main-blocking | two stats per install start | `if (!existsSync(p.runtime) \|\| !existsSync(p.models)) throw new Error("install the GPU runtime and the Corridor` |
| 538 | sync | NOT-WORTH | main-blocking | one mkdir per install | `mkdirSync(downloads, { recursive: true });` |
| 544 | sync | NOT-WORTH | main-blocking | clears a half-unpacked TensorRT once per install | `rmSync(partial, { recursive: true, force: true });` |
| 550 | iter | NOT-WORTH | alloc | the few names the wheel unpacked | `if (!unpacked.some((n) => /^tensorrt_libs\/libnvinfer\.so\./.test(n))) throw new Error('${c.libs.file} had non` |
| 553 | loop+iter+sync | NOT-WORTH | main-blocking | the partial folder's two entries | `for (const d of readdirSync(partial).filter((n) => TRT_DIST_INFO.test(n))) {` |
| 555 | sync | NOT-WORTH | main-blocking | one licence folder replaced | `rmSync(join(p.runtime, d), { recursive: true, force: true });` |
| 557 | sync | NOT-WORTH | main-blocking | one rename | `renameSync(join(partial, d), join(p.runtime, d));` |
| 560 | sync | NOT-WORTH | main-blocking | one rename: the libraries appear whole | `renameSync(join(partial, TRT_LIBS_DIR), p.libs);` |
| 562 | sync | NOT-WORTH | main-blocking | removes the emptied partial folder | `rmSync(partial, { recursive: true, force: true });` |
| 565 | sync | NOT-WORTH | main-blocking | one local unlink once the libraries are in place (also after a crash before it) | `if (existsSync(p.libs)) rmSync(join(downloads, c.libs.file), { force: true });` |
| 571 | sync | NOT-WORTH | main-blocking | clears a half-unpacked provider once per install | `rmSync(partial, { recursive: true, force: true });` |
| 577 | sync | NOT-WORTH | main-blocking | one stat | `if (!existsSync(got)) throw new Error('${w.file} had no ${TRT_PROVIDER}');` |
| 579 | sync | NOT-WORTH | main-blocking | one rename: the provider appears whole | `renameSync(got, p.provider);` |
| 581 | sync | NOT-WORTH | main-blocking | removes the partial folder and the wheel (local unlinks) | `rmSync(partial, { recursive: true, force: true });` |
| 583 | sync | NOT-WORTH | main-blocking | as above | `rmSync(join(downloads, w.file), { force: true });` |
| 589 | sync | NOT-WORTH | main-blocking | one mkdir per install | `mkdirSync(partial, { recursive: true });` |
| 591 | loop | SERIAL-REQUIRED | main-blocking | one file at a time, see fetcher | `for (const f of c.trtModels.files) {` |
| 596 | sync | NOT-WORTH | main-blocking | a few stats per model file | `const fromTwin = !!twinPath && existsSync(twinPath);` |
| 598 | sync | NOT-WORTH | main-blocking | one stat per model file | `if (!existsSync(target)) {` |
| 601 | sync | NOT-WORTH | main-blocking | one stat + rename per model file | `if (f.file !== "models.json" && existsSync(join(p.models, f.file))) renameSync(join(p.models, f.file), target)` |
| 605 | sync | NOT-WORTH | main-blocking | one local copy (a reflink where the file system has them) [bounded: 1.7 GB] | `copyFileSync(twinPath!, target, constants.COPYFILE_FICLONE);` |
| 611 | loop+sync | NOT-WORTH | main-blocking | sixteen local renames, once per install | `for (const f of c.trtModels.files) if (f.file !== "models.json") renameSync(join(partial, f.file), join(p.mode` |
| 616 | sync | NOT-WORTH | main-blocking | one rename: the TensorRT models count as installed from here | `renameSync(join(partial, "models.json"), p.list);` |
| 618 | sync | NOT-WORTH | main-blocking | removes the emptied partial folder | `rmSync(partial, { recursive: true, force: true });` |
| 621 | sync | NOT-WORTH | main-blocking | one readdir of the (now empty) downloads folder | `if (readdirSync(downloads).length === 0) rmSync(downloads, { recursive: true, force: true });` |
| 638 | sync | NOT-WORTH | main-blocking | one local unlink per user click | `rmSync(p.list, { force: true });` |
| 641 | sync | NOT-WORTH | main-blocking | one stat per user click | `if (existsSync(modelsJson)) {` |
| 643 | iter | NOT-WORTH |  | a few keys | `const left = Object.fromEntries(Object.entries(readJson(modelsJson)).filter(([k]) => !keys.includes(k) && !k.s` |
| 647 | loop+sync | NOT-WORTH | main-blocking | sixteen local unlinks per user click | `for (const f of c.trtModels.files) if (f.file !== "models.json") rmSync(join(p.models, f.file), { force: true ` |
| 649 | sync | NOT-WORTH | main-blocking | removes a stopped install's folder, per user click | `rmSync(join(data, MODELS_DIR, '.partial-${c.trtModels.name}'), { recursive: true, force: true });` |
| 651 | sync | NOT-WORTH | main-blocking | removes the libraries folder (a few dozen files), per user click | `rmSync(p.libs, { recursive: true, force: true });` |
| 653 | sync | NOT-WORTH | main-blocking | as above, a stopped unpack | `rmSync(join(p.runtime, '.partial-${TRT_LIBS_DIR}'), { recursive: true, force: true });` |
| 655 | iter+sync | NOT-WORTH | main-blocking | the runtime folder's few entries, per user click | `if (existsSync(p.runtime)) for (const d of readdirSync(p.runtime).filter((n) => TRT_DIST_INFO.test(n))) rmSync` |

#### electron/main/media.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 30 | loop | NOT-WORTH |  | the runs of two file names, per comparison | `for (let i = 0; i < Math.min(pa.length, pb.length); i++) {` |
| 42 | loop | NOT-WORTH | nested | the characters of one run | `for (let k = 0; k < n; k++) if (x[k] !== y[k]) return x.charCodeAt(k) - y.charCodeAt(k);` |
| 54 | sync | HOT-PATH-OK | main-blocking | one readdir per added folder, not per frame of playback | `readdirSync(dir)` |
| 56 | iter | NOT-WORTH |  | a frame folder's names, once per probe | `.filter((f) => FRAME_EXT.has(extname(f).toLowerCase()))` |
| 65 | iter+sync | NOT-WORTH | main-blocking | one readdir per added folder, stops at the first frame file | `return readdirSync(dir).some((f) => FRAME_EXT.has(extname(f).toLowerCase()));` |
| 72 | loop | NOT-WORTH | main-blocking | a handful of dropped paths, once per drop | `for (const p of paths) {` |
| 74 | sync | NOT-WORTH | main-blocking | one stat per dropped path, once per drop (blocking but local; the drop is a user action) | `if (!existsSync(p)) continue;` |
| 76 | sync | NOT-WORTH | main-blocking | one stat per dropped path, once per drop | `if (statSync(p).isFile()) {` |
| 82 | iter+sync | NOT-WORTH | nested, main-blocking | one readdir + a stat per entry of a dropped folder, once per drop | `const input = readdirSync(p).find((n) => n.toLowerCase() === "input" && statSync(join(p, n)).isDirectory());` |
| 92 | loop+iter+sync | NOT-WORTH | nested, main-blocking | one folder level of a dropped batch folder, once per drop | `for (const name of readdirSync(p).sort()) {` |
| 95 | sync | NOT-WORTH | main-blocking | one stat per entry of a dropped folder, once per drop | `if (statSync(child).isFile() && VIDEO_EXT.has(extname(name).toLowerCase()) && !isCompanionHint(child)) out.pus` |
| 108 | sync | NOT-WORTH | main-blocking | one stat per hint lookup, once per probed clip | `if (!existsSync(dir)) return null;` |
| 112 | loop+iter+sync | NOT-WORTH | main-blocking | one readdir of the clip's folder, once per added clip | `for (const name of readdirSync(dir).sort()) {` |
| 115 | sync | NOT-WORTH | main-blocking | one stat per candidate hint file, once per probed clip | `if (!exts.has(extname(name).toLowerCase()) \|\| !statSync(full).isFile()) continue;` |
| 120 | iter | NOT-WORTH | nested | a few hint markers per file name | `const marker = markers.find((m) => rest.startsWith(m));` |
| 124 | loop | NOT-WORTH |  | at most two markers | `for (const m of markers) if (found.has(m)) return found.get(m)!;` |
| 139 | iter+sync | NOT-WORTH | main-blocking | one readdir of a shot folder + a stat, once per probed clip | `const hint = readdirSync(shot).find((n) => n.toLowerCase() === "alphahint" && statSync(join(shot, n)).isDirect` |
| 154 | iter | NOT-WORTH |  | a rate's two numbers | `const [n, d] = rate.split("/").map(Number);` |
| 181 | wait | SERIAL-REQUIRED |  | ffprobe of one frame image per probed folder, PROBE_TIMEOUT_MS (this pass: had none) | `const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json",` |
| 190 | sync | NOT-WORTH | main-blocking | one mkdir (exists after the first) per still | `mkdirSync(cacheDir, { recursive: true });` |
| 193 | sync | NOT-WORTH | main-blocking | one stat per still (the cache key) | `.update('${source}\|${statSync(source).mtimeMs}\|${seconds}\|${width}')` |
| 198 | sync | NOT-WORTH | main-blocking | one stat per still (cache hit check) | `if (existsSync(out)) return out;` |
| 201 | wait | SERIAL-REQUIRED |  | one ffmpeg still at a time, STILL_TIMEOUT_MS (this pass: had none) | `await run("ffmpeg", ["-v", "error", "-y", ...seek, "-i", source, "-frames:v", "1", "-vf", 'scale=${width}:-2',` |

#### electron/main/partial.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 32 | sync | NOT-WORTH | main-blocking | one stat per job start | `const madeOutputDir = !existsSync(outputDir);` |
| 35 | sync | NOT-WORTH | main-blocking | one folder per job start (normally absent) | `rmSync(staging, { recursive: true, force: true });` |
| 39 | loop+iter+sync | NOT-WORTH | main-blocking | one readdir per job start, then the rare leftovers | `for (const n of readdirSync(outputDir).filter((x) => x.startsWith(DISCARD_PREFIX))) void rm(join(outputDir, n)` |
| 44 | sync | NOT-WORTH | main-blocking | one mkdir per job start | `mkdirSync(staging, { recursive: true });` |
| 62 | sync | NOT-WORTH | main-blocking | the staging folder's few entries (≤ four outputs + the settings file), once per job | `names = readdirSync(staging);` |
| 70 | loop | NOT-WORTH | main-blocking | ≤ five entries, once per finished job | `for (const name of names) {` |
| 75 | sync | NOT-WORTH | main-blocking | one small text file per job | `const text = readFileSync(from, "utf8");` |
| 77 | sync | NOT-WORTH | main-blocking | one small text file per job | `writeFileSync(from, text.split(staging).join(outputDir));` |
| 80 | sync | NOT-WORTH | main-blocking | one lstat per entry | `const old = lstatSync(to, { throwIfNoEntry: false });` |
| 84 | sync | NOT-WORTH | main-blocking | one rename per replaced folder | `renameSync(to, aside);` |
| 86 | sync | NOT-WORTH | main-blocking | one rename per entry | `renameSync(from, to);` |
| 95 | sync | NOT-WORTH | main-blocking | one rename per entry | `renameSync(from, to);` |
| 111 | sync | NOT-WORTH | main-blocking | one rmdir per job; it fails while anything is in the folder | `rmdirSync(staging);` |
| 124 | iter+sync | NOT-WORTH | main-blocking | the staging folder's few entries, once per failed job | `n = readdirSync(staging).filter((x) => !x.startsWith(".replaced-")).length;` |
| 134 | sync | NOT-WORTH | main-blocking | one rename per failed job | `renameSync(staging, aside);` |
| 148 | sync | NOT-WORTH | main-blocking | one rmdir; it fails (and is left) when anything else is in the folder | `rmdirSync(outputDir);` |

#### electron/main/platform.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 65 | iter | NOT-WORTH |  | a few folders, once per check or engine start | `const have = (list ?? "").split(sep).filter(Boolean);` |
| 67 | iter | NOT-WORTH |  | as above | `const add = dirs.filter((d, i) => d && !have.includes(d) && dirs.indexOf(d) === i);` |

#### electron/main/queue.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 70 | iter | NOT-WORTH |  | at most five networks, once per TensorRT job | `const fell = Object.entries(r.fallbacks as Record<string, unknown>).map(([k, why]) => '${k} (${String(why)})')` |
| 110 | iter | NOT-WORTH |  | the queue's jobs, once per user action | `const job = this.jobs.find((j) => j.id === id);` |
| 113 | iter | NOT-WORTH |  | the queue's jobs, once per user action | `this.jobs = this.jobs.filter((j) => j.id !== id);` |
| 119 | iter | NOT-WORTH |  | the queue's jobs, once per user action | `const job = this.jobs.find((j) => j.id === id);` |
| 143 | iter | NOT-WORTH |  | the queue's jobs, once per user action | `const job = this.jobs.find((j) => j.id === id);` |
| 230 | iter | NOT-WORTH |  | the queue's jobs, once per job start | `const job = this.jobs.find((j) => j.status === "waiting" && !j.clip.probeError && !missingInput(j));` |
| 317 | iter | NOT-WORTH |  | ≤ four output paths, once per job | `job.outputs = Array.isArray(r.outputs) ? (r.outputs as string[]).map((p) => finalPath(job.outputDir, String(p)` |
| 373 | sync | NOT-WORTH | main-blocking | removes a cancelled / crashed job's temp folder once (the killed engine's float16 temp files, up to a few GB: a few unlinks on a local disk) | `rmSync(this.deps.tempDirFor(id), { recursive: true, force: true });` |
| 386 | sync | NOT-WORTH | main-blocking | the jobs folder's entries, once per app start | `names = readdirSync(root);` |
| 392 | loop+sync | NOT-WORTH | main-blocking | leftover job folders (usually none), once per app start | `for (const n of names) rmSync(join(root, n), { recursive: true, force: true });` |

#### electron/main/relaunch.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 23 | loop | NOT-WORTH |  | the entries of one PATH-style variable, once per restart | `for (const d of list.split(":")) {` |
| 54 | loop | NOT-WORTH |  | a fixed list of 16 names | `for (const v of SESSION_VARS) {` |
| 66 | iter | NOT-WORTH |  | the command line, once per relaunch | `return argv.slice(1).filter((a) => typeof a === "string" && !/^--type=/.test(a));` |
| 95 | iter | NOT-WORTH |  | two paths, once per restart | `return ["/bin/bash", "/usr/bin/bash"].find(exists) ?? "/bin/sh";` |
| 108 | iter | NOT-WORTH |  | a few environment variables, once per relaunch | `const setenv = Object.entries(o.env ?? {}).map(([k, v]) => '--setenv=${k}=${v}');` |

#### electron/main/settings.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 11 | sync | NOT-WORTH | main-blocking | reads the settings file (a few KB) once at start | `saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;` |
| 45 | sync | NOT-WORTH | main-blocking | a few stats + one readdir per Engine-page check (when the paths are set) | `list: (p: string) => string[] = (p) => readdirSync(p),` |
| 62 | iter | NOT-WORTH |  | five networks × the models folder's files, once per check | `const missing = MODEL_PIECES.filter((p) => !files.some((f) => f.endsWith(".onnx") && (f.startsWith('${p}_') \|\|` |
| 78 | sync | NOT-WORTH | main-blocking | one mkdir per settings save (a user action) | `mkdirSync(dirname(file), { recursive: true });` |
| 81 | sync | NOT-WORTH | main-blocking | writes the settings file (a few KB) per save | `writeFileSync(tmp, JSON.stringify(settings, null, 2));` |
| 83 | sync | NOT-WORTH | main-blocking | one rename per save (atomic replace) | `renameSync(tmp, file);` |
| 97 | iter | NOT-WORTH |  | a few required paths, once per check | `const problems = need.filter(([p]) => !exists(join(root, p))).map(([p, what]) => 'Missing ${p}: ${what}.');` |

#### electron/main/storage.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 26 | sync | NOT-WORTH | main-blocking | one readdir per folder, only when App settings shows Storage (a few hundred files) | `names = readdirSync(dir);` |
| 32 | loop | NOT-WORTH | main-blocking | a few hundred files per measure, only when App settings shows Storage | `for (const n of names) {` |
| 36 | sync | NOT-WORTH | main-blocking | one lstat per file, as above | `const s = statSync(p, { throwIfNoEntry: false });` |
| 52 | loop+iter+sync | NOT-WORTH | main-blocking | the runtime folder's few entries, only when App settings shows Storage | `for (const d of readdirSync(p.runtime).filter((n) => TRT_DIST_INFO.test(n))) licence += folderBytes(join(p.run` |
| 57 | iter | NOT-WORTH |  | sixteen names, only when App settings shows Storage | `const files = [TRT_MODELS_LIST, ...(c?.trtModels ?? TENSORRT.models).files.map((x) => x.file).filter((n) => n ` |
| 60 | loop+sync | NOT-WORTH | main-blocking | sixteen stats, only when App settings shows Storage | `for (const f of files) models += statSync(join(p.models, f), { throwIfNoEntry: false })?.size ?? 0;` |
| 91 | sync | NOT-WORTH | main-blocking | removes the built engines (a few files per resolution), per user click | `rmSync(join(cacheDir, TRT_ENGINES_DIR), { recursive: true, force: true });` |
| 95 | sync | NOT-WORTH | main-blocking | one folder removed per user click (a confirm dialog first) | `rmSync(item.path, { recursive: true, force: true });` |
| 106 | iter+sync | NOT-WORTH | main-blocking | one readdir + a stat per cached still, once per app start | `files = readdirSync(dir).map((n) => {` |
| 108 | sync | NOT-WORTH | main-blocking | one stat per cached still, once per app start | `const s = statSync(join(dir, n));` |
| 118 | iter | NOT-WORTH |  | sorts the cached stills once per start (oldest first) | `files.sort((a, b) => a.mtime - b.mtime);` |
| 120 | iter | NOT-WORTH |  | sums the cached stills once per start | `let total = files.reduce((n, f) => n + f.size, 0);` |
| 122 | loop | NOT-WORTH | main-blocking | removes old stills once per start (local unlinks) | `for (const f of files) {` |
| 125 | sync | NOT-WORTH | main-blocking | one unlink per pruned still, once per app start | `rmSync(f.p, { force: true, recursive: true });` |

#### electron/main/unzip.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 23 | sync | NOT-WORTH | main-blocking | one positioned read of the zip's end record or one local header | `readSync(fd, b, 0, length, offset);` |
| 37 | sync | NOT-WORTH | main-blocking | one stat per unpack | `const size = fstatSync(fd).size;` |
| 42 | loop | NOT-WORTH |  | scans back over the zip comment (≤ 64 KiB) for the end record, once per unpack | `for (let i = tail.length - 22; i >= 0; i--)` |
| 64 | loop | NOT-WORTH | alloc | one pass over the directory (a few hundred entries per wheel) | `for (let i = 0; i < count; i++) {` |
| 79 | loop | NOT-WORTH | nested | walks one entry's extra fields (a few) | `while (x + 4 <= xEnd && cd.readUInt16LE(x) !== 0x0001) x += 4 + cd.readUInt16LE(x + 2);` |
| 101 | sync | NOT-WORTH | main-blocking | opens the zip once per unpack | `const fd = openSync(file, "r");` |
| 104 | iter | NOT-WORTH |  | filters a few hundred directory entries once per wheel | `const entries = listZip(fd).filter((e) => !e.name.endsWith("/") && keep(e.name));` |
| 106 | loop | SERIAL-REQUIRED | alloc, main-blocking | one file at a time, streamed (they are hundreds of MB; disk-bound) | `for (const e of entries) {` |
| 116 | sync | NOT-WORTH | main-blocking | one mkdir per unpacked file | `mkdirSync(dirname(target), { recursive: true });` |
| 129 | iter | NOT-WORTH |  | the unpacked names, once per wheel | `return entries.map((e) => e.name);` |
| 132 | sync | NOT-WORTH | main-blocking | closes the zip once per unpack | `closeSync(fd);` |

#### electron/main/updateFeed.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 47 | iter | NOT-WORTH |  | N = 1 trusted key (2 during a rotation) | `return keys.some((k) => {` |
| 74 | loop | NOT-WORTH |  | 4 fixed fields | `for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];` |
| 178 | loop | NOT-WORTH |  | one page of ≤ 50 releases, once per CI run | `for (const r of releases) {` |
| 183 | iter | NOT-WORTH | nested | a release's few assets, once per update check | `const asset = (r.assets ?? []).find((a) => a.name === appImageName(m[1]));` |
| 254 | loop | NOT-WORTH |  | the AppImage folder's entries, once at start | `for (const name of names) {` |
| 261 | iter | NOT-WORTH |  | a few old AppImages, once per cleanup | `older.sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0` |
| 263 | iter | NOT-WORTH | alloc | a few old AppImages, once per cleanup | `return [...out, ...older.slice(1).map((o) => o.name)];` |

#### electron/main/updateFlow.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 131 | timer | NOT-WORTH |  | the first update check, once per start | `this.firstTimer = setTimeout(() => {` |
| 137 | timer | NOT-WORTH |  | one feed check every 2 hours, only with Check automatically on | `this.everyTimer = setInterval(() => void this.check(false), CHECK_EVERY_MS);` |
| 155 | loop | NOT-WORTH |  | a few stale files, once at start | `for (const name of staleFiles(this.p.fs.readdir(dir), basename(running), this.p.version)) {` |

#### electron/main/updatePrefs.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 22 | sync | NOT-WORTH | main-blocking | reads the update prefs (a few bytes) once at start | `saved = JSON.parse(readFileSync(file, "utf8")) as Partial<UpdatePrefs>;` |
| 35 | sync | NOT-WORTH | main-blocking | one mkdir per prefs save (a user action) | `mkdirSync(dirname(file), { recursive: true });` |
| 38 | sync | NOT-WORTH | main-blocking | writes the prefs file per save | `writeFileSync(tmp, JSON.stringify(prefs, null, 2) + "\n");` |
| 40 | sync | NOT-WORTH | main-blocking | one rename per save | `renameSync(tmp, file);` |

#### electron/main/updater.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 34 | sync | NOT-WORTH | main-blocking | one realpath, once per start (the running AppImage) | `return realpathSync(raw);` |
| 43 | sync | NOT-WORTH | main-blocking | the update folder's few files, once per update action | `readdir: (dir) => readdirSync(dir),` |
| 45 | sync | NOT-WORTH | main-blocking | one unlink per stale AppImage, once per update action | `rm: (path) => rmSync(path, { force: true }),` |
| 47 | sync | NOT-WORTH | main-blocking | one chmod per downloaded AppImage | `chmod: (path, mode) => chmodSync(path, mode),` |
| 49 | sync | NOT-WORTH | main-blocking | one rename per downloaded AppImage | `rename: (from, to) => renameSync(from, to),` |
| 51 | sync | NOT-WORTH | main-blocking | one stat per update step | `exists: (path) => existsSync(path),` |
| 54 | sync | NOT-WORTH | main-blocking | one lstat per update step | `const st = lstatSync(path, { throwIfNoEntry: false });` |
| 58 | sync | NOT-WORTH | main-blocking | one symlink per install | `symlink: (target, path) => symlinkSync(target, path),` |
| 76 | loop | SERIAL-REQUIRED | main-blocking | retry: the second form only when systemd refused the first (2 tries) | `for (const exitTypeCgroup of [true, false]) {` |
| 82 | wait | SERIAL-REQUIRED |  | systemd-run for the relaunch, 5 s timeout, at most two tries (with and without ExitType=cgroup), once per restart | `execFileSync("systemd-run", systemdRunArgs({ target, args, env, unit, exitTypeCgroup, oldPid: process.pid, she` |
| 101 | timer | SERIAL-REQUIRED |  | the exit fallback 10 s after a relaunch was handed off, once | `setTimeout(() => app.exit(0), 10_000).unref();` |
| 107 | wait | NOT-WORTH | no-timeout | the fetch the feed reader is given; every caller passes an AbortSignal.timeout [bounded: FEED_TIMEOUT_MS at the call site] | `const fetchFn: FetchFn = (url, init) => net.fetch(url, init);` |
| 118 | wait | NOT-WORTH |  | one feed read per update check, FEED_TIMEOUT_MS | `const r = await net.fetch(url, { headers, signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });` |

#### electron/main/validate.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 23 | iter | NOT-WORTH |  | the dropped paths, once per drop | `export const pathsArg = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p ==` |
| 39 | iter | NOT-WORTH |  | ≤ four output names | `const outputs = Array.isArray(o.outputs) ? OUTPUT_NAMES.filter((n) => (o.outputs as unknown[]).includes(n)) : ` |
| 76 | iter | NOT-WORTH |  | the queue's jobs, once per candidate folder of an added clip | `jobs.some((j) => j.outputDir === dir && j.clip.path !== clipPath);` |
| 79 | loop | NOT-WORTH |  | one step per same-named clip already queued [bounded: the queue's length] | `for (let n = 2; taken(dir); n++) dir = '${wanted}-${n}';` |

#### engine-rs/crates/ck-core/src/ahead.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 38 | thread | SERIAL-REQUIRED |  | the callers' threads, each with its own verdict | `std::thread::Builder::new().name(name.to_string()).spawn(f).map_err(\|e\| Error::engine(format!("couldn't start ` |
| 45 | wait | SERIAL-REQUIRED | no-timeout | joins a thread whose channel has closed [bounded: the thread has ended or is ending] | `handle.join().map_err(\|p\| Error::engine(format!("the {name} thread panicked: {}", crate::panic_message(&*p))))` |
| 55 | thread | SERIAL-REQUIRED |  | one producer thread per sequence; it ends at the sequence's end, an error, or a dropped consumer | `let producer = spawn_named(name, move \|\| {` |
| 57 | loop | SERIAL-REQUIRED |  | items in order; ends at the producer's end, an error, or a dropped consumer | `loop {` |
| 78 | wait | SERIAL-REQUIRED | no-timeout | the consumer takes items in order [bounded: the producer ends at its sequence's end or first error, which closes the channel] | `match self.rx.recv() {` |
| 84 | wait | SERIAL-REQUIRED | no-timeout | joins the producer once its channel closed [bounded: it has returned or unwound] | `Some(h) => joined(h).map(\|_\| None),` |

#### engine-rs/crates/ck-core/src/clip.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 99 | loop+iter | exempt |  |  | `for c in path.split('/') {` |
| 123 | loop | NOT-WORTH |  | one pass over two file names, per comparison of a sort | `while let (Some(&ca), Some(&cb)) = (x.first(), y.first()) {` |
| 126 | iter | NOT-WORTH | nested, pixel | a digit run's length, per comparison | `let na = x.iter().take_while(\|c\| c.is_ascii_digit()).count();` |
| 128 | iter | NOT-WORTH | nested, pixel | as above | `let nb = y.iter().take_while(\|c\| c.is_ascii_digit()).count();` |
| 149 | iter | exempt |  |  | `let i = d.iter().position(\|&c\| c != b'0').unwrap_or(d.len());` |
| 159 | loop | HOT-PATH-OK | alloc | one pass over the folder's entries | `for e in rd.flatten() {` |
| 164 | iter | NOT-WORTH | nested | four extensions per file name, once per probe | `let ok = [".exr", ".png", ".jpg", ".jpeg"].iter().any(\|x\| lower.ends_with(x) && name.len() > x.len() && !name.` |
| 172 | iter | NOT-WORTH | alloc | the folder's file names, once per probe | `Ok(out.into_iter().map(PathBuf::from).collect())` |
| 228 | iter | exempt |  |  | `.and_then(\|l\| l.iter().find_map(\|d\| d.get("rotation").map(num)))` |
| 251 | wait | SERIAL-REQUIRED |  | one ffprobe per clip, PROBE_TIMEOUT 120 s | `let out = crate::proc::output_timeout(&mut cmd, PROBE_TIMEOUT).map_err(\|e\| {` |
| 281 | wait | SERIAL-REQUIRED |  | one ffprobe per clip without a frame count, PROBE_TIMEOUT 120 s | `let out = crate::proc::output_timeout(&mut cmd, PROBE_TIMEOUT).map_err(\|e\| Error::input(format!("ffprobe on {}` |

#### engine-rs/crates/ck-core/src/color.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 165 | loop | exempt |  |  | `for v in [0.0f32, -0.5, 1.0, 40.0, 70000.0, 1e20] {` |

#### engine-rs/crates/ck-core/src/config.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 109 | iter | NOT-WORTH | alloc | the command line, once per process | `args.iter().position(\|a\| a == name).and_then(\|i\| args.get(i + 1).cloned()).or_else(\|\| {` |
| 112 | iter | NOT-WORTH | alloc, nested | the command line, once per process | `args.iter().find_map(\|a\| a.strip_prefix(&p).map(\|s\| s.to_string()))` |
| 120 | iter | NOT-WORTH | alloc | a few choices, once per process | `choices.iter().find(\|(k, _)\| *k == low).map(\|(_, t)\| *t).ok_or_else(\|\| {` |
| 122 | iter | NOT-WORTH | alloc, nested | the choices for the message | `let names: Vec<&str> = choices.iter().map(\|(k, _)\| *k).collect();` |
| 167 | iter | NOT-WORTH | alloc | a short list of network names, once per process | `let names: Vec<String> = list.split(',').map(\|p\| p.trim().to_string()).filter(\|p\| !p.is_empty()).collect();` |
| 169 | iter | NOT-WORTH | alloc | as above | `if let Some(bad) = names.iter().find(\|n\| !PIECES.contains(&n.as_str())) {` |

#### engine-rs/crates/ck-core/src/decode.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 51 | loop | HOT-PATH-OK | alloc | read() fills the frame in a few large pieces | `while got < self.buf.len() {` |
| 68 | wait | NOT-WORTH | no-timeout | reaps the decoder after kill() [bounded: a killed child exits] | `let _ = self.child.wait();` |
| 80 | iter | HOT-PATH-OK |  | one pass per decoded frame (~1.4 M pixels), rows in parallel | `r.par_chunks_mut(w).zip(g.par_chunks_mut(w)).zip(b.par_chunks_mut(w)).zip(rgb.par_chunks(w * 3)).with_min_len(` |
| 83 | loop+iter | HOT-PATH-OK | nested, pixel | one row of pixels | `for (x, px) in src.chunks_exact(3).enumerate() {` |
| 122 | iter | exempt |  |  | `TURBOJPEG_LIBS.iter().find_map(\|n\| {` |
| 152 | iter | exempt |  |  | `maps.lines().filter_map(\|l\| l.split_whitespace().nth(5)).find(\|p\| p.contains(part)).map(str::to_string)` |
| 165 | wait | NOT-WORTH |  | one `-version` run, 30 s deadline | `let out = crate::proc::output_timeout(std::process::Command::new(bin).arg("-version"), std::time::Duration::fr` |
| 172 | iter | exempt |  |  | `let mut words = text.lines().next()?.split_whitespace();` |
| 284 | iter | exempt |  |  | `let has = \|hd: &exr::meta::header::Header, c: &str\| hd.channels.list.iter().any(\|ch\| ch.name.eq_case_insensiti` |
| 288 | iter | NOT-WORTH | alloc | a few layers, once per clip | `.iter()` |
| 304 | loop | HOT-PATH-OK |  | one pass per frame over its pixels | `for i in 0..n {` |
| 351 | iter | HOT-PATH-OK | alloc | one pass per frame, parallel; the frame's display view (bf16) is the output, one allocation per frame | `let display: Vec<half::bf16> = padded.data.par_iter().with_min_len(1 << 14).map(\|&v\| half::bf16::from_f32(disp` |
| 356 | iter | HOT-PATH-OK | alloc | one pass per frame, parallel; the model view (bf16) is the output, one allocation per frame | `.par_iter()` |
| 442 | iter | PARALLELIZE | alloc | FOLDER_BATCH frames decode at once on the pool; collected in order | `.par_iter()` |
| 540 | iter | HOT-PATH-OK | alloc | per hint frame (float EXR hints only), one pass; hints are optional | `(0..h * w).map(\|i\| if ch >= 3 { data[i * ch + 2] * 0.114 + data[i * ch + 1] * 0.587 + data[i * ch] * 0.299 } e` |
| 558 | iter | exempt |  |  | `crate::clip::frame_paths(path)?.into_iter().find(\|p\| p.is_file())` |
| 576 | iter | NOT-WORTH | alloc | the first-frame hint: one image per job | `Still::U8 { ch, h, w, data } => (h, w, (0..h * w).map(\|i\| data[i * ch + pick(ch)] as f32 / 255.0).collect()),` |
| 578 | iter | NOT-WORTH | alloc | the first-frame hint: one image per job | `Still::U16 { ch, h, w, data } => (h, w, (0..h * w).map(\|i\| data[i * ch + pick(ch)] as f32 / 65535.0).collect()` |
| 580 | iter | NOT-WORTH | alloc | the first-frame hint: one image per job | `Still::F32 { ch, h, w, data } => (h, w, (0..h * w).map(\|i\| data[i * ch + pick(ch)]).collect()),` |

#### engine-rs/crates/ck-core/src/gpu.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 80 | iter | NOT-WORTH | alloc | the first entry of one environment variable | `Some(v) => v.split(',').next().unwrap_or("").trim().to_string(),` |
| 89 | iter | exempt |  |  | `let by_uuid = c.uuid.as_ref().and_then(\|u\| cards.iter().find(\|k\| k.uuid.eq_ignore_ascii_case(u)));` |
| 91 | iter | exempt |  |  | `let by_pci = key.and_then(\|k\| cards.iter().find(\|card\| pci_key(&card.pci) == Some(k)));` |
| 99 | iter | NOT-WORTH | alloc | the machine's few cards, once per NVML open | `let hits: Vec<&Card> = cards.iter().filter(\|k\| k.uuid.to_ascii_lowercase().starts_with(&want)).collect();` |
| 104 | iter | NOT-WORTH | alloc | the machine's few cards | `let mut by_pci: Vec<&Card> = cards.iter().collect();` |
| 118 | iter | NOT-WORTH | alloc | 16 bytes | `let h: String = b.iter().map(\|x\| format!("{x:02x}")).collect();` |
| 271 | loop | NOT-WORTH | alloc | the machine's few cards, once per NVML open | `for index in 0..n.min(64) {` |
| 322 | iter | NOT-WORTH | alloc | ≤ 128 compute processes, once per budget read (job start, first session) | `let mine: Vec<u64> = buf[..(n as usize).min(buf.len())].iter().filter(\|p\| p.pid == pid).map(\|p\| p.used).collec` |
| 326 | iter | exempt |  |  | `Some(mine.iter().sum())` |
| 365 | loop | exempt |  |  | `for name in NVINFER_LIBS {` |
| 409 | iter | exempt |  |  | `s.lines().find_map(\|l\| l.strip_prefix("MemAvailable:")).and_then(\|r\| r.trim().trim_end_matches("kB").trim().pa` |

#### engine-rs/crates/ck-core/src/hann.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 12 | iter | NOT-WORTH | alloc | window starts, once per job (≤ a few hundred) | `let mut starts: Vec<usize> = (0..=t_all - chunk).step_by(stride.max(1)).collect();` |
| 29 | iter | NOT-WORTH | alloc | ≤ 40 ramp weights, once per window | `let ramp: Vec<f32> = (0..n).map(\|k\| 0.5 * (1.0 - (pi * (k as f32 + 1.0) / (overlap as f32 + 1.0)).cos())).coll` |
| 34 | iter | exempt |  |  | `w[tc - n..].iter_mut().zip(ramp.iter().rev()).for_each(\|(d, &r)\| *d = r);` |
| 54 | iter | HOT-PATH-OK |  | one baton frame (2.9 M values at 1152x1280), parallel; reads stage 1's float16 directly | `sum.par_iter_mut().zip(baton.par_iter()).with_min_len(1 << 14).for_each(\|(s, b)\| *s += b.to_f32() * w);` |
| 59 | iter | HOT-PATH-OK | alloc | first window covering a frame: its weighted baton is the accumulator (one allocation per frame, kept until the frame is final) | `self.acc.insert(t, (baton.par_iter().with_min_len(1 << 14).map(\|b\| b.to_f32() * w).collect(), w as f64));` |
| 68 | iter | HOT-PATH-OK | alloc | the frames a window finishes (≤ stride); each frame's values in parallel | `keys.into_iter()` |
| 74 | iter | HOT-PATH-OK | alloc, nested | frames a window finishes (≤ stride), each frame parallel; output float16 | `(k, sum.into_par_iter().with_min_len(1 << 14).map(\|v\| half::f16::from_f32(v / d)).collect())` |

#### engine-rs/crates/ck-core/src/image.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 36 | iter | HOT-PATH-OK |  | one pass over a small image (RVM input, carry hint, hint); clamp / round | `self.data.iter_mut().for_each(\|v\| *v = f(*v));` |
| 68 | loop | HOT-PATH-OK |  | one or two steps unless the pad is wider than the image | `while p < 0 \|\| p >= n {` |
| 88 | iter | NOT-WORTH | alloc | the column table, once per padded frame (≤ 4096 entries) | `let xs: Vec<usize> = (0..wo).map(\|x\| reflect101(x as isize - pad.l as isize, img.w)).collect();` |
| 92 | loop | HOT-PATH-OK |  | once per frame and plane (3); the rows of a plane in parallel | `for c in 0..img.c {` |
| 96 | iter | HOT-PATH-OK | nested | rows of one plane in parallel; a gather over the column table | `dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).enumerate().for_each(\|(y, drow)\| {` |
| 100 | iter | HOT-PATH-OK | nested | one row's gather (≤ 4096) | `drow.iter_mut().zip(&xs).for_each(\|(d, &sx)\| *d = srow[sx]);` |
| 112 | loop | HOT-PATH-OK |  | once per output frame and plane | `for c in 0..img.c {` |
| 116 | loop | HOT-PATH-OK | nested | row copies | `for y in 0..h {` |
| 136 | iter | NOT-WORTH | alloc | the row table, once per resize (≤ 960 entries) | `let ys: Vec<(usize, usize)> = (0..ho).map(\|o\| adaptive_range(o, ho, img.h)).collect();` |
| 138 | iter | NOT-WORTH | alloc | the column table, once per resize (≤ 960 entries) | `let xs: Vec<(usize, usize)> = (0..wo).map(\|o\| adaptive_range(o, wo, img.w)).collect();` |
| 141 | loop | HOT-PATH-OK |  | per frame and plane (3); the output rows of a plane in parallel | `for c in 0..img.c {` |
| 145 | iter | HOT-PATH-OK | nested | output rows in parallel | `dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).zip(ys.par_iter()).for_each(\|(drow, &(y0, y1))\| {` |
| 147 | loop+iter | HOT-PATH-OK | nested | output columns of one row (wo ≤ 960) | `for (ox, &(x0, x1)) in xs.iter().enumerate() {` |
| 150 | loop | HOT-PATH-OK | nested | the cell's rows (4 for C-RADIO, ~5 for MoGe) | `for y in y0..y1 {` |
| 152 | iter | HOT-PATH-OK | nested | one cell row (4-5 values) | `sum += src[y * img.w + x0..y * img.w + x1].iter().fold(0.0f32, \|a, &v\| a + v);` |
| 188 | loop | HOT-PATH-OK |  | per frame and plane (3, or 1 for a carry hint); the output rows in parallel | `for c in 0..img.c {` |
| 192 | iter | HOT-PATH-OK | nested | output rows in parallel | `dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).zip(ys.par_iter()).for_each(\|(drow, &(y0, y1, wy0, wy1))\| {` |
| 196 | iter | HOT-PATH-OK | nested | one output row (≤ 2176) | `drow.iter_mut().zip(&xs).for_each(\|(d, &(x0, x1, wx0, wx1))\| {` |
| 216 | loop | exempt |  |  | `for i in 0..8 {` |
| 223 | iter | exempt |  |  | `c.iter_mut().for_each(\|v\| *v = (*v as f64 * inv) as f32);` |
| 250 | loop | HOT-PATH-OK |  | per hint frame and plane | `for c in 0..img.c {` |
| 253 | loop | HOT-PATH-OK | nested | horizontal pass over the source rows | `for y in 0..img.h {` |
| 256 | loop+iter | HOT-PATH-OK | nested | output columns | `for (ox, (s, k)) in xs.iter().enumerate() {` |
| 259 | loop+iter | NOT-WORTH | nested | eight taps | `for (j, kj) in k.iter().enumerate() {` |
| 267 | loop+iter | HOT-PATH-OK | nested | vertical pass, output rows | `for (oy, (s, k)) in ys.iter().enumerate() {` |
| 269 | loop | HOT-PATH-OK | nested | output columns | `for ox in 0..wo {` |
| 272 | loop+iter | NOT-WORTH | nested | eight taps | `for (j, kj) in k.iter().enumerate() {` |

#### engine-rs/crates/ck-core/src/job.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 122 | iter | NOT-WORTH | alloc | fifteen pixel formats, once per job | `let Some(&(_, depth)) = X264_PIX_FMTS.iter().find(\|(f, _)\| *f == w.pix_fmt) else {` |
| 124 | iter | NOT-WORTH | alloc, nested | fifteen names for the message | `let names: Vec<&str> = X264_PIX_FMTS.iter().map(\|(f, _)\| *f).collect();` |
| 149 | iter | NOT-WORTH | alloc | ≤ four output names, once per job | `Some(Value::Array(a)) if !a.is_empty() => a.iter().map(\|v\| v.as_str().map(\|x\| x.to_string()).unwrap_or_else(\|\|` |
| 155 | iter | NOT-WORTH | alloc | ≤ four output names, once per job | `let bad: Vec<&String> = outputs.iter().filter(\|x\| !crate::render::OUTPUTS.contains(&x.as_str())).collect();` |

#### engine-rs/crates/ck-core/src/lib.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 119 | iter | exempt |  |  | `OOM_MESSAGES.iter().any(\|k\| low.contains(k))` |
| 156 | iter | exempt |  |  | `s.lines().next().unwrap_or(s)` |

#### engine-rs/crates/ck-core/src/outputs.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 50 | thread | SERIAL-REQUIRED |  | the render thread: frames to the writers in order; ends when the sender is dropped or a writer fails | `let handle = crate::ahead::spawn_named("render", move \|\| {` |
| 54 | loop | SERIAL-REQUIRED | alloc | frames reach the writers in order; ends when the sender is dropped | `for logits in rx {` |
| 67 | loop | NOT-WORTH | alloc, nested | at most four outputs | `for (name, batch) in rendered {` |
| 69 | iter | NOT-WORTH | alloc, nested | ≤ four writers per rendered output | `let r = match writers.iter().position(\|(n, _)\| n == name) {` |
| 83 | iter | NOT-WORTH | nested | ≤ four writers per frame | `let n = writers.iter().map(\|(_, w)\| w.frames()).min().unwrap_or(0);` |
| 97 | wait | SERIAL-REQUIRED | no-timeout | the render thread already stopped (its channel closed) [bounded: it has ended or is ending] | `_ => Err(self.join().err().unwrap_or_else(\|\| Error::engine("the render thread stopped".into()))),` |
| 114 | wait | SERIAL-REQUIRED | no-timeout | waits for the queued frames (≤ QUEUE = 2) to be rendered and handed off [bounded: the sender is dropped first, so the thread ends after them] | `self.join()` |
| 123 | wait | SERIAL-REQUIRED | no-timeout | joins the render thread after dropping its sender [bounded: ≤ 2 queued frames, then the thread ends] | `let (writers, res, secs) = crate::ahead::joined(h)?;` |
| 132 | wait | NOT-WORTH | no-timeout | drop path: the same join [bounded: the sender is dropped first] | `let _ = self.join();` |

#### engine-rs/crates/ck-core/src/pipeline/frames.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 41 | loop | SERIAL-REQUIRED | alloc | frames decode in order | `while self.next < t1 {` |
| 47 | iter | HOT-PATH-OK | alloc | a window's frames (≤ 80): Arc clones, no pixel copies | `let out = (t0..t1).map(\|t\| self.cache[&t].clone()).collect();` |
| 66 | loop | SERIAL-REQUIRED | alloc | hint frames decode in order | `while self.next < t1 {` |
| 72 | iter | HOT-PATH-OK | alloc | a window's hint frames (≤ 80): Arc clones | `let out = (t0..t1).map(\|t\| self.cache[&t].clone()).collect();` |

#### engine-rs/crates/ck-core/src/pipeline/keying.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 168 | iter | exempt |  |  | `alpha: job.outputs.iter().any(\|o\| o == "alpha"),` |
| 169 | iter | exempt |  |  | `fg: job.outputs.iter().any(\|o\| o == "fg"),` |
| 170 | iter | exempt |  |  | `checker: job.outputs.iter().any(\|o\| o == "checker"),` |
| 171 | iter | exempt |  |  | `cutout: job.outputs.iter().any(\|o\| o == "cutout"),` |
| 241 | loop | SERIAL-REQUIRED | alloc | RVM is recurrent: each frame's step takes the previous state | `while let Some(small) = small_frames.next_item()? {` |
| 244 | iter | NOT-WORTH | nested | two outputs per RVM step | `let mut it = outs.into_iter();` |
| 265 | iter | NOT-WORTH | alloc | five networks, once per TensorRT job | `let pieces: BTreeMap<&str, &str> = self.nets.iter().map(\|(k, n)\| (*k, n.provider().name())).collect();` |
| 267 | iter | NOT-WORTH | alloc | five networks, once per TensorRT job | `let built: BTreeMap<&str, f64> = self.trt_seconds.iter().filter(\|(_, v)\| v.1).map(\|(k, v)\| (*k, v.0)).collect(` |
| 296 | loop | NOT-WORTH |  | up to four frames | `while frames.len() < fchunk && done_frames < t_all {` |
| 308 | loop | SERIAL-REQUIRED |  | chunks of 4 frames, in order | `while let Some((n, (radio, moge))) = chunks.next_item()? {` |
| 394 | loop+iter | SERIAL-REQUIRED | alloc | windows run in order: each one's carry hint feeds the next | `for (i, &t0) in starts.iter().enumerate() {` |
| 406 | loop+iter | NOT-WORTH | nested | the window's frames (≤ 80): slice references | `for (j, m) in hv.iter().enumerate() {` |
| 410 | iter | NOT-WORTH | nested | the window's hint qualities (≤ 80) | `hq.iter_mut().for_each(\|q\| *q = hq_full);` |
| 413 | loop | NOT-WORTH | nested | the window's frames (≤ 80): slice references | `for (j, t) in (t0..t1).enumerate() {` |
| 426 | iter | NOT-WORTH | alloc, nested | the window's flags (≤ 80) | `let hint = if src.iter().all(\|s\| s.is_none()) {` |
| 428 | iter | NOT-WORTH | nested | the window's hint qualities (≤ 80) | `hq.iter_mut().for_each(\|q\| *q = -1.0);` |
| 442 | loop | HOT-PATH-OK | alloc, nested | the window's frames | `for (j, t) in (t0..t1).enumerate() {` |
| 452 | iter | HOT-PATH-OK | alloc, nested | the window's frames (≤ 80): moves the model views out, the display views are dropped before the run | `let models: Vec<Arc<Vec<half::bf16>>> = frames.into_iter().map(\|f\| f.model).collect();` |
| 460 | iter | HOT-PATH-OK | alloc, nested | ≤ 80 slice references; converted once inside the run | `("rgb", vec![1, tc, 3, sh, sw], Data::Bf16(models.iter().map(\|m\| &m[..]).collect())),` |
| 470 | iter | NOT-WORTH | nested | two outputs per window | `let mut it = outs.into_iter();` |
| 484 | iter | HOT-PATH-OK | alloc, nested | carry hints: only the frames the next window takes (≤ stride), in parallel, each a small upsample | `.into_par_iter()` |
| 498 | loop | HOT-PATH-OK | nested | the window's frames; each frame's values blended in parallel, read in stage 1's type | `for (j, t) in (t0..t1).enumerate() {` |
| 544 | thread | SERIAL-REQUIRED |  | the low-VRAM stage-2 producer: frames in order; ends at the clip's end, an error, or a dropped receiver | `let producer = crate::ahead::spawn_named("s2-inputs", move \|\| {` |
| 547 | loop | SERIAL-REQUIRED | alloc | frames in order; ends at the clip's end, an error, or a dropped receiver | `for t in 0..t_all {` |
| 564 | loop | SERIAL-REQUIRED |  | frames in order to the writers | `for _ in 0..t_all {` |
| 567 | wait | SERIAL-REQUIRED | no-timeout | stage 2's next input, in order [bounded: the producer sends every frame or its error, then ends] | `let item = irx.recv().map_err(\|_\| Error::engine("the stage-2 input thread stopped".into())).and_then(\|r\| r);` |
| 576 | wait | SERIAL-REQUIRED | no-timeout | joins the producer after the receiver is dropped [bounded: its next send fails and it ends] | `let (dec_s, prep_s) = crate::ahead::joined(producer)?;` |
| 588 | iter | NOT-WORTH | alloc | five networks, once per job (the timing line) | `let each: Vec<String> = self.load_each.iter().map(\|(p, s)\| format!("{p} {s:.2}")).collect();` |
| 594 | loop | NOT-WORTH | alloc | five networks | `for p in crate::runtime::PIECES {` |
| 606 | iter | NOT-WORTH | alloc | ≤ four phases, once per job | `let ph: Vec<String> = times.phases.iter().map(\|(n, s)\| format!("{n} {s:.1} s")).collect();` |
| 617 | iter | NOT-WORTH | alloc | one output per C-RADIO call | `self.net("cradio")?.run(vec![("rgb", vec![n, 3, hr, wr], radio.into())])?.into_iter().next().ok_or_else(\|\| Err` |
| 620 | iter | NOT-WORTH | alloc | one output per MoGe call | `self.net("moge")?.run(vec![("rgb", vec![n, 3, hm, wm], moge.into())])?.into_iter().next().ok_or_else(\|\| Error:` |
| 638 | loop | SERIAL-REQUIRED | alloc | frames go to the writers in order | `for (t, b) in ready {` |
| 656 | iter | exempt |  |  | `let (_, logits) = outs.into_iter().next().ok_or_else(\|\| Error::engine("stage2: no logits".into()))?;` |
| 675 | iter | HOT-PATH-OK |  | one frame's display view to float32 (RVM / foundation inputs), parallel | `out[start..].par_iter_mut().with_min_len(1 << 14).zip(v.par_iter()).for_each(\|(o, x)\| *o = x.to_f32());` |
| 685 | loop+iter | HOT-PATH-OK |  | the window's frames (≤ 80); each matte converted once, in parallel | `for (dst, s) in out.chunks_mut(plane).zip(src) {` |
| 688 | iter | HOT-PATH-OK | nested | one frame's matte into the tensor, parallel | `dst.par_iter_mut().with_min_len(1 << 14).zip(s.par_iter()).for_each(\|(d, &v)\| *d = conv(v));` |
| 702 | loop | HOT-PATH-OK | alloc | the window's frames | `for f in frames {` |

#### engine-rs/crates/ck-core/src/pipeline/mod.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 56 | iter | exempt |  |  | `let done = writers.iter().map(\|(_, w)\| w.frames()).min().unwrap_or(0);` |
| 183 | loop+iter | exempt |  |  | `for (p, n) in self.nets.iter_mut() {` |
| 212 | iter | NOT-WORTH | alloc | ≤ five networks per phase | `let need: Vec<&'static str> = pieces.iter().copied().filter(\|p\| !self.nets.contains_key(p)).collect();` |
| 218 | loop | NOT-WORTH | alloc | at most five networks | `for piece in need {` |
| 220 | iter | NOT-WORTH | nested | ≤ two pending loads | `if let Some(i) = self.pending.iter().position(\|(p, k, _)\| *p == piece && k == key) {` |
| 225 | wait | SERIAL-REQUIRED | no-timeout | takes a network loaded ahead; waits only for the part not yet done [bounded: ORT session creation ends (succeeds or fails)] | `let (net, secs) = crate::ahead::joined(h)??;` |
| 249 | iter | NOT-WORTH | alloc, nested | first line of an error message | `.map_err(\|e\| format!("loading its engine: {}", e.message.lines().next().unwrap_or("")))` |
| 305 | loop | NOT-WORTH | alloc | at most two networks | `for &piece in pieces {` |
| 307 | iter | NOT-WORTH | nested | ≤ two pending loads | `if self.nets.contains_key(piece) \|\| self.pending.iter().any(\|(p, k, _)\| *p == piece && k == key) {` |
| 314 | thread | PARALLELIZE |  | the next low-VRAM phase's network loads while this phase runs (measured: 1.3-1.5 s less per job) | `let started = crate::ahead::spawn_named(&format!("load-{piece}"), move \|\| {` |
| 339 | loop | exempt |  |  | `for (_, _, h) in self.pending.drain(..) {` |
| 341 | wait | NOT-WORTH | no-timeout | joins loads that were started ahead [bounded: ORT session creation ends] | `let _ = h.join();` |
| 349 | loop+iter | exempt |  |  | `for (p, n) in self.nets.iter_mut() {` |
| 362 | iter | exempt |  |  | `.iter()` |
| 391 | loop | SERIAL-REQUIRED | retry, alloc | one attempt at a time [bounded: the window halves each round, and only while nothing was written: ≤ log2(80) ≈ 7 rounds] | `loop {` |
| 394 | iter | NOT-WORTH | nested | ≤ four writers, once per attempt | `let nothing_written = writers.iter().all(\|(_, w)\| w.frames() == 0);` |
| 570 | loop | NOT-WORTH | alloc | at most four outputs | `for name in &job.outputs {` |
| 629 | loop+iter | exempt |  |  | `for (_, wr) in writers.iter_mut() {` |
| 650 | iter | NOT-WORTH | alloc | ≤ four outputs, once per job | `outputs: writers.iter().map(\|(_, w)\| w.path().to_string_lossy().into_owned()).collect(),` |
| 693 | iter | NOT-WORTH | alloc | five networks, once per TensorRT job | `let ready: Vec<&str> = crate::runtime::PIECES.iter().copied().filter(\|p\| self.models.trt_file(p, trt_prec).is_` |
| 704 | iter | NOT-WORTH | alloc | a few stale cache folders, once per TensorRT job | `let names: Vec<String> = stale.iter().filter_map(\|p\| p.file_name().map(\|n\| n.to_string_lossy().into_owned())).` |
| 707 | loop | exempt |  |  | `for s in &stale {` |
| 712 | iter | exempt |  |  | `let built = ready.iter().all(\|p\| {` |
| 746 | iter | NOT-WORTH | alloc | five networks, once per TensorRT job | `.iter()` |
| 774 | loop+iter | NOT-WORTH | alloc | five networks | `for (i, piece) in crate::runtime::PIECES.iter().copied().enumerate() {` |
| 794 | iter | NOT-WORTH | nested | five names | `let n = todo.iter().position(\|p\| *p == piece).map(\|k\| k + 1).unwrap_or(i + 1);` |

#### engine-rs/crates/ck-core/src/pipeline/temps.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 36 | iter | exempt |  |  | `self.0.iter().for_each(\|p\| {` |
| 73 | wait | HOT-PATH-OK | no-timeout | one RVM window or baton frame from the local temp file, read straight into float16 [bounded: a local file read] | `self.f.seek(SeekFrom::Start((t0 * self.frame * 2) as u64)).and_then(\|_\| self.f.read_exact(bytemuck::cast_slice` |
| 113 | wait | HOT-PATH-OK | no-timeout | one window's foundation features from the local temp file, in their own type (float16 here) [bounded: a local file read] | `self.f.read_exact(bytemuck::cast_slice_mut(&mut out)).map_err(temp_err)?;` |
| 118 | wait | HOT-PATH-OK | no-timeout | the float32 (CPU / fp32) case of the same read [bounded: a local file read] | `self.f.read_exact(bytemuck::cast_slice_mut(&mut out)).map_err(temp_err)?;` |

#### engine-rs/crates/ck-core/src/proc.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 15 | loop | SERIAL-REQUIRED |  | one child; a poll every POLL ms [bounded: the deadline, then kill] | `loop {` |
| 22 | wait | NOT-WORTH | no-timeout | reaps the child after kill() [bounded: a killed child exits] | `let _ = child.wait();` |
| 26 | timer | SERIAL-REQUIRED |  | the deadline poll's 50 ms sleep (not a spin) | `std::thread::sleep(POLL);` |
| 36 | thread | SERIAL-REQUIRED |  | one reader per pipe, so a full pipe can't stall the child; ends at the pipe's end | `std::thread::spawn(move \|\| {` |
| 40 | wait | SERIAL-REQUIRED | no-timeout | reads one pipe to its end [bounded: the pipe closes when the child exits or is killed at the deadline] | `let _ = r.read_to_end(&mut buf);` |
| 48 | wait | SERIAL-REQUIRED |  | the deadline wait itself | `let status = wait_timeout(&mut child, timeout).map_err(\|e\| e.to_string())?;` |
| 51 | wait | SERIAL-REQUIRED | no-timeout | joins the two pipe readers [bounded: the child has exited or was killed, so both pipes are closed] | `let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());` |
| 125 | thread | SERIAL-REQUIRED |  | the parent watch: one check a second for the engine's whole life [bounded: exits when the parent is gone] | `std::thread::spawn(move \|\| loop {` |
| 131 | timer | SERIAL-REQUIRED |  | the watch's one-second sleep (not a spin) | `std::thread::sleep(Duration::from_secs(1));` |
| 218 | thread | SERIAL-REQUIRED |  | waits on the app's process handle for the engine's whole life [bounded: returns when the app ends] | `std::thread::spawn(move \|\| {` |

#### engine-rs/crates/ck-core/src/render.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 25 | loop | HOT-PATH-OK |  | once per job | `for y in 0..h {` |
| 27 | loop | HOT-PATH-OK | nested, pixel | one row | `for x in 0..w {` |
| 54 | iter | NOT-WORTH | alloc | four outputs per frame | `OUTPUTS.iter().zip(bufs).zip(on).filter(\|(_, on)\| *on).map(\|((n, b), _)\| (*n, Batch::F32(b))).collect()` |
| 60 | iter | NOT-WORTH | alloc | four outputs per frame | `OUTPUTS.iter().zip(bufs).zip(on).filter(\|(_, on)\| *on).map(\|((n, b), _)\| (*n, Batch::U16(b))).collect()` |
| 71 | iter | HOT-PATH-OK | alloc | one small array per output row (h ≤ 2160), per frame; the pixels go straight into the outputs | `let mut rows: Vec<Row<'_, T>> = (0..h).map(\|_\| [None, None, None, None]).collect();` |
| 73 | loop+iter | HOT-PATH-OK |  | four outputs; each split into its h row slices (pointer work, no copies) | `for (i, b) in bufs.iter_mut().enumerate() {` |
| 78 | loop+iter | HOT-PATH-OK | nested | one slice per output row (h ≤ 2160) | `for (y, chunk) in b.chunks_mut(w * ch[i]).enumerate() {` |
| 83 | iter | HOT-PATH-OK |  | output rows in parallel, per frame | `rows.into_par_iter().enumerate().for_each(\|(y, r)\| f(y, r));` |
| 105 | loop | HOT-PATH-OK |  | one output row | `for x in 0..w {` |
| 150 | loop | HOT-PATH-OK |  | one output row | `for x in 0..w {` |

#### engine-rs/crates/ck-core/src/runtime.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 77 | iter | exempt |  |  | `[file.to_path_buf(), data].iter().filter_map(\|p\| std::fs::metadata(p).ok()).map(\|m\| m.len()).sum()` |
| 107 | iter | exempt |  |  | `default_names(piece, p).into_iter().map(\|n\| self.dir.join(n)).find(\|f\| f.exists())` |
| 132 | iter | NOT-WORTH | alloc | five networks, once per ping | `PIECES.iter().map(\|k\| (k.to_string(), self.file(k, p).is_some())).collect()` |
| 137 | iter | NOT-WORTH | alloc | five networks, once per job | `PIECES.iter().filter(\|k\| self.file(k, p).is_none()).map(\|k\| k.to_string()).collect()` |
| 144 | iter | NOT-WORTH | alloc | a short build-info string, once per process | `info.split(\|c: char\| c == ',' \|\| c.is_whitespace()).find_map(\|t\| t.strip_prefix("git-branch=rel-")).unwrap_or(` |
| 367 | iter | exempt |  |  | `ArenaShrink::List(list) => list.iter().any(\|p\| p == piece),` |
| 406 | iter | exempt |  |  | `Data::Bf16(parts) => parts.iter().map(\|p\| p.len()).sum(),` |
| 418 | iter | HOT-PATH-OK | alloc | float16 -> float32 where a graph takes float32 (the CPU / fp32 path), one parallel pass | `Data::F16(v) => v.par_iter().with_min_len(PAR_MIN).map(\|x\| x.to_f32()).collect(),` |
| 422 | iter | HOT-PATH-OK | alloc | a borrowed float16 input to a float32 graph, one parallel pass | `Data::F16Ref(v) => v.par_iter().with_min_len(PAR_MIN).map(\|x\| x.to_f32()).collect(),` |
| 432 | iter | HOT-PATH-OK | alloc | float32 -> float16 for the fp16 graphs' float32-made inputs (hints, foundation inputs on CPU), one parallel pass | `Data::F32(v) => v.par_iter().with_min_len(PAR_MIN).map(\|&x\| half::f16::from_f32(x)).collect(),` |
| 436 | iter | HOT-PATH-OK | alloc | a borrowed float32 input to a float16 graph, one parallel pass | `Data::F32Ref(v) => v.par_iter().with_min_len(PAR_MIN).map(\|&x\| half::f16::from_f32(x)).collect(),` |
| 445 | iter | HOT-PATH-OK | alloc | carry hints: one small aux plane per frame the next window takes | `Data::F16(v) => v[range].iter().map(\|x\| x.to_f32()).collect(),` |
| 447 | iter | NOT-WORTH | alloc | never used on a hot path (bf16 data is only an input) | `Data::Bf16(parts) => parts.iter().flat_map(\|p\| p.iter()).skip(range.start).take(range.len()).map(\|x\| x.to_f32(` |
| 450 | iter | NOT-WORTH | alloc | borrowed inputs only (never an output) | `Data::F16Ref(v) => v[range].iter().map(\|x\| x.to_f32()).collect(),` |
| 459 | iter | NOT-WORTH | alloc | ≤ 80 slices | `let mut out = Vec::with_capacity(parts.iter().map(\|p\| p.len()).sum());` |
| 461 | loop | HOT-PATH-OK |  | the window's frames (≤ 80); each frame converted in parallel chunks | `for p in parts {` |
| 463 | iter | HOT-PATH-OK | nested | each frame converted bf16 -> f16 / f32 straight into the input tensor, parallel | `out.par_extend(p.par_iter().with_min_len(PAR_MIN).map(\|&x\| f(x)));` |
| 476 | iter | NOT-WORTH | alloc | ≤ six inputs, once per session load | `session.inputs().iter().filter(\|i\| i.dtype().tensor_type() == Some(ort::value::TensorElementType::Float16)).ma` |
| 500 | iter | exempt |  |  | `self.f16_inputs.iter().any(\|n\| n == name)` |
| 509 | loop | NOT-WORTH | alloc | at most six inputs | `for (name, shape, data) in inputs {` |
| 529 | loop+iter | NOT-WORTH | alloc | one or two outputs | `for (_, v) in outs.iter() {` |
| 532 | iter | HOT-PATH-OK | alloc, nested | the output's shape (≤ 5 dims) + one copy out of ORT's buffer (the session's outputs are freed right after) | `res.push((s.iter().map(\|&x\| x as usize).collect(), Data::F32(d.to_vec())));` |
| 536 | iter | HOT-PATH-OK | alloc, nested | the output's shape (≤ 5 dims) + one copy out of ORT's buffer, kept as float16 | `res.push((s.iter().map(\|&x\| x as usize).collect(), Data::F16(d.to_vec())));` |

#### engine-rs/crates/ck-core/src/settings.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 67 | iter | NOT-WORTH | alloc | ≤ four outputs, once per job | `let mut sorted: Vec<&String> = s.outputs.iter().collect();` |
| 77 | iter | NOT-WORTH | alloc | ≤ four outputs, once per job | `t.push_str(&format!("Outputs: {}\n", sorted.iter().map(\|x\| x.as_str()).collect::<Vec<_>>().join(", ")));` |

#### engine-rs/crates/ck-core/src/tensorrt.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 36 | iter | exempt |  |  | `ranges.iter().copied().find(\|(lo, hi)\| v >= *lo && v <= *hi)` |
| 137 | wait | SERIAL-REQUIRED |  | one engine build at a time (the builder needs the card to itself); deadline `timeout` (CK_ENGINE_TRT_BUILD_TIMEOUT_S, 1800 s) | `let out = crate::proc::output_timeout(&mut cmd, timeout).map_err(\|e\| BuildError::transient(format!("ck-trt-bui` |
| 139 | iter | NOT-WORTH | alloc | the builder's output lines, once per build | `let line = String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("").to_string();` |
| 150 | iter | exempt |  |  | `String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")` |
| 190 | iter | exempt |  |  | `if TRANSIENT.iter().any(\|m\| low.contains(m)) {` |
| 194 | iter | exempt |  |  | `DETERMINISTIC.iter().any(\|m\| low.contains(m))` |
| 224 | loop | SERIAL-REQUIRED |  | waits for another engine's build of the same range, a poll every LOCK_POLL [bounded: `deadline`, then the lock is taken over] | `loop {` |
| 245 | timer | SERIAL-REQUIRED |  | the lock poll's sleep (not a spin), until `deadline` | `std::thread::sleep(LOCK_POLL);` |
| 274 | loop+iter | exempt |  |  | `for c in s.chars() {` |
| 309 | iter | NOT-WORTH | alloc | a few cache folders, once per TensorRT job | `.iter()` |
| 349 | iter | exempt |  |  | `let mut lines = text.lines();` |

#### engine-rs/crates/ck-core/src/vram.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 36 | loop | exempt |  |  | `for i in 0..points.len().saturating_sub(1) {` |
| 52 | iter | NOT-WORTH | alloc | the table's rows (≤ 10), once per job | `let pts: Vec<(f64, f64)> = rows.iter().map(\|(mp, peaks)\| (*mp, peaks[i])).collect();` |
| 78 | loop+iter | exempt |  |  | `for &chunk in LOW.0.iter().rev() {` |
| 80 | loop | NOT-WORTH | nested | two modes | `for low in [false, true] {` |

#### engine-rs/crates/ck-core/src/writers.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 31 | iter | NOT-WORTH | alloc | ffmpeg arguments, once per writer | `let mut a: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-f", "rawvideo", "-pix_fmt"` |
| 41 | iter | NOT-WORTH | alloc | ffmpeg arguments, once per writer | `a.extend(["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"].iter().map(\|s\| s.to_string()));` |
| 117 | thread | SERIAL-REQUIRED |  | one reader per ffmpeg writer; ends when ffmpeg exits (its stderr closes) | `crate::ahead::spawn_named(name, move \|\| {` |
| 122 | loop | SERIAL-REQUIRED | alloc | ffmpeg's error lines in order [bounded: ends at the pipe's end, when ffmpeg exits or is killed] | `loop {` |
| 150 | iter | NOT-WORTH | alloc | ≤ TAIL_LINES lines of one failed writer | `match tail.iter().find_map(\|l\| crate::write_failure_text(l)) {` |
| 177 | thread | SERIAL-REQUIRED |  | the ffmpeg feeding thread: frames in order; ends when the queue closes or ffmpeg's pipe fails | `let thread = crate::ahead::spawn_named("ffmpeg-feed", move \|\| {` |
| 179 | loop | SERIAL-REQUIRED | alloc | frames go to ffmpeg in order; ends when the sender is dropped | `for buf in rx {` |
| 210 | wait | SERIAL-REQUIRED |  | a failed ffmpeg exiting, FAIL_WAIT 5 s, then killed | `let _ = crate::proc::wait_timeout(&mut c, FAIL_WAIT);` |
| 214 | wait | SERIAL-REQUIRED | no-timeout | joins the stderr reader [bounded: ffmpeg has exited or was killed, so its stderr is closed] | `let _ = crate::ahead::joined(l);` |
| 217 | iter | NOT-WORTH | alloc | ≤ TAIL_LINES lines, once per failed writer | `let tail: Vec<String> = self.tail.lock().unwrap().iter().cloned().collect();` |
| 255 | loop | SERIAL-REQUIRED |  | waits for one feeding thread, a poll every 50 ms [bounded: FINISH_TIMEOUT, then ffmpeg is killed] | `while !t.is_finished() && std::time::Instant::now() < end {` |
| 257 | timer | SERIAL-REQUIRED |  | the finish poll's 50 ms sleep (not a spin), until FINISH_TIMEOUT | `std::thread::sleep(crate::proc::POLL);` |
| 266 | wait | SERIAL-REQUIRED | no-timeout | joins the feeding thread [bounded: it finished, or ffmpeg was just killed so its blocked write fails] | `if let Err(e) = crate::ahead::joined(t) {` |
| 272 | wait | SERIAL-REQUIRED |  | ffmpeg finishing the file, within FINISH_TIMEOUT 300 s | `Some(mut c) => match crate::proc::wait_timeout(&mut c, end.saturating_duration_since(std::time::Instant::now()` |
| 291 | wait | SERIAL-REQUIRED | no-timeout | joins the stderr reader [bounded: ffmpeg has exited, so its stderr is closed] | `let _ = crate::ahead::joined(l);` |
| 303 | wait | NOT-WORTH | no-timeout | drop path: reaps ffmpeg after kill() [bounded: a killed child exits] | `let _ = c.wait();` |
| 336 | iter | HOT-PATH-OK | alloc | EXR only: ≤ four channels per frame, each one pass (the exr crate takes owned channel buffers) | `.iter()` |
| 340 | iter | HOT-PATH-OK | nested | EXR only: one channel's samples (a strided read), per frame | `let vals = (0..w * h).map(move \|i\| nhwc[i * channels + c]);` |
| 353 | iter | NOT-WORTH | alloc | ≤ four channels per frame | `AnyChannels::sort(chans.into_iter().collect()),` |
| 368 | thread | SERIAL-REQUIRED |  | the EXR writing thread: batches in order; ends when the queue closes or a write fails | `let thread = crate::ahead::spawn_named("exr-write", move \|\| {` |
| 370 | loop | SERIAL-REQUIRED | alloc | batches in order; ends when the sender is dropped | `for (idx0, n, data) in rx {` |
| 373 | loop | HOT-PATH-OK | alloc, nested | the frames of one batch (1 at the default batch size) | `for j in 0..n {` |
| 409 | wait | SERIAL-REQUIRED | no-timeout | joins the EXR thread after closing its queue [bounded: ≤ 2 queued frames, each one local file write] | `if let Err(e) = crate::ahead::joined(t) {` |

#### engine-rs/crates/ck-engine/src/lib.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 86 | loop | SERIAL-REQUIRED |  | waits for the next request line [bounded: the reader thread ends at the input's end and says so] | `loop {` |
| 100 | iter | exempt |  |  | `g.lines.iter().flatten().any(\|l\| {` |
| 112 | thread | SERIAL-REQUIRED |  | the request reader: lines in order into the inbox; ends at the input's end (the app closes the pipe or exits) | `let started = std::thread::Builder::new().name("stdin-reader".into()).spawn(move \|\| {` |
| 116 | loop | SERIAL-REQUIRED | alloc | one line at a time, in order [bounded: ends at the input's end or a read error] | `loop {` |
| 144 | loop | SERIAL-REQUIRED | alloc | one job at a time on one GPU; the app queues | `while let Some(line) = inbox.take() {` |

#### engine-rs/crates/ck-engine/src/main.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 63 | iter | exempt |  |  | `if args.iter().any(\|a\| a == "--help" \|\| a == "-h") {` |
| 67 | iter | exempt |  |  | `if args.iter().any(\|a\| a == "--version") {` |

#### engine-rs/tools/e2e_cpu.sh

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 52 | loop | NOT-WORTH |  | four test jobs | `for j in ("p1", "p2", "v1", "v2"):` |
| 72 | loop | NOT-WORTH |  | five checks | `for name, good in checks:` |

#### engine-rs/tools/gen_fixtures.py

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 45 | loop | NOT-WORTH |  | three strengths (fixture generation, by hand) | `for s in (0.3, 0.5, 1.0):` |
| 82 | iter | NOT-WORTH | alloc | a window's weights (fixture generation) | `cases.append({"tc": tc, "overlap": ov, "first": first, "last": last, "w": [float(v) for v in w]})` |
| 89 | loop | NOT-WORTH | alloc | five sizes × the cases below: the 360-case VRAM table (fixture generation, seconds) | `for hw in [(256, 384), (768, 1280), (1152, 1920), (2176, 3840), (4352, 7680)]:` |
| 91 | loop | NOT-WORTH | alloc, nested | four clip lengths (fixture generation) | `for frames in [1, 7, 30, 240]:` |
| 93 | loop | NOT-WORTH | alloc, nested | eight budgets (fixture generation) | `for budget in [1.0, 3.0, 6.0, 8.0, 12.0, 15.5, 24.0, 80.0]:` |
| 97 | loop | NOT-WORTH | alloc, nested | two modes (fixture generation) | `for low in (False, True):` |
| 99 | loop | NOT-WORTH | alloc, nested | five frame counts (fixture generation) | `for f in (1, 4, 13, 50, 100):` |
| 110 | loop | NOT-WORTH |  | two render modes (fixture generation) | `for lin in (False, True):` |
| 114 | loop | NOT-WORTH | nested | four outputs (fixture generation) | `for k, v in r.items():` |
| 119 | loop | NOT-WORTH |  | four outputs (fixture generation) | `for k, v in r.items():` |
| 130 | loop | NOT-WORTH |  | three test images (fixture generation) | `for name in ("rgb16.png", "rgb8.png", "q90.jpg"):` |

#### engine-rs/tools/trt-build/build.sh

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 17 | loop | NOT-WORTH |  | the pinned headers' checksums, once per builder build | `while read -r sum name; do` |

#### engine-rs/tools/trt-build/ck_trt_build.cpp

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 53 | loop | NOT-WORTH |  | one short message | `for (char c : s) {` |
| 116 | loop | NOT-WORTH |  | at most six inputs | `while (std::getline(ss, part, ',')) {` |
| 123 | loop | NOT-WORTH | nested | at most 8 dims | `while (std::getline(ds, v, 'x')) {` |
| 138 | loop | NOT-WORTH |  | the command line | `for (int i = 1; i < argc; i++) {` |
| 149 | loop | NOT-WORTH | alloc | five required options | `for (const char* k : {"onnx", "engine", "min", "opt", "max"}) {` |
| 173 | loop | NOT-WORTH | alloc | the network's inputs | `for (int i = 0; i < net->getNbInputs(); i++) {` |

#### engine/ck_engine.py

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 58 | loop | HOT-PATH-OK |  | one pass per printed line; the model prints a few lines per window | `while "\n" in self._buf:` |
| 93 | iter | HOT-PATH-OK |  | ≤ four writers, per frames reply (≤ 4/s) | `return min((w.ck_frames for w in self.writers), default=0)` |
| 290 | iter | NOT-WORTH |  | ≤ four writers, once per job | `outputs = [w.path for w in self.state.writers if hasattr(w, "path")]` |
| 310 | loop | SERIAL-REQUIRED |  | one job at a time on one GPU; the app queues | `for raw in stdin:` |

#### src/shared/tasks.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 81 | loop | NOT-WORTH |  | a queue of tens of clips, on each state change (≤ 10/s while running) | `for (const job of state.jobs) {` |
| 89 | iter | HOT-PATH-OK |  | the queue's jobs per state push (≤ 10/s while shown) | `const failed = state.jobs.filter((j) => j.status === "failed");` |
| 98 | iter | NOT-WORTH |  | a few tasks per rail click | `return page === "queue" ? (tasks.find((x) => x.page === page && x.jobId)?.jobId ?? null) : null;` |
| 107 | loop | NOT-WORTH |  | N ≤ the queue's length; on change | `for (const t of tasks) {` |

#### src/ui/App.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 50 | iter | HOT-PATH-OK |  | the queue's jobs per state push (≤ 10/s while shown) | `if (!selected \|\| !state.jobs.some((j) => j.id === selected)) setSelected(state.jobs[0]?.id ?? null);` |
| 90 | iter | NOT-WORTH | alloc | the dropped files, once per drop | `const paths = [...e.dataTransfer.files].map((f) => window.ck.pathForFile(f)).filter(Boolean);` |

#### src/ui/JobSettings.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 41 | iter | NOT-WORTH |  | four outputs per click | `set({ outputs: has ? o.outputs.filter((x) => x !== name) : OUTPUT_NAMES.filter((x) => x === name \|\| o.outputs.` |
| 48 | iter | HOT-PATH-OK |  | ≤ four outputs per render | `const outStatus = '${o.outputs.map((x) => OUTPUT_TEXT[x].label).join(", ")} · ${o.outputFormat === "exr" ? 'EX` |
| 94 | iter | HOT-PATH-OK |  | four outputs per render | `{OUTPUT_NAMES.map((name) => (` |
| 186 | iter | NOT-WORTH |  | two numbers per window choice | `const [c, s] = e.target.value.split("/").map(Number);` |
| 191 | iter | HOT-PATH-OK |  | a few window choices per render | `{WINDOWS.map(([c, s]) => (` |

#### src/ui/JobView.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 18 | timer | HOT-PATH-OK |  | one re-render per second while a job runs and the page is visible | `const t = setInterval(() => document.visibilityState === "visible" && tick((n) => n + 1), 1000);` |
| 33 | iter | HOT-PATH-OK |  | ≤ seven stages per render (≤ 10/s while a job runs and the page is shown) | `{STAGE_ORDER.filter((s) => (s !== "foundations" \|\| job.memory?.lowVram) && (s !== "optimize" \|\| job.stage === ` |
| 70 | iter | HOT-PATH-OK |  | ≤ four stills per render | `{job.stills.map((s) => (` |
| 80 | iter | HOT-PATH-OK |  | ≤ four outputs per render | `{job.outputs.map((f) => (` |

#### src/ui/glass/liquidGlass.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 45 | loop | NOT-WORTH |  | half-size pixel rows of a glass element; on mount and debounced resize only | `for (let j = 0; j < ch; j++) {` |
| 47 | loop | NOT-WORTH | nested | half-size pixels of a glass element; on mount and debounced resize only | `for (let i = 0; i < cw; i++) {` |
| 114 | loop | NOT-WORTH |  | ≤ 10 attributes per filter step, per filter build | `for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));` |
| 118 | iter | NOT-WORTH |  | N = 3 x 4 matrix cells; per glass filter build | `const only = (c: number) => [0, 1, 2].map((r) => [0, 1, 2, 3].map((k) => (r === c && k === c ? 1 : 0)).join(" ` |
| 122 | iter | NOT-WORTH |  | three channels, once per filter build | `["r", "g", "b"].forEach((c, i) => {` |

#### src/ui/glass/useLiquidGlass.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 38 | timer | NOT-WORTH |  | one-shot 120 ms debounce of a filter rebuild per resize | `timer = setTimeout(build, 120);` |
| 47 | iter | NOT-WORTH |  | a few filter ids on unmount | `ids.forEach(removeGlassFilter);` |

#### src/ui/glass/useSpecular.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 16 | loop | HOT-PATH-OK |  | N ≤ 3 glass elements; at most once a frame while the pointer moves | `for (const el of elements) {` |
| 28 | timer | HOT-PATH-OK |  | one rAF per pointer move while glass is on, coalesced (frame set until it runs) | `if (!frame) frame = requestAnimationFrame(update);` |

#### src/ui/pages/AboutPage.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 28 | iter | NOT-WORTH | alloc | a doc's chapter headings (≤ 20), per render of the About page | `const chapters = (md: string) => [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());` |
| 62 | iter | NOT-WORTH |  | three docs per render | `{(Object.keys(DOCS) as DocId[]).map((id) => (` |
| 67 | iter | NOT-WORTH | nested | a doc's chapters (≤ 20) per render | `{chapters(DOCS[id].text).map((h) => (` |
| 75 | timer | NOT-WORTH |  | one rAF per chapter click (scroll after the page switch) | `requestAnimationFrame(() => document.getElementById(slug(h))?.scrollIntoView({ behavior: "smooth" }));` |

#### src/ui/pages/EnginePage.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 56 | iter | NOT-WORTH |  | a few problems per render | `{c.problems.map((m) => (` |
| 70 | iter | NOT-WORTH |  | one or two found copies per render | `const custom = setting && !found.some((f) => f.path === setting) ? setting : null;` |
| 85 | iter | NOT-WORTH |  | one or two found copies per list | `{found.map((f) => (` |
| 148 | iter | NOT-WORTH |  | five networks per render | `{Object.entries(p.assets).map(([k, ok]) => (` |
| 166 | iter | HOT-PATH-OK |  | a few compute processes per render (GPU readout every 2 s while a job runs) | `{state.gpu.processes.map((g) => (` |
| 241 | iter | NOT-WORTH |  | a few problems per render | `{state.checkout.problems.map((m) => (` |

#### src/ui/pages/QueuePage.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 26 | iter | HOT-PATH-OK |  | the queue's jobs per render (≤ 10/s while shown) | `const job = state.jobs.find((j) => j.id === selected) ?? null;` |
| 28 | iter | HOT-PATH-OK |  | the queue's jobs per render (≤ 10/s while shown) | `const runnable = state.jobs.some((j) => j.status === "waiting" && !j.clip.probeError && !missingInput(j));` |
| 84 | iter | HOT-PATH-OK |  | one row per job per render (≤ 10/s while shown; rows are cheap, measured pushes ~2/s during a job) | `state.jobs.map((j) => <JobRow key={j.id} job={j} selected={j.id === selected} onSelect={() => onSelect(j.id)} ` |
| 195 | iter | HOT-PATH-OK |  | a few compute processes per render | `const others = state.gpu!.processes.filter((p) => !p.ours && p.usedMb >= OTHER_GPU_USER_MB);` |
| 203 | iter | HOT-PATH-OK |  | a few compute processes per render | `{others.map((p) => (` |

#### src/ui/pages/SettingsPage.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 34 | iter | NOT-WORTH |  | four items per render | `const storageTotal = storage ? storage.reduce((n, i) => n + i.bytes, 0) : null;` |
| 114 | iter | NOT-WORTH |  | three folders per render | `{storage.map((i) => (` |

#### src/ui/panel/Section.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 32 | iter | NOT-WORTH | alloc | a few pinned sections per click | `const togglePin = (id: string) => setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));` |
| 115 | iter | HOT-PATH-OK |  | a few options per render | `{options.map(([v, text]) => (` |

#### src/ui/rail/AppRail.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 99 | timer | NOT-WORTH |  | one zero-delay timer per pointer-up on the rail | `onPointerUp={() => setTimeout(() => (pointerDown.current = false))}` |
| 108 | iter | HOT-PATH-OK |  | the rail's few items per render | `{ITEMS.map((it) => {` |

#### src/ui/theme/palette.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 30 | loop | NOT-WORTH |  | one pass over kdeglobals (a few hundred lines) when the desktop's colors change | `for (const raw of text.split(/\r?\n/)) {` |
| 50 | iter | NOT-WORTH |  | three channels per parsed colour | `return c.every((v) => v <= 255) ? c : undefined;` |
| 112 | loop | NOT-WORTH |  | ≤ 20 steps of arithmetic; on a theme change only | `for (let t = 0.05; t <= 1; t += 0.05) {` |
| 123 | loop+iter | NOT-WORTH |  | ≤ 5 passes × ≤ 4 grounds; on a theme change only | `for (let i = 0; i < 5 && grounds.some((g) => contrast(c, g) < target); i++) c = grounds.reduce((acc, g) => ens` |

#### src/ui/theme/useTheme.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 16 | loop | NOT-WORTH |  | ≤ 20 tokens, on an appearance or desktop color change only | `for (const k of applied) root.style.removeProperty(k);` |
| 36 | loop | NOT-WORTH |  | ≤ 20 tokens, on an appearance or desktop color change only | `for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);` |

#### tools/build-feed.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 28 | wait | SERIAL-REQUIRED | no-timeout | one release asset download per feed build (CI) [bounded: the feed job's timeout-minutes: 20] | `const r = await fetch(asset.browser_download_url, { redirect: "follow" });` |
| 33 | loop | SERIAL-REQUIRED |  | the hash is sequential; one AppImage, once per feed per CI run | `for await (const chunk of r.body) {` |
| 42 | wait | SERIAL-REQUIRED | no-timeout | one GitHub API read per feed build (CI) [bounded: the feed job's timeout-minutes: 20] | `const r = await fetch('https://api.github.com/repos/${REPO}/releases?per_page=50', { headers });` |

#### tools/build_trt_builder.sh

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 37 | loop | NOT-WORTH |  | two libraries, once per cache | `for n in ("libnvinfer.so.10", "libnvonnxparser.so.10"):  # loop: NOT-WORTH — two libraries, once per cache` |

#### tools/check_no_folds.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 10 | loop | NOT-WORTH |  | the source folders' entries, once per gate run | `for (const n of readdirSync(d)) {` |
| 17 | iter | NOT-WORTH | nested | one file's lines, once per gate run | `.forEach((l, i) => /<(details\|summary)[\s>]/.test(l) && hits.push('${p}:${i + 1}: ${l.trim()}'));` |

#### tools/check_targets.sh

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 9 | loop | NOT-WORTH |  | two targets, once per check | `for t in aarch64-apple-darwin x86_64-pc-windows-gnu; do` |

#### tools/drive.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 18 | loop+iter | SERIAL-REQUIRED |  | waits for the app's page to appear (≤ 30 s) | `for (let i = 0; i < 60 && !targets.some((t) => t.type === "page"); i++) {` |
| 21 | wait | SERIAL-REQUIRED |  | asks the test copy's DevTools port for its pages, 2 s timeout per ask (this pass: had none) | `targets = await (await fetch('http://127.0.0.1:${port}/json', { signal: AbortSignal.timeout(2000) })).json();` |
| 28 | iter | NOT-WORTH |  | a few DevTools targets | `const page = targets.find((t) => t.type === "page");` |
| 41 | loop | SERIAL-REQUIRED | alloc | the steps are an ordered script | `for (let i = 0; i < args.length; i++) {` |

#### tools/engine_bench.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 32 | loop | NOT-WORTH | alloc | the command line | `for (let i = 1; i < argv.length; i++) {` |
| 80 | loop | HOT-PATH-OK | alloc | a few processes (engine + ffmpeg writers), every 250 ms | `for (let i = 0; i < all.length; i++) {` |
| 83 | loop | NOT-WORTH | alloc, nested | the threads of one process | `for (const t of readdirSync('/proc/${all[i]}/task')) {` |
| 85 | iter | HOT-PATH-OK | alloc, nested | the engine's few processes, every 250 ms while a bench clip runs | `all.push(...readFileSync('/proc/${all[i]}/task/${t}/children', "utf8").split(" ").filter(Boolean).map(Number))` |
| 96 | iter | HOT-PATH-OK |  | the engine's few processes, every 250 ms while a bench clip runs | `pids.reduce((s, p) => {` |
| 108 | wait | HOT-PATH-OK |  | one nvidia-smi call every 250 ms while a bench clip runs [bounded: 5 s timeout (this pass: had none)] | `execFileSync("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], { encodi` |
| 111 | iter | HOT-PATH-OK |  | a few compute processes, every 250 ms | `.filter(Boolean)` |
| 124 | iter | HOT-PATH-OK |  | a few compute processes, every 250 ms | `.filter(([pid]) => set.has(pid))` |
| 135 | wait | NOT-WORTH | no-timeout | pgrep once per clip (the GPU guard) [bounded: pgrep reads /proc and exits] | `const out = execFileSync("pgrep", ["-fai", pattern], { encoding: "utf8" })` |
| 138 | iter | NOT-WORTH |  | pgrep's few lines, once per clip | `.filter((l) => l.trim() && !l.includes("claude-scratch") && !l.includes("pgrep"));` |
| 145 | iter | NOT-WORTH |  | a few compute processes, once per clip | `const big = gpuApps().filter(([pid, mb]) => !own.has(pid) && mb > 1024);` |
| 147 | iter | NOT-WORTH |  | a few compute processes, once per clip | `return big.length ? 'another process holds graphics memory: ${big.map(([p, m]) => '${p} ${m} MiB').join(", ")}` |
| 153 | iter | NOT-WORTH |  | the clip's frames replies (≤ a few hundred), once per clip | `const f = frames.filter(([t, d]) => d > 0 && (firstWindowAt === undefined \|\| t >= firstWindowAt));` |
| 177 | timer | HOT-PATH-OK |  | the 250 ms sampler while a clip runs; also the stall watchdog (STALL_S, this pass: a silent engine is killed instead of holding the GPU lock) | `const sampler = setInterval(() => {` |
| 250 | iter | NOT-WORTH |  | the bench's rows, once per report | `.map((r) => {` |
| 265 | loop+wait | NOT-WORTH | no-timeout | a few install paths, du once each [bounded: du over a local folder] | `for (const p of paths) total += Number(execFileSync("du", ["-sbL", p], { encoding: "utf8" }).split("\t")[0]);` |
| 273 | iter | NOT-WORTH |  | the command line's clips | `const rows = a.clips.map((spec) => {` |
| 279 | loop | NOT-WORTH |  | a few rows | `for (const r of rows) console.log('${r.name}: ${(r.bytes / 1e9).toFixed(2)} GB  (${r.paths.join(", ")})');` |
| 289 | loop | SERIAL-REQUIRED | alloc | one engine on one GPU at a time; clips run in order | `for (const clip of a.clips) {` |

#### tools/isolated.sh

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 25 | loop | NOT-WORTH |  | the command line | `while [ $# -gt 0 ]; do` |

#### tools/list_loops.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 134 | loop | NOT-WORTH |  | the lines of one block, once per row while listing | `for (let k = i + 1; k < lines.length; k++) {` |
| 145 | loop | NOT-WORTH |  | the lines of one block, once per row while listing | `for (let k = i; k < lines.length; k++) {` |
| 156 | loop | NOT-WORTH |  | the lines of one statement, once per row while listing | `for (let k = i; k < lines.length; k++) {` |
| 162 | loop | NOT-WORTH |  | the characters of one line, once per row while listing | `for (const ch of c) {` |
| 185 | iter | NOT-WORTH |  | a row's flags (≤ 6) | `return r.flags.some((f) => RS_REQUIRED_FLAGS.includes(f));` |
| 199 | loop | NOT-WORTH | retry, alloc | at most six wrapped lines up to the statement's first line [bounded: i - head < 6] | `while (head > 0 && i - head < 6 && !p.comment.test(lines[head - 1]) && (/^\s*\./.test(lines[head]) \|\| /([([=,]` |
| 204 | loop | NOT-WORTH | nested | at most six comment lines above a row | `for (let k = head - 1; k >= 0 && k >= head - 6; k--) {` |
| 219 | iter | NOT-WORTH | nested | one file's lines, once per run | `const t = lines.findIndex((l, k) => /^\s*#\[cfg\(test\)\]/.test(l) && /^\s*mod tests/.test(lines[k + 1] ?? "")` |
| 225 | iter | NOT-WORTH | nested | one file's lines, once per run | `lines.forEach((line, i) => {` |
| 239 | iter | NOT-WORTH | nested | a row's kinds (≤ 3) | `if (/^\s*\./.test(line) && kinds.every((k) => k === "iter") && prev && prev.kind.includes("iter") && prev.star` |
| 245 | iter | NOT-WORTH | nested | one row's span (a few lines) | `.map((l) => codeOf(l, lang))` |
| 253 | iter | NOT-WORTH | alloc, nested | one file's rows, once per run | `rows.forEach((r) => {` |
| 262 | iter | NOT-WORTH | nested | one file's rows per row (≤ 60 × 60), once per run | `const outer = rows.find((o) => o !== r && /loop\|iter\|timer/.test(o.kind) && /loop\|iter/.test(r.kind) && o.star` |
| 272 | iter | NOT-WORTH | alloc, nested | one file's rows, once per run | `return rows.map(({ start, end, body, call, ...r }) => r);` |
| 287 | loop | NOT-WORTH | nested | the files of the repo's source folders, once per run | `for (const name of names) {` |
| 295 | iter | NOT-WORTH | nested | seven roots | `ROOTS.forEach(walk);` |
| 297 | iter | NOT-WORTH | nested | ~100 files | `return files.sort();` |
| 302 | iter | NOT-WORTH | nested | ~100 files, once per run | `return listFiles(root).flatMap((f) => scan(readFileSync(join(root, f), "utf8"), f));` |
| 309 | loop | NOT-WORTH | retry, nested | once per gate run over the rows (its "retry" is the flag's name) [bounded: the rows] | `for (const r of rows) {` |
| 312 | iter | NOT-WORTH | nested | three flags per row | `else if (r.verdict && r.flags.some((f) => ["no-timeout", "retry", "spin"].includes(f)) && !/\[bounded: [^\]]+\` |
| 324 | iter | NOT-WORTH | nested | six verdicts | `const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, 0]));` |
| 326 | iter | NOT-WORTH | nested | the rows, once per doc build | `rows.forEach((r) => r.verdict && byVerdict[r.verdict]++);` |
| 329 | iter | NOT-WORTH | nested | the rows, once per doc build | `rows.forEach((r) => r.kind.split("+").forEach((k) => (kinds[k] = (kinds[k] ?? 0) + 1)));` |
| 332 | iter | NOT-WORTH | nested | the rows, once per doc build | `rows.forEach((r) => r.flags.forEach((f) => (flags[f] = (flags[f] ?? 0) + 1)));` |
| 335 | iter | NOT-WORTH | alloc, nested | the rows, once per doc build | `const areas = [...new Set(rows.map((r) => area(r.file)))];` |
| 338 | iter | NOT-WORTH | nested | a few areas | `out.push('\| Verdict \| ${areas.join(" \| ")} \| All \|', '\|---\|${areas.map(() => "---\|").join("")}---\|');` |
| 340 | loop+iter | NOT-WORTH | nested | six verdicts × a few areas, once per doc build | `for (const v of VERDICTS) out.push('\| ${v} \| ${areas.map((a) => rows.filter((r) => area(r.file) === a && r.ver` |
| 343 | iter | NOT-WORTH | nested | a few areas × the rows, once per doc build | `out.push('\| exempt (Rust, no verdict needed) \| ${areas.map((a) => rows.filter((r) => area(r.file) === a && exe` |
| 345 | iter | NOT-WORTH | nested | a few areas × the rows, once per doc build | `out.push('\| **Total** \| ${areas.map((a) => rows.filter((r) => area(r.file) === a).length).join(" \| ")} \| **${r` |
| 347 | iter | NOT-WORTH | nested | a few kinds | `const kindText = Object.entries(kinds).map(([k, n]) => '${k} ${n}');` |
| 349 | iter | NOT-WORTH | nested | a few flags | `const flagText = Object.entries(flags).map(([k, n]) => '${k} ${n}');` |
| 352 | iter | NOT-WORTH | alloc, nested | the rows, once per doc build | `const files = [...new Set(rows.map((r) => r.file))];` |
| 354 | loop | NOT-WORTH | nested | the listed files, once per doc build | `for (const f of files) {` |
| 358 | iter | NOT-WORTH | nested | the rows per file, once per doc build | `.filter((r) => r.file === f)` |
| 372 | iter | NOT-WORTH |  | the gate's problems | `bad.forEach((b) => console.log(b));` |
| 376 | iter | NOT-WORTH |  | the rows, once per run | `const required = rows.filter((r) => r.required).length;` |
| 382 | iter | NOT-WORTH |  | the rows, once per run | `else rows.forEach((r) => console.log([r.file, r.line, r.kind, verdictText(r, "-"), r.flags.join(",") \|\| "-", r` |

#### tools/matte_compare.py

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 39 | wait | SERIAL-REQUIRED | no-timeout | one ffprobe per compared file [bounded: a local file; the caller runs under timeout] | `r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height"` |
| 56 | loop | SERIAL-REQUIRED | alloc | frames arrive in order from one pipe | `while True:` |
| 69 | wait | SERIAL-REQUIRED | no-timeout | reaps ffmpeg after its frames were read [bounded: its pipe was read to the end] | `p.wait()` |
| 75 | loop | SERIAL-REQUIRED |  | frames stream in order from one ffmpeg (a few frames in memory) | `for f in ffmpeg_frames(["-i", path], h, w, 3, np.uint16, limit):` |
| 82 | loop | SERIAL-REQUIRED |  | frames stream in order from one ffmpeg | `for f in ffmpeg_frames(["-i", path], h, w, 3, np.uint16, limit):` |
| 93 | loop | SERIAL-REQUIRED |  | frames stream in order from one ffmpeg | `for f in ffmpeg_frames(args, h, w, channels, np.float32, limit):` |
| 99 | loop | SERIAL-REQUIRED |  | EXR frames in order | `for f in exr_seq(folder, 1, limit):` |
| 105 | loop | SERIAL-REQUIRED |  | EXR frames in order | `for f in exr_seq(folder, 3, limit):` |
| 129 | loop | NOT-WORTH |  | three name patterns | `for pat in (f"*_{name}.mp4", f"*_{name}.mov", f"*_{name}_exr"):` |
| 160 | loop | SERIAL-REQUIRED | alloc | streamed frame pairs | `for a, b in zip(ref.alpha(), test.alpha()):` |
| 197 | loop | SERIAL-REQUIRED |  | streamed frame pairs | `for i, (a, b) in enumerate(zip(rf, tf)):` |
| 216 | loop | NOT-WORTH | alloc | the compared clips, once per report | `for name, m in rows:` |
| 236 | loop | NOT-WORTH | alloc | a handful of clip folders | `for name in sorted(os.listdir(r_root)):` |
| 245 | loop | SERIAL-REQUIRED | alloc | one clip at a time keeps memory to a few frames | `for name, r, t in pairs:` |
| 255 | iter | NOT-WORTH |  | the compared clips, once per report | `json.dump([m for _, m in rows], f, indent=2)` |

#### tools/release.sh

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 47 | loop | NOT-WORTH |  | the two release files | `for f in "$file" "$winfile"; do [ -f "release/$f" ] \|\| { echo "release: release/$f was not built" >&2; exit 1;` |
| 70 | loop | SERIAL-REQUIRED |  | polling until a deadline [bounded: 6 tries, 10 s apart] | `for try in 1 2 3 4 5 6; do` |
| 76 | timer | SERIAL-REQUIRED |  | waits between feed tries [bounded: 6 tries, 10 s apart] | `sleep 10` |
| 80 | loop | NOT-WORTH |  | the two feed files | `for f in latest.json latest-dev.json; do [ -f "$f" ] && feeds+=("$f"); done` |
| 84 | loop | NOT-WORTH |  | adds the feed files and their signatures | `for f in "${feeds[@]}"; do git add "$f" "$f.sig"; done` |

#### tools/side_by_side.py

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 39 | loop | NOT-WORTH |  | three name patterns | `for pat in (f"*_{name}.mp4", f"*_{name}.mov", f"*_{name}_exr"):` |
| 49 | wait | SERIAL-REQUIRED | no-timeout | one ffprobe of a local file per frame asked for [bounded: a local file] | `probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,hei` |
| 51 | iter | NOT-WORTH |  | two numbers | `w, h = (int(v) for v in probe.stdout.strip().split(",")[:2])` |
| 53 | wait | SERIAL-REQUIRED | no-timeout | one ffmpeg decode of one frame [bounded: a local file, one frame] | `raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-vf", f"select=eq(n\\,{n})", "-vframes` |
| 136 | loop | NOT-WORTH | alloc | a few crops from the command line | `for c in a.crop:` |
| 139 | iter | NOT-WORTH | nested | four numbers of one --crop | `x, y, w, h = (int(v) for v in box.split(","))` |
| 145 | loop | NOT-WORTH |  | alpha and fg | `for kind in ("alpha", "fg"):` |
| 152 | loop | NOT-WORTH | alloc | the frames asked for (a few), each a few image writes | `for n in a.frames:` |
| 155 | loop | NOT-WORTH | alloc, nested | alpha and fg | `for kind in ("alpha", "fg"):` |
| 170 | loop | NOT-WORTH | nested | the crops asked for | `for name, cx, cy, cw, ch in crops:` |
| 179 | wait | SERIAL-REQUIRED | no-timeout | one ffmpeg encode of the whole clip, asked for with --video [bounded: the clip's length; local files] | `subprocess.run(` |

#### tools/two_copies_e2e.sh

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 20 | loop | NOT-WORTH |  | the test's few processes at cleanup | `for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done` |
| 22 | timer | SERIAL-REQUIRED |  | 2 s for the copies to quit before the hard stop [bounded: two seconds] | `sleep 2` |
| 24 | loop | NOT-WORTH |  | the test's few processes at cleanup | `for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done` |
| 36 | timer | SERIAL-REQUIRED |  | 1 s for the private bus to start | `sleep 1` |
| 44 | loop+timer | SERIAL-REQUIRED |  | waits for the compositor's socket, 0.2 s steps [bounded: 10 s] | `for _ in $(seq 50); do [ -S "$RUN/ck-wl-2c" ] && break; sleep 0.2; done` |
| 49 | loop+timer | SERIAL-REQUIRED |  | waits for copy 1's DevTools port file (its browser is up), 0.2 s steps [bounded: 20 s] | `for _ in $(seq 100); do [ -f "$OUT/home/.config/corridorkey-desktop/DevToolsActivePort" ] && break; sleep 0.2;` |
| 51 | timer | SERIAL-REQUIRED |  | 2 s for copy 1 to finish its start | `sleep 2` |
| 58 | loop+timer | SERIAL-REQUIRED |  | waits for copy 2 to quit, 0.2 s steps [bounded: 15 s] | `for _ in $(seq 75); do kill -0 "$C2" 2>/dev/null \|\| break; sleep 0.2; done` |

#### tools/update_e2e.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 21 | loop | SERIAL-REQUIRED |  | waits for the app's page (bounded by timeoutMs) | `while (Date.now() < until) {` |
| 24 | iter+wait | SERIAL-REQUIRED | nested | polls the test copy's DevTools port, 2 s timeout per ask | `const t = (await (await fetch('http://127.0.0.1:${portNow()}/json', { signal: AbortSignal.timeout(2000) })).js` |
| 45 | iter | NOT-WORTH |  | pending DevTools calls when the socket closes | `ws.addEventListener("close", () => wait.forEach((r) => r({ error: "closed" })));` |
| 62 | loop | SERIAL-REQUIRED | alloc | polls the app's update state every 500 ms (bounded by timeoutMs) | `while (Date.now() < until) {` |
| 90 | loop | SERIAL-REQUIRED | alloc | waits for the old page to go and a new one to come (≤ 60 s) | `while (Date.now() < until && !moved) {` |
| 94 | iter+wait | SERIAL-REQUIRED | nested | polls the test copy's DevTools port, 2 s timeout per ask | `const t = (await (await fetch('http://127.0.0.1:${portNow()}/json', { signal: AbortSignal.timeout(2000) })).js` |

#### tools/update_e2e.sh

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 25 | loop | NOT-WORTH |  | the command line | `while [ $# -gt 0 ]; do` |
| 65 | loop | NOT-WORTH |  | the few processes matching the names, per diagnostics / cleanup | `for p in $(pgrep -f -- "$DIR/run/\|\.mount_Corrid" 2>/dev/null); do` |
| 73 | loop | NOT-WORTH |  | the test copies' few processes | `for p in $(test_pids); do` |
| 92 | loop | NOT-WORTH |  | the test copies' few processes, once on failure | `for p in $(test_pids); do timeout 5 ps --forest -o pid,ppid,stat,wchan:30,args -g "$(ps -o sid= -p "$p" \| tr -` |
| 94 | loop | NOT-WORTH |  | the test copies' few processes, once on failure | `for p in $(test_pids); do` |
| 100 | loop | NOT-WORTH | nested | one process's open files, once on failure | `for fd in /proc/$p/fd/*; do printf '  fd %s -> %s\n' "${fd##*/}" "$(readlink "$fd" 2>/dev/null)"; done \| grep ` |
| 102 | loop | NOT-WORTH | nested | one process's threads, once on failure | `for t in /proc/$p/task/*; do printf '  thread %s %s %s\n' "${t##*/}" "$(cat "$t/comm" 2>/dev/null)" "$(cat "$t` |
| 113 | loop | NOT-WORTH |  | the test copies' few processes at cleanup | `for p in $(test_pids); do kill "$p" 2>/dev/null \|\| true; done` |
| 115 | loop | NOT-WORTH |  | the harness's own few processes at cleanup | `for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null \|\| true; done` |
| 119 | timer | SERIAL-REQUIRED |  | 1 s for the copies to go before the leftover check [bounded: one second] | `sleep 1` |
| 121 | loop | NOT-WORTH |  | stragglers after SIGTERM, once at cleanup | `for p in $(test_pids); do kill -9 "$p" 2>/dev/null \|\| true; done` |
| 144 | timer | SERIAL-REQUIRED |  | 1 s for the private bus to start | `sleep 1` |
| 155 | loop+timer | SERIAL-REQUIRED |  | waits for the compositor's socket, 0.2 s steps [bounded: 10 s] | `for _ in $(seq 1 50); do [ -S "$RUN/$WL" ] && break; sleep 0.2; done` |
| 162 | loop | NOT-WORTH |  | the six empty targets a transient service's default dependencies name | `for t in default basic sockets timers paths shutdown exit; do printf '[Unit]\nDescription=%s (test)\n' "$t" > ` |
| 166 | loop+timer | SERIAL-REQUIRED |  | waits for the private manager's socket, 0.1 s steps [bounded: 5 s] | `for _ in $(seq 1 50); do [ -S "$RUN/systemd/private" ] && break; sleep 0.1; done` |
| 179 | timer | SERIAL-REQUIRED |  | a 0.2 s sampler for the test's length [bounded: killed at cleanup] | `( while :; do echo "$(date +%T.%N \| cut -c1-12) $(grep -oE '/tmp/\.mount_Corrid[^ ]*' /proc/self/mountinfo \| t` |
| 184 | timer | SERIAL-REQUIRED |  | waits for the old main, its end, then the new main, 0.05-0.1 s steps [bounded: killed at cleanup] | `( m=""; while [ -z "$m" ]; do m="$(main_pids \| head -1)"; sleep 0.1; done; echo "$m" > "$DIR/old-main.pid"` |
| 186 | loop+timer | SERIAL-REQUIRED |  | the old main's end, 0.05 s steps [bounded: killed at cleanup] | `while kill -0 "$m" 2>/dev/null; do sleep 0.05; done; uptime_now > "$DIR/old-gone"` |
| 188 | timer | SERIAL-REQUIRED |  | the new main's start, 0.1 s steps [bounded: killed at cleanup] | `n=""; while [ -z "$n" ]; do n="$(main_pids \| grep -vx "$m" \| head -1 \|\| true)"; sleep 0.1; done` |
| 216 | timer | SERIAL-REQUIRED |  | 6 s: the mount guard's longest wait, then the old copy's mount must be gone | `sleep 6` |

#### tools/upload_trt_models.sh

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 44 | loop | SERIAL-REQUIRED |  | one upload at a time (the line is the limit) [bounded: gh's own timeouts; rerun resumes] | `for f in "${FILES[@]}"; do` |
| 59 | loop | NOT-WORTH |  | sixteen files compared | `for f in "${FILES[@]}"; do` |

#### tools/verify-feed.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 14 | wait | SERIAL-REQUIRED | no-timeout | one feed read per check (CI / by hand) [bounded: the feed job's timeout-minutes: 20] | `const r = await fetch(src, { cache: "no-store" });` |
| 19 | iter | NOT-WORTH |  | one or two feeds | `const items = local.length ? local.map((f) => ({ src: f, channel: /latest-dev\.json$/.test(f) ? "dev" : "stabl` |
| 22 | loop | NOT-WORTH | alloc | two feeds | `for (const { src, channel } of items) {` |
