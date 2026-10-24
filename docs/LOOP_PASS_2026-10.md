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
statement the formatter wrapped takes the comment above the statement. The gate (`node tools/list_loops.mjs
--check`, part of `npm run gates` and so of `npm run check` and CI) fails on a row without a valid verdict, and
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
| PARALLELIZE | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| BATCH | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| SERIAL-REQUIRED | 0 | 11 | 42 | 1 | 0 | 26 | 80 |
| HOT-PATH-OK | 0 | 7 | 64 | 2 | 19 | 7 | 99 |
| FIX-HOT-PATH | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| NOT-WORTH | 8 | 88 | 140 | 1 | 28 | 58 | 323 |
| **Total** | 8 | 106 | 247 | 4 | 47 | 91 | **503** |

Kinds: loop 165, iter 256, sync 44, wait 45, timer 19, thread 8. Flags: nested 98, alloc 135, main-blocking 47, no-timeout 30, pixel 2, spin 1, retry 3.

Before this pass the gate listed 111 rows (loops only, in electron/, src/, engine/ and the Rust crates: SERIAL-REQUIRED
20, HOT-PATH-OK 34, NOT-WORTH 57). Now 503: the chains, timers, waits, threads, main-process calls, tools/, .hooks/,
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
| 30 | loop | NOT-WORTH |  | once at quit; the app's process tree, about 10 processes (capped at MAX_PIDS) | `while (queue.length && out.length < MAX_PIDS) {` |
| 32 | loop | NOT-WORTH | nested | the direct children of one process, a few | `for (const pid of childrenOf(queue.shift()!)) {` |
| 49 | iter | NOT-WORTH | alloc | ≤ MAX_PIDS process ids, once at quit | `export const mountGuardArgs = (pids: number[]): string[] => ["-c", WAIT_SCRIPT, "sh", ...pids.map(String)];` |
| 55 | iter+sync | NOT-WORTH | main-blocking | once at quit, per process of the app's tree: its threads (a few dozen) and their children (a few) | `return readdirSync('/proc/${pid}/task').flatMap((tid) => readFileSync('/proc/${pid}/task/${tid}/children', "ut` |

#### electron/main/desktopTheme.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 27 | loop+sync | NOT-WORTH | main-blocking | one pass over the process list, once per app run (isKde caches it) | `for (const pid of readdirSync("/proc")) {` |
| 31 | sync | NOT-WORTH | main-blocking | one /proc read per process while scanning for Plasma, once per app start (the result is cached) | `if (/^(plasmashell\|kwin_wayland\|kwin_x11)$/.test(readFileSync('/proc/${pid}/comm', "utf8").trim())) return tru` |
| 47 | sync | NOT-WORTH | main-blocking | one stat, once per app start (cached in `kde`) | `kde ??= isKdeSession(process.env, existsSync(kdeGlobals), plasmaRunning);` |
| 49 | sync | NOT-WORTH | main-blocking | one stat per palette read (Desktop theme only, on a theme change) | `return kde && existsSync(kdeGlobals);` |
| 71 | wait | NOT-WORTH | no-timeout | one gdbus portal read per palette refresh (Desktop theme only) [bounded: its 2 s timeout option] | `execFile(` |
| 91 | iter | NOT-WORTH |  | three channels | `resolve([m[1], m[2], m[3]].map((v) => Math.round(Math.min(1, Math.max(0, Number(v))) * 255)) as Rgb);` |
| 104 | sync | NOT-WORTH | main-blocking | reads kdeglobals (a few KB) per palette refresh, Desktop theme only | `text = readFileSync(kdeGlobals, "utf8");` |
| 126 | timer | NOT-WORTH |  | one-shot 300 ms debounce per settings-file change | `timer = setTimeout(onChange, 300); // lifetime: OK — one-shot 300 ms debounce, cleared by the next fire()` |

#### electron/main/download.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 31 | sync | NOT-WORTH | main-blocking | removes one partial download before an update download (a local unlink) | `rmSync(path, { force: true });` |
| 56 | loop | SERIAL-REQUIRED | alloc | stream order: each chunk is hashed and written in sequence, with a stall deadline | `for (;;) {` |
| 60 | timer | SERIAL-REQUIRED | alloc | the stall timer: one per read, rejects after a minute without data | `const stall = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("the download stopp` |
| 77 | sync | NOT-WORTH | main-blocking | removes a failed download (a local unlink) | `rmSync(path, { force: true });` |
| 82 | sync | NOT-WORTH | main-blocking | removes a failed download (a local unlink) | `rmSync(path, { force: true });` |
| 87 | sync | NOT-WORTH | main-blocking | removes a failed download (a local unlink) | `rmSync(path, { force: true });` |

#### electron/main/engine.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 49 | loop | NOT-WORTH |  | six names, once per engine spawn | `for (const k of ["LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "ELECTRON_RUN_A` |
| 61 | sync | NOT-WORTH | main-blocking | a few stats + one readdir per engine spawn (the CUDA library folders) | `export function rustEngineEnv(env: NodeJS.ProcessEnv, ort: string \| null, exists: (p: string) => boolean = exi` |
| 64 | loop | NOT-WORTH |  | three names, once per engine spawn | `for (const k of ["LD_PRELOAD", "ELECTRON_RUN_AS_NODE", "LD_LIBRARY_PATH"]) delete out[k];` |
| 73 | loop+iter | NOT-WORTH |  | a handful of CUDA library folders | `for (const d of list(nvidia).sort()) if (exists(join(nvidia, d, "lib"))) dirs.push(join(nvidia, d, "lib"));` |
| 79 | iter | NOT-WORTH | alloc | a user's extra library folders, once per engine spawn | `if (env.CK_ENGINE_LD_LIBRARY_PATH) dirs.push(...env.CK_ENGINE_LD_LIBRARY_PATH.split(":").filter(Boolean));` |
| 128 | timer | SERIAL-REQUIRED | alloc | the ping deadline (PING_TIMEOUT_MS), once per engine start | `const timer = setTimeout(() => {` |
| 161 | timer | SERIAL-REQUIRED |  | the quit grace (QUIT_GRACE_MS), then kill; once per engine stop | `setTimeout(() => {` |

#### electron/main/gpu.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 18 | iter | NOT-WORTH |  | four fields, every GPU_POLL_MS while a job runs and the window is shown | `const parts = line.split(",").map((s) => s.trim());` |
| 31 | iter | NOT-WORTH |  | a few compute processes, every GPU_POLL_MS while a job runs and the window is shown | `.map((l) => l.split(",").map((s) => s.trim()))` |
| 50 | sync | HOT-PATH-OK | main-blocking | one /proc/<pid>/cmdline read per compute process (a few), every 2 s only while a job runs and the window is shown | `return readFileSync('/proc/${pid}/cmdline', "utf8");` |
| 60 | wait | HOT-PATH-OK |  | nvidia-smi every 2 s while a job runs and the window is shown; GPU_READ_TIMEOUT_MS 5 s and one read at a time (this pass) | `run("nvidia-smi", ["--query-gpu=name,memory.total,memory.used,utilization.gpu", "--format=csv,noheader,nounits` |
| 62 | wait | HOT-PATH-OK |  | the same read's second query, same timeout | `run("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], { timeout: GPU_RE` |
| 67 | iter | HOT-PATH-OK |  | a few compute processes, every GPU_POLL_MS only while a job runs and the window is shown | `const processes: GpuProcess[] = parseApps(apps.stdout).map(({ pid, usedMb }) => ({ pid, usedMb, name: processN` |

#### electron/main/index.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 114 | timer | HOT-PATH-OK |  | state pushes coalesced to ≤ 10/s, only while the window is shown (this pass); measured ~2/s during a job (engine replies), 3-134 KiB each | `sendTimer = setTimeout(() => {` |
| 153 | timer | HOT-PATH-OK |  | two nvidia-smi calls every 2 s, only while a job runs and the window is shown | `gpuTimer = setInterval(() => void pollGpu(), GPU_POLL_MS);` |
| 188 | loop | SERIAL-REQUIRED | main-blocking | one ffmpeg at a time while the next job may be keying on the same machine | `for (const output of order) {` |
| 190 | iter | NOT-WORTH | nested | ≤ four outputs, once per finished job | `const file = job.outputs.find((f) => basename(f).includes('_${output === "checker" ? "checker_comp" : output}'` |
| 192 | sync | NOT-WORTH | main-blocking | one stat per output, once per finished job | `if (!file \|\| !existsSync(file)) continue;` |
| 204 | loop | SERIAL-REQUIRED | alloc | ffprobe/ffmpeg per clip, one at a time so a big drop doesn't fork dozens | `for (const { path, kind } of expandPaths(paths)) {` |
| 206 | iter | NOT-WORTH | nested | the queue's jobs per dropped clip (a drop of N clips is N × jobs comparisons) | `if (queue.jobs.some((j) => j.clip.path === path && j.status === "waiting")) continue;` |
| 246 | iter | NOT-WORTH |  | the dropped paths, once per drop | `ipcMain.handle(IPC.addPaths, (_e, paths: string[]) => addPaths(paths.filter((p) => typeof p === "string")));` |
| 252 | iter | NOT-WORTH | alloc | seven extensions, once per file dialog | `filters: [{ name: "Video", extensions: [...VIDEO_EXT].map((e) => e.slice(1)) }],` |
| 261 | iter | NOT-WORTH | alloc | a few extensions, once per file dialog | `filters: kind === "hint-image" ? [{ name: "Matte image", extensions: ["png", "jpg", "jpeg", "exr"] }] : [{ nam` |
| 395 | wait | NOT-WORTH | no-timeout | one local file per media request (thumbnails / stills from the app's cache) [bounded: a local file: URL] | `return net.fetch(pathToFileURL(file).toString());` |

#### electron/main/media.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 29 | sync | HOT-PATH-OK | main-blocking | one readdir per added folder, not per frame of playback | `readdirSync(dir)` |
| 31 | iter | NOT-WORTH |  | a frame folder's names, once per probe | `.filter((f) => FRAME_EXT.has(extname(f).toLowerCase()))` |
| 41 | loop | NOT-WORTH | main-blocking | a handful of dropped paths, once per drop | `for (const p of paths) {` |
| 43 | sync | NOT-WORTH | main-blocking | one stat per dropped path, once per drop (blocking but local; the drop is a user action) | `if (!existsSync(p)) continue;` |
| 45 | sync | NOT-WORTH | main-blocking | one stat per dropped path, once per drop | `if (statSync(p).isFile()) {` |
| 51 | iter+sync | NOT-WORTH | nested, main-blocking | one readdir + a stat per entry of a dropped folder, once per drop | `const input = readdirSync(p).find((n) => n.toLowerCase() === "input" && statSync(join(p, n)).isDirectory());` |
| 61 | loop+iter+sync | NOT-WORTH | nested, main-blocking | one folder level of a dropped batch folder, once per drop | `for (const name of readdirSync(p).sort()) {` |
| 64 | sync | NOT-WORTH | main-blocking | one stat per entry of a dropped folder, once per drop | `if (statSync(child).isFile() && VIDEO_EXT.has(extname(name).toLowerCase()) && !isCompanionHint(child)) out.pus` |
| 77 | sync | NOT-WORTH | main-blocking | one stat per hint lookup, once per probed clip | `if (!existsSync(dir)) return null;` |
| 81 | loop+iter+sync | NOT-WORTH | main-blocking | one readdir of the clip's folder, once per added clip | `for (const name of readdirSync(dir).sort()) {` |
| 84 | sync | NOT-WORTH | main-blocking | one stat per candidate hint file, once per probed clip | `if (!exts.has(extname(name).toLowerCase()) \|\| !statSync(full).isFile()) continue;` |
| 89 | iter | NOT-WORTH | nested | a few hint markers per file name | `const marker = markers.find((m) => rest.startsWith(m));` |
| 93 | loop | NOT-WORTH |  | at most two markers | `for (const m of markers) if (found.has(m)) return found.get(m)!;` |
| 108 | iter+sync | NOT-WORTH | main-blocking | one readdir of a shot folder + a stat, once per probed clip | `const hint = readdirSync(shot).find((n) => n.toLowerCase() === "alphahint" && statSync(join(shot, n)).isDirect` |
| 123 | iter | NOT-WORTH |  | a rate's two numbers | `const [n, d] = rate.split("/").map(Number);` |
| 150 | wait | SERIAL-REQUIRED |  | ffprobe of one frame image per probed folder, PROBE_TIMEOUT_MS (this pass: had none) | `const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "json",` |
| 159 | sync | NOT-WORTH | main-blocking | one mkdir (exists after the first) per still | `mkdirSync(cacheDir, { recursive: true });` |
| 162 | sync | NOT-WORTH | main-blocking | one stat per still (the cache key) | `.update('${source}\|${statSync(source).mtimeMs}\|${seconds}\|${width}')` |
| 167 | sync | NOT-WORTH | main-blocking | one stat per still (cache hit check) | `if (existsSync(out)) return out;` |
| 170 | wait | SERIAL-REQUIRED |  | one ffmpeg still at a time, STILL_TIMEOUT_MS (this pass: had none) | `await run("ffmpeg", ["-v", "error", "-y", ...seek, "-i", source, "-frames:v", "1", "-vf", 'scale=${width}:-2',` |

#### electron/main/queue.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 84 | iter | NOT-WORTH |  | the queue's jobs, once per user action | `const job = this.jobs.find((j) => j.id === id);` |
| 87 | iter | NOT-WORTH |  | the queue's jobs, once per user action | `this.jobs = this.jobs.filter((j) => j.id !== id);` |
| 93 | iter | NOT-WORTH |  | the queue's jobs, once per user action | `const job = this.jobs.find((j) => j.id === id);` |
| 116 | iter | NOT-WORTH |  | the queue's jobs, once per user action | `const job = this.jobs.find((j) => j.id === id);` |
| 197 | iter | NOT-WORTH |  | the queue's jobs, once per job start | `const job = this.jobs.find((j) => j.status === "waiting" && !j.clip.probeError && !missingInput(j));` |
| 305 | sync | NOT-WORTH | main-blocking | removes a cancelled / crashed job's temp folder once (the killed engine's float16 temp files, up to a few GB: a few unlinks on a local disk) | `rmSync(this.deps.tempDirFor(id), { recursive: true, force: true });` |

#### electron/main/relaunch.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 23 | loop | NOT-WORTH |  | the entries of one PATH-style variable, once per restart | `for (const d of list.split(":")) {` |
| 54 | loop | NOT-WORTH |  | a fixed list of 16 names | `for (const v of SESSION_VARS) {` |
| 66 | iter | NOT-WORTH |  | the command line, once per relaunch | `return argv.slice(1).filter((a) => typeof a === "string" && !/^--type=/.test(a));` |
| 75 | iter | NOT-WORTH |  | a few environment variables, once per relaunch | `const setenv = Object.entries(o.env ?? {}).map(([k, v]) => '--setenv=${k}=${v}');` |

#### electron/main/settings.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 10 | sync | NOT-WORTH | main-blocking | reads the settings file (a few KB) once at start | `saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;` |
| 33 | sync | NOT-WORTH | main-blocking | a few stats + one readdir per Engine-page check (when the paths are set) | `export function checkRustEngine(binary: string \| null, models: string \| null, exists: (p: string) => boolean =` |
| 47 | iter | NOT-WORTH |  | five networks × the models folder's files, once per check | `const missing = MODEL_PIECES.filter((p) => !files.some((f) => f.endsWith(".onnx") && (f.startsWith('${p}_') \|\|` |
| 63 | sync | NOT-WORTH | main-blocking | one mkdir per settings save (a user action) | `mkdirSync(dirname(file), { recursive: true });` |
| 66 | sync | NOT-WORTH | main-blocking | writes the settings file (a few KB) per save | `writeFileSync(tmp, JSON.stringify(settings, null, 2));` |
| 68 | sync | NOT-WORTH | main-blocking | one rename per save (atomic replace) | `renameSync(tmp, file);` |
| 82 | iter | NOT-WORTH |  | a few required paths, once per check | `const problems = need.filter(([p]) => !exists(join(root, p))).map(([p, what]) => 'Missing ${p}: ${what}.');` |

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
| 31 | sync | NOT-WORTH | main-blocking | one realpath, once per start (the running AppImage) | `return realpathSync(raw);` |
| 40 | sync | NOT-WORTH | main-blocking | the update folder's few files, once per update action | `readdir: (dir) => readdirSync(dir),` |
| 42 | sync | NOT-WORTH | main-blocking | one unlink per stale AppImage, once per update action | `rm: (path) => rmSync(path, { force: true }),` |
| 44 | sync | NOT-WORTH | main-blocking | one chmod per downloaded AppImage | `chmod: (path, mode) => chmodSync(path, mode),` |
| 46 | sync | NOT-WORTH | main-blocking | one rename per downloaded AppImage | `rename: (from, to) => renameSync(from, to),` |
| 48 | sync | NOT-WORTH | main-blocking | one stat per update step | `exists: (path) => existsSync(path),` |
| 51 | sync | NOT-WORTH | main-blocking | one lstat per update step | `const st = lstatSync(path, { throwIfNoEntry: false });` |
| 55 | sync | NOT-WORTH | main-blocking | one symlink per install | `symlink: (target, path) => symlinkSync(target, path),` |
| 68 | loop | SERIAL-REQUIRED | main-blocking | retry: the second form only when systemd refused the first (2 tries) | `for (const exitTypeCgroup of [true, false]) {` |
| 74 | wait | SERIAL-REQUIRED |  | systemd-run for the relaunch, 5 s timeout, at most two tries (with and without ExitType=cgroup), once per restart | `execFileSync("systemd-run", systemdRunArgs({ target, args, env, unit, exitTypeCgroup }), { stdio: "ignore", ti` |
| 94 | timer | SERIAL-REQUIRED |  | the exit fallback 10 s after a relaunch was handed off, once | `setTimeout(() => app.exit(0), 10_000).unref();` |
| 100 | wait | NOT-WORTH | no-timeout | the fetch the feed reader is given; every caller passes an AbortSignal.timeout [bounded: FEED_TIMEOUT_MS at the call site] | `const fetchFn: FetchFn = (url, init) => net.fetch(url, init);` |
| 111 | wait | NOT-WORTH |  | one feed read per update check, FEED_TIMEOUT_MS | `const r = await net.fetch(url, { headers, signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });` |

#### engine-rs/crates/ck-core/src/ahead.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 21 | thread | SERIAL-REQUIRED |  | one producer thread per sequence; it ends at the sequence's end, an error, or a dropped consumer | `std::thread::spawn(move \|\| {` |
| 23 | loop | SERIAL-REQUIRED |  | items in order; ends at the producer's end, an error, or a dropped consumer | `loop {` |
| 44 | wait | SERIAL-REQUIRED | no-timeout | the consumer takes items in order [bounded: the producer ends at its sequence's end or first error, which closes the channel] | `match self.rx.recv() {` |

#### engine-rs/crates/ck-core/src/clip.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 81 | loop+iter | NOT-WORTH |  | the components of one path | `for c in path.split('/') {` |
| 107 | loop | HOT-PATH-OK | alloc | one pass over the folder's entries | `for e in rd.flatten() {` |
| 110 | iter | NOT-WORTH | nested | four extensions per file name, once per probe | `let ok = [".exr", ".png", ".jpg", ".jpeg"].iter().any(\|x\| name.ends_with(x) && name.len() > x.len() && !name.s` |
| 117 | iter | NOT-WORTH | alloc | the folder's file names, once per probe | `Ok(out.into_iter().map(PathBuf::from).collect())` |
| 174 | iter | NOT-WORTH |  | a stream's side data (a few entries), once per probe | `.and_then(\|l\| l.iter().find_map(\|d\| d.get("rotation").map(num)))` |
| 197 | wait | SERIAL-REQUIRED |  | one ffprobe per clip, PROBE_TIMEOUT 120 s (added in this pass; it had no deadline) | `let out = crate::proc::output_timeout(&mut cmd, PROBE_TIMEOUT).map_err(\|e\| {` |

#### engine-rs/crates/ck-core/src/decode.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 51 | loop | HOT-PATH-OK | alloc | read() fills the frame in a few large pieces | `while got < self.buf.len() {` |
| 68 | wait | NOT-WORTH | no-timeout | reaps the decoder after kill() [bounded: a killed child exits] | `let _ = self.child.wait();` |
| 80 | iter | HOT-PATH-OK |  | one pass per decoded frame (~1.4 M pixels), rows in parallel (this pass: was one thread) | `r.par_chunks_mut(w).zip(g.par_chunks_mut(w)).zip(b.par_chunks_mut(w)).zip(rgb.par_chunks(w * 3)).with_min_len(` |
| 83 | loop+iter | HOT-PATH-OK | nested, pixel | one row of pixels | `for (x, px) in src.chunks_exact(3).enumerate() {` |
| 210 | loop | HOT-PATH-OK |  | one pass per frame over its pixels | `for i in 0..n {` |
| 249 | iter | HOT-PATH-OK | alloc | one pass per frame, parallel; the frame's display view (bf16) is the output, one allocation per frame | `let display: Vec<half::bf16> = padded.data.par_iter().with_min_len(1 << 14).map(\|&v\| half::bf16::from_f32(disp` |
| 254 | iter | HOT-PATH-OK | alloc | one pass per frame, parallel; the model view (bf16) is the output, one allocation per frame | `.par_iter()` |
| 342 | thread | SERIAL-REQUIRED |  | the prefetch thread: decodes in order; ends at the clip's end, an error, or a dropped receiver | `let thread = std::thread::spawn(move \|\| {` |
| 344 | loop | SERIAL-REQUIRED |  | frames decode in order; ends at the clip's end, an error, or a dropped receiver | `loop {` |
| 364 | wait | SERIAL-REQUIRED | no-timeout | frames in order [bounded: the prefetch thread ends at the clip's end (ffmpeg closes its pipe) or an error] | `match self.rx.recv() {` |
| 414 | iter | HOT-PATH-OK | alloc | per hint frame (float EXR hints only), one pass; hints are optional | `(0..h * w).map(\|i\| if ch >= 3 { data[i * ch + 2] * 0.114 + data[i * ch + 1] * 0.587 + data[i * ch] * 0.299 } e` |
| 433 | iter | NOT-WORTH |  | a hint folder's file names, once per job | `crate::clip::frame_paths(path)?.into_iter().find(\|p\| p.is_file())` |
| 451 | iter | NOT-WORTH | alloc | the first-frame hint: one image per job | `Still::U8 { ch, h, w, data } => (h, w, (0..h * w).map(\|i\| data[i * ch + pick(ch)] as f32 / 255.0).collect()),` |
| 453 | iter | NOT-WORTH | alloc | the first-frame hint: one image per job | `Still::U16 { ch, h, w, data } => (h, w, (0..h * w).map(\|i\| data[i * ch + pick(ch)] as f32 / 65535.0).collect()` |
| 455 | iter | NOT-WORTH | alloc | the first-frame hint: one image per job | `Still::F32 { ch, h, w, data } => (h, w, (0..h * w).map(\|i\| data[i * ch + pick(ch)]).collect()),` |

#### engine-rs/crates/ck-core/src/gpu.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 36 | iter | NOT-WORTH |  | one environment variable, once per NVML open | `Ok(v) => Some(v.split(',').next().and_then(\|x\| x.trim().parse().ok()).unwrap_or(0)),` |
| 100 | iter | NOT-WORTH | alloc | ≤ 128 compute processes, once per budget read (job start, first session) | `let mine: Vec<u64> = buf[..(n as usize).min(buf.len())].iter().filter(\|p\| p.pid == pid).map(\|p\| p.used).collec` |
| 105 | iter | NOT-WORTH |  | this process's entries (one or two) | `Some(mine.iter().sum())` |
| 128 | loop | NOT-WORTH |  | two library names | `for name in ["libnvinfer.so.10", "libnvinfer.so"] {` |
| 150 | iter | NOT-WORTH |  | /proc/meminfo's ~55 lines, once per CPU job | `s.lines().find_map(\|l\| l.strip_prefix("MemAvailable:")).and_then(\|r\| r.trim().trim_end_matches("kB").trim().pa` |

#### engine-rs/crates/ck-core/src/hann.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 12 | iter | NOT-WORTH | alloc | window starts, once per job (≤ a few hundred) | `let mut starts: Vec<usize> = (0..=t_all - chunk).step_by(stride.max(1)).collect();` |
| 29 | iter | NOT-WORTH | alloc | ≤ 40 ramp weights, once per window | `let ramp: Vec<f32> = (0..n).map(\|k\| 0.5 * (1.0 - (pi * (k as f32 + 1.0) / (overlap as f32 + 1.0)).cos())).coll` |
| 35 | iter | NOT-WORTH |  | ≤ 40 weights, once per window | `w[tc - n..].iter_mut().zip(ramp.iter().rev()).for_each(\|(d, &r)\| *d = r);` |
| 55 | iter | HOT-PATH-OK |  | one baton frame (2.9 M values at 1152x1280), parallel; reads stage 1's float16 directly (this pass: no float32 copy of the window's batons) | `sum.par_iter_mut().zip(baton.par_iter()).with_min_len(1 << 14).for_each(\|(s, b)\| *s += b.to_f32() * w);` |
| 60 | iter | HOT-PATH-OK | alloc | first window covering a frame: its weighted baton is the accumulator (one allocation per frame, kept until the frame is final) | `self.acc.insert(t, (baton.par_iter().with_min_len(1 << 14).map(\|b\| b.to_f32() * w).collect(), w as f64));` |
| 69 | iter | HOT-PATH-OK | alloc | the frames a window finishes (≤ stride); each frame's values in parallel | `keys.into_iter()` |
| 75 | iter | HOT-PATH-OK | alloc, nested | frames a window finishes (≤ stride), each frame parallel; output float16 (this pass: was float32 then rounded again) | `(k, sum.into_par_iter().with_min_len(1 << 14).map(\|v\| half::f16::from_f32(v / d)).collect())` |

#### engine-rs/crates/ck-core/src/image.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 36 | iter | HOT-PATH-OK |  | one pass over a small image (RVM input, carry hint, hint); clamp / round | `self.data.iter_mut().for_each(\|v\| *v = f(*v));` |
| 68 | loop | HOT-PATH-OK |  | one or two steps unless the pad is wider than the image | `while p < 0 \|\| p >= n {` |
| 88 | iter | NOT-WORTH | alloc | the column table, once per padded frame (≤ 4096 entries) | `let xs: Vec<usize> = (0..wo).map(\|x\| reflect101(x as isize - pad.l as isize, img.w)).collect();` |
| 92 | loop | HOT-PATH-OK |  | once per frame and plane (3); the rows of a plane in parallel | `for c in 0..img.c {` |
| 96 | iter | HOT-PATH-OK | nested | rows of one plane in parallel (this pass: were one thread); a gather over the column table | `dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).enumerate().for_each(\|(y, drow)\| {` |
| 100 | iter | HOT-PATH-OK | nested | one row's gather (≤ 4096) | `drow.iter_mut().zip(&xs).for_each(\|(d, &sx)\| *d = srow[sx]);` |
| 110 | loop | HOT-PATH-OK |  | once per output frame and plane | `for c in 0..img.c {` |
| 114 | loop | HOT-PATH-OK | nested | row copies | `for y in 0..h {` |
| 134 | iter | NOT-WORTH | alloc | the row table, once per resize (≤ 960 entries) | `let ys: Vec<(usize, usize)> = (0..ho).map(\|o\| adaptive_range(o, ho, img.h)).collect();` |
| 136 | iter | NOT-WORTH | alloc | the column table, once per resize (≤ 960 entries) | `let xs: Vec<(usize, usize)> = (0..wo).map(\|o\| adaptive_range(o, wo, img.w)).collect();` |
| 139 | loop | HOT-PATH-OK |  | per frame and plane (3); the output rows of a plane in parallel | `for c in 0..img.c {` |
| 143 | iter | HOT-PATH-OK | nested | output rows in parallel (this pass: were one thread) | `dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).zip(ys.par_iter()).for_each(\|(drow, &(y0, y1))\| {` |
| 145 | loop+iter | HOT-PATH-OK | nested | output columns of one row (wo ≤ 960) | `for (ox, &(x0, x1)) in xs.iter().enumerate() {` |
| 148 | loop | HOT-PATH-OK | nested | the cell's rows (4 for C-RADIO, ~5 for MoGe) | `for y in y0..y1 {` |
| 150 | iter | HOT-PATH-OK | nested | one cell row (4-5 values) | `sum += src[y * img.w + x0..y * img.w + x1].iter().fold(0.0f32, \|a, &v\| a + v);` |
| 186 | loop | HOT-PATH-OK |  | per frame and plane (3, or 1 for a carry hint); the output rows in parallel | `for c in 0..img.c {` |
| 190 | iter | HOT-PATH-OK | nested | output rows in parallel (this pass: were one thread) | `dst.par_chunks_mut(wo).with_min_len(ROWS_MIN).zip(ys.par_iter()).for_each(\|(drow, &(y0, y1, wy0, wy1))\| {` |
| 194 | iter | HOT-PATH-OK | nested | one output row (≤ 2176) | `drow.iter_mut().zip(&xs).for_each(\|(d, &(x0, x1, wx0, wx1))\| {` |
| 215 | loop | NOT-WORTH |  | eight taps | `for i in 0..8 {` |
| 223 | iter | NOT-WORTH |  | eight taps | `c.iter_mut().for_each(\|v\| *v = (*v as f64 * inv) as f32);` |
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
| 94 | iter | NOT-WORTH | alloc | ≤ four output names, once per job | `Some(Value::Array(a)) if !a.is_empty() => a.iter().map(\|v\| v.as_str().map(\|x\| x.to_string()).unwrap_or_else(\|\|` |
| 100 | iter | NOT-WORTH | alloc | ≤ four output names, once per job | `let bad: Vec<&String> = outputs.iter().filter(\|x\| !crate::render::OUTPUTS.contains(&x.as_str())).collect();` |

#### engine-rs/crates/ck-core/src/lib.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 69 | iter | NOT-WORTH |  | first line of an error message | `s.lines().next().unwrap_or(s)` |

#### engine-rs/crates/ck-core/src/npy.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 17 | iter | NOT-WORTH | alloc | a fixture header (tests only) | `.split("'shape':")` |
| 26 | iter | NOT-WORTH | alloc | fixture data (tests only) | `d.chunks_exact(4).map(\|c\| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()` |
| 29 | iter | NOT-WORTH | alloc | fixture data (tests only) | `d.chunks_exact(2).map(\|c\| half::f16::from_le_bytes([c[0], c[1]]).to_f32()).collect()` |
| 32 | iter | NOT-WORTH | alloc | fixture data (tests only) | `d.chunks_exact(8).map(\|c\| f64::from_le_bytes(c.try_into().unwrap()) as f32).collect()` |
| 35 | iter | NOT-WORTH | alloc | fixture data (tests only) | `d.iter().map(\|&b\| b as f32).collect()` |
| 38 | iter | NOT-WORTH | alloc | fixture data (tests only) | `d.chunks_exact(2).map(\|c\| u16::from_le_bytes([c[0], c[1]]) as f32).collect()` |
| 43 | iter | NOT-WORTH | alloc | a shape's few dimensions | `if v.len() != shape.iter().product::<usize>() {` |

#### engine-rs/crates/ck-core/src/outputs.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 45 | thread | SERIAL-REQUIRED |  | the render thread: frames to the writers in order; ends when the sender is dropped or a writer fails | `let handle = std::thread::spawn(move \|\| {` |
| 48 | loop | SERIAL-REQUIRED | alloc | frames reach the writers in order; ends when the sender is dropped | `for logits in rx {` |
| 61 | loop | NOT-WORTH | alloc, nested | at most four outputs | `for (name, batch) in rendered {` |
| 63 | iter | NOT-WORTH | alloc, nested | ≤ four writers per rendered output | `let r = match writers.iter().position(\|(n, _)\| n == name) {` |
| 77 | iter | NOT-WORTH | nested | ≤ four writers per frame | `let done = writers.iter().map(\|(_, w)\| w.frames()).min().unwrap_or(0);` |
| 91 | wait | SERIAL-REQUIRED | no-timeout | the render thread already stopped (its channel closed) [bounded: it has ended or is ending] | `_ => Err(self.join().err().unwrap_or_else(\|\| Error::engine("the render thread stopped".into()))),` |
| 99 | loop | NOT-WORTH | spin | drains what is queued (at most a few counts), never waits [bounded: ends at the first Empty] | `loop {` |
| 110 | wait | SERIAL-REQUIRED | no-timeout | waits for the queued frames (≤ QUEUE = 2) to be rendered and handed off [bounded: the sender is dropped first, so the thread ends after them] | `self.join()` |
| 117 | wait | SERIAL-REQUIRED | no-timeout | joins the render thread after dropping its sender [bounded: ≤ 2 queued frames, then the thread ends] | `match h.join() {` |
| 130 | wait | NOT-WORTH | no-timeout | drop path: the same join [bounded: the sender is dropped first] | `let _ = self.join();` |

#### engine-rs/crates/ck-core/src/pipeline.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 55 | iter | NOT-WORTH |  | ≤ four writers, ≤ 4 times per second | `let done = writers.iter().map(\|(_, w)\| w.frames()).min().unwrap_or(0);` |
| 120 | iter | NOT-WORTH |  | four temp files at the job's end | `self.0.iter().for_each(\|p\| {` |
| 153 | wait | HOT-PATH-OK | no-timeout | one RVM window or baton frame from the local temp file, read straight into float16 (this pass: no byte buffer + conversion) [bounded: a local file read] | `self.f.seek(SeekFrom::Start((t0 * self.frame * 2) as u64)).and_then(\|_\| self.f.read_exact(bytemuck::cast_slice` |
| 193 | wait | HOT-PATH-OK | no-timeout | one window's foundation features from the local temp file, in their own type (this pass: float16, half the bytes) [bounded: a local file read] | `self.f.read_exact(bytemuck::cast_slice_mut(&mut out)).map_err(temp_err)?;` |
| 198 | wait | HOT-PATH-OK | no-timeout | the float32 (CPU / fp32) case of the same read [bounded: a local file read] | `self.f.read_exact(bytemuck::cast_slice_mut(&mut out)).map_err(temp_err)?;` |
| 209 | iter | HOT-PATH-OK |  | one frame's display view to float32 (RVM / foundation inputs), parallel | `out[start..].par_iter_mut().with_min_len(1 << 14).zip(v.par_iter()).for_each(\|(o, x)\| *o = x.to_f32());` |
| 226 | loop | SERIAL-REQUIRED | alloc | frames decode in order | `while self.next < t1 {` |
| 232 | iter | HOT-PATH-OK | alloc | a window's frames (≤ 80): Arc clones, no pixel copies (this pass: each frame was deep-copied, ~850 MB per 48-frame window) | `let out = (t0..t1).map(\|t\| self.cache[&t].clone()).collect();` |
| 248 | loop | SERIAL-REQUIRED | alloc | hint frames decode in order | `while self.next < t1 {` |
| 254 | iter | HOT-PATH-OK | alloc | a window's hint frames (≤ 80): Arc clones (this pass: were deep copies) | `let out = (t0..t1).map(\|t\| self.cache[&t].clone()).collect();` |
| 298 | loop+iter | NOT-WORTH |  | at most five networks | `for (p, n) in self.nets.iter_mut() {` |
| 326 | iter | NOT-WORTH | alloc | ≤ five networks per phase | `let need: Vec<&'static str> = pieces.iter().copied().filter(\|p\| !self.nets.contains_key(p)).collect();` |
| 332 | loop | NOT-WORTH | alloc | at most five networks | `for piece in need {` |
| 334 | iter | NOT-WORTH | alloc, nested | ≤ two pending loads | `if let Some(i) = self.pending.iter().position(\|(p, k, _)\| *p == piece && k == key) {` |
| 339 | wait | SERIAL-REQUIRED | no-timeout | takes a network loaded ahead; waits only for the part not yet done [bounded: ORT session creation ends (succeeds or fails)] | `let (net, secs) = h.join().map_err(\|_\| Error::engine(format!("loading {piece} panicked")))??;` |
| 362 | iter | NOT-WORTH | alloc, nested | first line of an error message | `.map_err(\|e\| format!("loading its engine: {}", e.message.lines().next().unwrap_or("")))` |
| 418 | loop | NOT-WORTH | alloc | at most two networks | `for &piece in pieces {` |
| 420 | iter | NOT-WORTH | nested | ≤ two pending loads | `if self.nets.contains_key(piece) \|\| self.pending.iter().any(\|(p, k, _)\| *p == piece && k == key) {` |
| 427 | thread | PARALLELIZE |  | the next low-VRAM phase's network loads while this phase runs (this pass; measured: 1.3-1.5 s less per job) | `let h = std::thread::spawn(move \|\| {` |
| 440 | loop | NOT-WORTH |  | at most two loads [bounded: each load ends (ORT session creation)] | `for (_, _, h) in self.pending.drain(..) {` |
| 442 | wait | NOT-WORTH | no-timeout | joins loads that were started ahead [bounded: ORT session creation ends] | `let _ = h.join();` |
| 451 | loop+iter | NOT-WORTH |  | at most five networks | `for (p, n) in self.nets.iter_mut() {` |
| 465 | iter | NOT-WORTH |  | five model files' sizes, once per session load | `.iter()` |
| 491 | wait | NOT-WORTH |  | ffmpeg -version once per job, 30 s deadline (this pass: had none) | `if crate::proc::output_timeout(std::process::Command::new("ffmpeg").arg("-version"), std::time::Duration::from` |
| 624 | loop | NOT-WORTH | alloc | at most four outputs | `for name in &job.outputs {` |
| 681 | loop | SERIAL-REQUIRED | retry, alloc | one attempt at a time [bounded: the window halves each round, and only while nothing was written: ≤ log2(80) ≈ 7 rounds] | `loop {` |
| 684 | iter | NOT-WORTH | nested | ≤ four writers, once per attempt | `let nothing_written = writers.iter().all(\|(_, w)\| w.frames() == 0);` |
| 708 | loop+iter | NOT-WORTH |  | at most four writers | `for (_, wr) in writers.iter_mut() {` |
| 729 | iter | NOT-WORTH | alloc | ≤ four outputs, once per job | `outputs: writers.iter().map(\|(_, w)\| w.path().to_string_lossy().into_owned()).collect(),` |
| 737 | iter | NOT-WORTH |  | five networks, once per job | `provider == Provider::Cuda && self.rt.tensorrt_ep && crate::runtime::PIECES.iter().any(\|p\| self.models.trt_fil` |
| 785 | iter | NOT-WORTH | alloc | five networks, once per TensorRT job | `let ready: Vec<&str> = crate::runtime::PIECES.iter().copied().filter(\|p\| self.models.trt_file(p, trt_prec).is_` |
| 796 | iter | NOT-WORTH | alloc | a few stale cache folders, once per TensorRT job | `let names: Vec<String> = stale.iter().filter_map(\|p\| p.file_name().map(\|n\| n.to_string_lossy().into_owned())).` |
| 800 | loop | NOT-WORTH |  | a few stale folders | `for s in &stale {` |
| 806 | iter | NOT-WORTH |  | five networks' stamps, once per TensorRT job | `let built = ready.iter().all(\|p\| {` |
| 834 | iter | NOT-WORTH | alloc | five networks, once per TensorRT job | `let todo: Vec<&'static str> = crate::runtime::PIECES.iter().copied().filter(\|p\| !crate::tensorrt::built(&dir.j` |
| 836 | loop+iter | NOT-WORTH | alloc | five networks | `for (i, piece) in crate::runtime::PIECES.iter().copied().enumerate() {` |
| 851 | iter | NOT-WORTH | nested | five names | `let n = todo.iter().position(\|p\| *p == piece).map(\|k\| k + 1).unwrap_or(i + 1);` |
| 930 | iter | NOT-WORTH | alloc | five networks, once per TensorRT job | `let pieces: BTreeMap<&str, &str> = self.nets.iter().map(\|(k, n)\| (*k, n.provider.name())).collect();` |
| 932 | iter | NOT-WORTH | alloc | five networks, once per TensorRT job | `let built: BTreeMap<&str, f64> = self.trt_seconds.iter().filter(\|(_, v)\| v.1).map(\|(k, v)\| (*k, v.0)).collect(` |
| 966 | loop | SERIAL-REQUIRED | alloc | RVM is recurrent: each frame's step takes the previous state | `while let Some(small) = small_frames.next()? {` |
| 969 | iter | NOT-WORTH | nested | two outputs per RVM step | `let mut it = outs.into_iter();` |
| 1005 | loop | NOT-WORTH |  | up to four frames | `while frames.len() < fchunk && done_frames < t_all {` |
| 1017 | loop | SERIAL-REQUIRED |  | chunks of 4 frames, in order | `while let Some((n, (radio, moge))) = chunks.next()? {` |
| 1037 | iter | NOT-WORTH |  | ≤ four output names, once per attempt | `alpha: job.outputs.iter().any(\|o\| o == "alpha"),` |
| 1039 | iter | NOT-WORTH |  | ≤ four output names, once per attempt | `fg: job.outputs.iter().any(\|o\| o == "fg"),` |
| 1041 | iter | NOT-WORTH |  | ≤ four output names, once per attempt | `checker: job.outputs.iter().any(\|o\| o == "checker"),` |
| 1043 | iter | NOT-WORTH |  | ≤ four output names, once per attempt | `cutout: job.outputs.iter().any(\|o\| o == "cutout"),` |
| 1104 | loop+iter | SERIAL-REQUIRED | alloc | windows run in order: each one's carry hint feeds the next | `for (i, &t0) in starts.iter().enumerate() {` |
| 1114 | loop+iter | HOT-PATH-OK | nested | the window's frames | `for (j, m) in hv.iter().enumerate() {` |
| 1118 | iter | NOT-WORTH | nested | the window's hint qualities (≤ 80) | `hq.iter_mut().for_each(\|q\| *q = hq_full);` |
| 1120 | iter | NOT-WORTH | nested | the window's flags (≤ 80) | `present.iter_mut().for_each(\|p\| *p = true);` |
| 1123 | loop | HOT-PATH-OK | nested | the window's frames | `for (j, t) in (t0..t1).enumerate() {` |
| 1136 | iter | NOT-WORTH | nested | the window's flags (≤ 80) | `if !present.iter().any(\|p\| *p) {` |
| 1138 | iter | NOT-WORTH | nested | the window's hint qualities (≤ 80) | `hq.iter_mut().for_each(\|q\| *q = -1.0);` |
| 1142 | loop | HOT-PATH-OK | alloc, nested | the window's frames | `for (j, t) in (t0..t1).enumerate() {` |
| 1152 | iter | HOT-PATH-OK | alloc, nested | the window's frames (≤ 80): moves the model views out, the display views are dropped before the run | `let models: Vec<Arc<Vec<half::bf16>>> = frames.into_iter().map(\|f\| f.model).collect();` |
| 1160 | iter | HOT-PATH-OK | alloc, nested | ≤ 80 slice references; converted once inside the run (this pass: bf16 -> f32 -> f16 was two passes and an 850 MB float32 copy per 48-frame window) | `("rgb", vec![1, tc, 3, sh, sw], Data::Bf16(models.iter().map(\|m\| &m[..]).collect())),` |
| 1170 | iter | NOT-WORTH | nested | two outputs per window | `let mut it = outs.into_iter();` |
| 1184 | iter | HOT-PATH-OK | alloc, nested | carry hints: only the frames the next window takes (≤ stride), in parallel, each a small upsample | `.into_par_iter()` |
| 1198 | loop | HOT-PATH-OK | nested | the window's frames; each frame's values blended in parallel, read in stage 1's type | `for (j, t) in (t0..t1).enumerate() {` |
| 1232 | thread | SERIAL-REQUIRED |  | the low-VRAM stage-2 producer: frames in order; ends at the clip's end, an error, or a dropped receiver | `let producer = std::thread::spawn(move \|\| {` |
| 1235 | loop | SERIAL-REQUIRED | alloc | frames in order; ends at the clip's end, an error, or a dropped receiver | `for t in 0..t_all {` |
| 1252 | loop | SERIAL-REQUIRED |  | frames in order to the writers | `for _ in 0..t_all {` |
| 1255 | wait | SERIAL-REQUIRED | no-timeout | stage 2's next input, in order [bounded: the producer sends every frame or its error, then ends] | `let item = irx.recv().map_err(\|_\| Error::engine("the stage-2 input thread stopped".into())).and_then(\|r\| r);` |
| 1264 | wait | SERIAL-REQUIRED | no-timeout | joins the producer after the receiver is dropped [bounded: its next send fails and it ends] | `let (dec_s, prep_s) = producer.join().map_err(\|_\| Error::engine("the stage-2 input thread panicked".into()))?;` |
| 1277 | iter | NOT-WORTH | alloc | five networks, once per job (the timing line) | `let each: Vec<String> = self.load_each.iter().map(\|(p, s)\| format!("{p} {s:.2}")).collect();` |
| 1283 | loop | NOT-WORTH | alloc | five networks | `for p in crate::runtime::PIECES {` |
| 1295 | iter | NOT-WORTH | alloc | ≤ four phases, once per job | `let ph: Vec<String> = phases.iter().map(\|(n, s)\| format!("{n} {s:.1} s")).collect();` |
| 1307 | iter | NOT-WORTH | alloc | one output per C-RADIO call | `self.net("cradio")?.run(vec![("rgb", vec![n, 3, hr, wr], radio.into())])?.into_iter().next().ok_or_else(\|\| Err` |
| 1310 | iter | NOT-WORTH | alloc | one output per MoGe call | `self.net("moge")?.run(vec![("rgb", vec![n, 3, hm, wm], moge.into())])?.into_iter().next().ok_or_else(\|\| Error:` |
| 1330 | loop | SERIAL-REQUIRED | alloc | frames go to the writers in order | `for (t, b) in ready {` |
| 1357 | iter | NOT-WORTH |  | one output per stage-2 call | `let (_, logits) = outs.into_iter().next().ok_or_else(\|\| Error::engine("stage2: no logits".into()))?;` |
| 1393 | loop | HOT-PATH-OK | alloc | the window's frames | `for f in frames {` |

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

#### engine-rs/crates/ck-core/src/render.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 25 | loop | HOT-PATH-OK |  | once per job | `for y in 0..h {` |
| 27 | loop | HOT-PATH-OK | nested, pixel | one row | `for x in 0..w {` |
| 54 | iter | NOT-WORTH | alloc | four outputs per frame | `OUTPUTS.iter().zip(bufs).zip(on).filter(\|(_, on)\| *on).map(\|((n, b), _)\| (*n, Batch::F32(b))).collect()` |
| 60 | iter | NOT-WORTH | alloc | four outputs per frame | `OUTPUTS.iter().zip(bufs).zip(on).filter(\|(_, on)\| *on).map(\|((n, b), _)\| (*n, Batch::U16(b))).collect()` |
| 71 | iter | HOT-PATH-OK | alloc | one small array per output row (h ≤ 2160), per frame; the pixels go straight into the outputs (this pass: per-row vectors and a join copy) | `let mut rows: Vec<Row<'_, T>> = (0..h).map(\|_\| [None, None, None, None]).collect();` |
| 73 | loop+iter | HOT-PATH-OK |  | four outputs; each split into its h row slices (pointer work, no copies) | `for (i, b) in bufs.iter_mut().enumerate() {` |
| 78 | loop+iter | HOT-PATH-OK | nested | one slice per output row (h ≤ 2160) | `for (y, chunk) in b.chunks_mut(w * ch[i]).enumerate() {` |
| 83 | iter | HOT-PATH-OK |  | output rows in parallel, per frame | `rows.into_par_iter().enumerate().for_each(\|(y, r)\| f(y, r));` |
| 105 | loop | HOT-PATH-OK |  | one output row | `for x in 0..w {` |
| 150 | loop | HOT-PATH-OK |  | one output row | `for x in 0..w {` |

#### engine-rs/crates/ck-core/src/runtime.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 76 | iter | NOT-WORTH |  | two files' sizes | `[file.to_path_buf(), data].iter().filter_map(\|p\| std::fs::metadata(p).ok()).map(\|m\| m.len()).sum()` |
| 98 | iter | NOT-WORTH |  | ≤ four default names per network | `default_names(piece, p).into_iter().map(\|n\| self.dir.join(n)).find(\|f\| f.exists())` |
| 123 | iter | NOT-WORTH | alloc | five networks, once per ping | `PIECES.iter().map(\|k\| (k.to_string(), self.file(k, p).is_some())).collect()` |
| 128 | iter | NOT-WORTH | alloc | five networks, once per job | `PIECES.iter().filter(\|k\| self.file(k, p).is_none()).map(\|k\| k.to_string()).collect()` |
| 135 | iter | NOT-WORTH | alloc | a short build-info string, once per process | `info.split(\|c: char\| c == ',' \|\| c.is_whitespace()).find_map(\|t\| t.strip_prefix("git-branch=rel-")).unwrap_or(` |
| 378 | iter | NOT-WORTH |  | a short environment list, once per session load | `Some(list) if !list.is_empty() => list.split(',').any(\|p\| p.trim() == piece),` |
| 414 | iter | NOT-WORTH |  | ≤ 80 slices | `Data::Bf16(parts) => parts.iter().map(\|p\| p.len()).sum(),` |
| 428 | iter | HOT-PATH-OK | alloc | float16 -> float32 where a graph takes float32 (the CPU / fp32 path), one parallel pass | `Data::F16(v) => v.par_iter().with_min_len(PAR_MIN).map(\|x\| x.to_f32()).collect(),` |
| 439 | iter | HOT-PATH-OK | alloc | float32 -> float16 for the fp16 graphs' float32-made inputs (hints, foundation inputs on CPU), one parallel pass | `Data::F32(v) => v.par_iter().with_min_len(PAR_MIN).map(\|&x\| half::f16::from_f32(x)).collect(),` |
| 449 | iter | HOT-PATH-OK | alloc | carry hints: one small aux plane per frame the next window takes | `Data::F16(v) => v[range].iter().map(\|x\| x.to_f32()).collect(),` |
| 451 | iter | NOT-WORTH | alloc | never used on a hot path (bf16 data is only an input) | `Data::Bf16(parts) => parts.iter().flat_map(\|p\| p.iter()).skip(range.start).take(range.len()).map(\|x\| x.to_f32(` |
| 460 | iter | NOT-WORTH | alloc | ≤ 80 slices | `let mut out = Vec::with_capacity(parts.iter().map(\|p\| p.len()).sum());` |
| 462 | loop | HOT-PATH-OK |  | the window's frames (≤ 80); each frame converted in parallel chunks | `for p in parts {` |
| 464 | iter | HOT-PATH-OK | nested | each frame converted bf16 -> f16 / f32 straight into the input tensor, parallel (this pass: one pass, was two plus a float32 copy) | `out.par_extend(p.par_iter().with_min_len(PAR_MIN).map(\|&x\| f(x)));` |
| 485 | iter | NOT-WORTH | alloc | ≤ six inputs, once per session load | `session.inputs().iter().filter(\|i\| i.dtype().tensor_type() == Some(ort::value::TensorElementType::Float16)).ma` |
| 514 | iter | NOT-WORTH |  | ≤ six input names per input | `self.f16_inputs.iter().any(\|n\| n == name)` |
| 523 | loop | NOT-WORTH | alloc | at most six inputs | `for (name, shape, data) in inputs {` |
| 541 | loop+iter | NOT-WORTH | alloc | one or two outputs | `for (_, v) in outs.iter() {` |
| 544 | iter | HOT-PATH-OK | alloc, nested | the output's shape (≤ 5 dims) + one copy out of ORT's buffer (the session's outputs are freed right after) | `res.push((s.iter().map(\|&x\| x as usize).collect(), Data::F32(d.to_vec())));` |
| 548 | iter | HOT-PATH-OK | alloc, nested | the output's shape (≤ 5 dims) + one copy out of ORT's buffer, kept as float16 (this pass: was converted to float32 here, on the card's thread) | `res.push((s.iter().map(\|&x\| x as usize).collect(), Data::F16(d.to_vec())));` |

#### engine-rs/crates/ck-core/src/settings.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 65 | iter | NOT-WORTH | alloc | ≤ four outputs, once per job | `let mut sorted: Vec<&String> = s.outputs.iter().collect();` |
| 75 | iter | NOT-WORTH | alloc | ≤ four outputs, once per job | `t.push_str(&format!("Outputs: {}\n", sorted.iter().map(\|x\| x.as_str()).collect::<Vec<_>>().join(", ")));` |

#### engine-rs/crates/ck-core/src/tensorrt.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 35 | iter | NOT-WORTH |  | eight ranges | `ranges.iter().copied().find(\|(lo, hi)\| v >= *lo && v <= *hi)` |
| 43 | iter | NOT-WORTH |  | five window lengths | `let tmax = WINDOWS.iter().copied().find(\|t\| t * h.1 * w.1 <= PIXEL_FRAMES_MAX)?;` |
| 117 | wait | SERIAL-REQUIRED |  | one engine build at a time (the builder needs the card to itself); deadline build_timeout() 1800 s (this pass: it had none) | `let out = crate::proc::output_timeout(&mut cmd, build_timeout()).map_err(\|e\| format!("ck-trt-build: {e}"))?;` |
| 119 | iter | NOT-WORTH | alloc | the builder's output lines, once per build | `let line = String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("").to_string();` |
| 127 | iter | NOT-WORTH | alloc | the builder's stderr, once per failed build | `.unwrap_or_else(\|\| format!("ck-trt-build exited with {}: {}", out.status, String::from_utf8_lossy(&out.stderr)` |
| 145 | loop+iter | NOT-WORTH |  | one short name | `for c in s.chars() {` |
| 180 | iter | NOT-WORTH | alloc | a few cache folders, once per TensorRT job | `.iter()` |

#### engine-rs/crates/ck-core/src/vram.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 37 | loop | NOT-WORTH |  | at most seven points | `for i in 0..points.len().saturating_sub(1) {` |
| 53 | iter | NOT-WORTH | alloc | the table's rows (≤ 10), once per job | `let pts: Vec<(f64, f64)> = rows.iter().map(\|(mp, peaks)\| (*mp, peaks[i])).collect();` |
| 80 | loop+iter | NOT-WORTH |  | seven window lengths x two modes | `for &chunk in LOW.0.iter().rev() {` |
| 82 | loop | NOT-WORTH | nested | two modes | `for low in [false, true] {` |

#### engine-rs/crates/ck-core/src/writers.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 31 | iter | NOT-WORTH | alloc | ffmpeg arguments, once per writer | `let mut a: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-f", "rawvideo", "-pix_fmt"` |
| 36 | iter | NOT-WORTH | alloc | ffmpeg arguments, once per writer | `a.extend(["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"].iter().map(\|s\| s.to_string()));` |
| 111 | thread | SERIAL-REQUIRED |  | the ffmpeg feeding thread: frames in order; ends when the queue closes or ffmpeg's pipe fails | `let thread = std::thread::spawn(move \|\| {` |
| 113 | loop | SERIAL-REQUIRED | alloc | frames go to ffmpeg in order; ends when the sender is dropped | `for buf in rx {` |
| 161 | loop | SERIAL-REQUIRED |  | waits for one feeding thread, a poll every 50 ms [bounded: FINISH_TIMEOUT, then ffmpeg is killed] | `while !t.is_finished() && std::time::Instant::now() < end {` |
| 163 | timer | SERIAL-REQUIRED |  | the finish poll's 50 ms sleep (not a spin), until FINISH_TIMEOUT | `std::thread::sleep(crate::proc::POLL);` |
| 172 | wait | SERIAL-REQUIRED | no-timeout | joins the feeding thread [bounded: it finished, or ffmpeg was just killed so its blocked write fails] | `let _ = t.join();` |
| 176 | wait | SERIAL-REQUIRED |  | ffmpeg finishing the file, within FINISH_TIMEOUT 300 s (this pass: it had no deadline) | `Some(mut c) => match crate::proc::wait_timeout(&mut c, end.saturating_duration_since(std::time::Instant::now()` |
| 199 | wait | NOT-WORTH | no-timeout | drop path: reaps ffmpeg after kill() [bounded: a killed child exits] | `let _ = c.wait();` |
| 232 | iter | HOT-PATH-OK | alloc | EXR only: ≤ four channels per frame, each one pass (the exr crate takes owned channel buffers) | `.iter()` |
| 236 | iter | HOT-PATH-OK | nested | EXR only: one channel's samples (a strided read), per frame | `let vals = (0..w * h).map(move \|i\| nhwc[i * channels + c]);` |
| 249 | iter | NOT-WORTH | alloc | ≤ four channels per frame | `AnyChannels::sort(chans.into_iter().collect()),` |
| 261 | thread | SERIAL-REQUIRED |  | the EXR writing thread: batches in order; ends when the queue closes or a write fails | `let thread = std::thread::spawn(move \|\| {` |
| 263 | loop | SERIAL-REQUIRED | alloc | batches in order; ends when the sender is dropped | `for (idx0, n, data) in rx {` |
| 266 | loop | HOT-PATH-OK | alloc, nested | the frames of one batch (1 at the default batch size) | `for j in 0..n {` |
| 302 | wait | SERIAL-REQUIRED | no-timeout | joins the EXR thread after closing its queue [bounded: ≤ 2 queued frames, each one local file write] | `let _ = t.join();` |

#### engine-rs/crates/ck-engine/src/lib.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 62 | loop+iter | SERIAL-REQUIRED | alloc | one job at a time on one GPU; the app queues | `for line in input.lines() {` |

#### engine-rs/crates/ck-engine/src/main.rs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 47 | iter | NOT-WORTH | alloc | the command line, once per process | `args.iter().position(\|a\| a == name).and_then(\|i\| args.get(i + 1).cloned()).or_else(\|\| {` |
| 50 | iter | NOT-WORTH | alloc, nested | the command line, once per process | `args.iter().find_map(\|a\| a.strip_prefix(&p).map(\|s\| s.to_string()))` |
| 57 | iter | NOT-WORTH |  | the command line, once per process | `if args.iter().any(\|a\| a == "--help" \|\| a == "-h") {` |
| 62 | iter | NOT-WORTH |  | the command line, once per process | `if args.iter().any(\|a\| a == "--version") {` |

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
| 14 | loop | NOT-WORTH |  | the pinned headers' checksums, once per builder build | `while read -r sum name; do` |

#### engine-rs/tools/trt-build/ck_trt_build.cpp

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 47 | loop | NOT-WORTH |  | one short message | `for (char c : s) {` |
| 70 | loop | NOT-WORTH |  | at most six inputs | `while (std::getline(ss, part, ',')) {` |
| 77 | loop | NOT-WORTH | nested | at most 8 dims | `while (std::getline(ds, v, 'x')) {` |
| 92 | loop | NOT-WORTH |  | the command line | `for (int i = 1; i < argc; i++) {` |
| 103 | loop | NOT-WORTH | alloc | five required options | `for (const char* k : {"onnx", "engine", "min", "opt", "max"}) {` |
| 127 | loop | NOT-WORTH | alloc | the network's inputs | `for (int i = 0; i < net->getNbInputs(); i++) {` |

#### engine/ck_engine.py

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 58 | loop | HOT-PATH-OK |  | one pass per printed line; the model prints a few lines per window | `while "\n" in self._buf:` |
| 93 | iter | HOT-PATH-OK |  | ≤ four writers, per frames reply (≤ 4/s) | `return min((w.ck_frames for w in self.writers), default=0)` |
| 274 | iter | NOT-WORTH |  | ≤ four writers, once per job | `outputs = [w.path for w in self.state.writers if hasattr(w, "path")]` |
| 294 | loop | SERIAL-REQUIRED |  | one job at a time on one GPU; the app queues | `for raw in stdin:` |

#### src/shared/tasks.ts

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 41 | loop | NOT-WORTH |  | a queue of tens of clips, on each state change (≤ 10/s while running) | `for (const job of state.jobs) {` |
| 46 | iter | HOT-PATH-OK |  | the queue's jobs per state push (≤ 10/s while shown) | `const failed = state.jobs.filter((j) => j.status === "failed");` |
| 58 | loop | NOT-WORTH |  | N ≤ the queue's length; on change | `for (const t of tasks) {` |

#### src/ui/App.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 48 | iter | HOT-PATH-OK |  | the queue's jobs per state push (≤ 10/s while shown) | `if (!selected \|\| !state.jobs.some((j) => j.id === selected)) setSelected(state.jobs[0]?.id ?? null);` |
| 67 | iter | NOT-WORTH |  | a few tasks per rail click | `const t = tasks.find((x) => x.page === pressed && x.jobId);` |
| 79 | iter | NOT-WORTH | alloc | the dropped files, once per drop | `const paths = [...e.dataTransfer.files].map((f) => window.ck.pathForFile(f)).filter(Boolean);` |

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
| 19 | timer | HOT-PATH-OK |  | one re-render per second while a job runs and the page is visible | `const t = setInterval(() => document.visibilityState === "visible" && tick((n) => n + 1), 1000);` |
| 35 | iter | HOT-PATH-OK |  | ≤ seven stages per render (≤ 10/s while a job runs and the page is shown) | `{STAGE_ORDER.filter((s) => (s !== "foundations" \|\| job.memory?.lowVram) && (s !== "optimize" \|\| job.stage === ` |
| 74 | iter | HOT-PATH-OK |  | ≤ four stills per render | `{job.stills.map((s) => (` |
| 84 | iter | HOT-PATH-OK |  | ≤ four outputs per render | `{job.outputs.map((f) => (` |

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
| 28 | iter | NOT-WORTH |  | a few problems per render | `{c.problems.map((m) => (` |
| 98 | iter | NOT-WORTH |  | five networks per render | `{Object.entries(p.assets).map(([k, ok]) => (` |
| 116 | iter | NOT-WORTH |  | five networks per render | `{Object.entries(p.assets).map(([k, ok]) => (` |
| 138 | iter | HOT-PATH-OK |  | a few compute processes per render (GPU readout every 2 s while a job runs) | `{state.gpu.processes.map((g) => (` |

#### src/ui/pages/QueuePage.tsx

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 24 | iter | HOT-PATH-OK |  | the queue's jobs per render (≤ 10/s while shown) | `const job = state.jobs.find((j) => j.id === selected) ?? null;` |
| 26 | iter | HOT-PATH-OK |  | the queue's jobs per render (≤ 10/s while shown) | `const runnable = state.jobs.some((j) => j.status === "waiting" && !j.clip.probeError && !missingInput(j));` |
| 64 | iter | HOT-PATH-OK |  | one row per job per render (≤ 10/s while shown; rows are cheap, measured pushes ~2/s during a job) | `state.jobs.map((j) => <JobRow key={j.id} job={j} selected={j.id === selected} onSelect={() => onSelect(j.id)} ` |
| 166 | iter | HOT-PATH-OK |  | a few compute processes per render | `const others = state.gpu!.processes.filter((p) => !p.ours && p.usedMb >= 512);` |
| 174 | iter | HOT-PATH-OK |  | a few compute processes per render | `{others.map((p) => (` |

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

#### tools/check_no_folds.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 10 | loop | NOT-WORTH |  | the source folders' entries, once per gate run | `for (const n of readdirSync(d)) {` |
| 17 | iter | NOT-WORTH | nested | one file's lines, once per gate run | `.forEach((l, i) => /<(details\|summary)[\s>]/.test(l) && hits.push('${p}:${i + 1}: ${l.trim()}'));` |

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
| 21 | loop | NOT-WORTH |  | the command line | `while [ $# -gt 0 ]; do` |

#### tools/list_loops.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 128 | loop | NOT-WORTH |  | the lines of one block, once per row while listing | `for (let k = i + 1; k < lines.length; k++) {` |
| 139 | loop | NOT-WORTH |  | the lines of one block, once per row while listing | `for (let k = i; k < lines.length; k++) {` |
| 150 | loop | NOT-WORTH |  | the lines of one statement, once per row while listing | `for (let k = i; k < lines.length; k++) {` |
| 156 | loop | NOT-WORTH |  | the characters of one line, once per row while listing | `for (const ch of c) {` |
| 181 | loop | NOT-WORTH | retry, alloc | at most six wrapped lines up to the statement's first line [bounded: i - head < 6] | `while (head > 0 && i - head < 6 && !p.comment.test(lines[head - 1]) && (/^\s*\./.test(lines[head]) \|\| /([([=,]` |
| 186 | loop | NOT-WORTH | nested | at most six comment lines above a row | `for (let k = head - 1; k >= 0 && k >= head - 6; k--) {` |
| 201 | iter | NOT-WORTH | nested | one file's lines, once per run | `const t = lines.findIndex((l, k) => /^\s*#\[cfg\(test\)\]/.test(l) && /^\s*mod tests/.test(lines[k + 1] ?? "")` |
| 207 | iter | NOT-WORTH | nested | one file's lines, once per run | `lines.forEach((line, i) => {` |
| 221 | iter | NOT-WORTH | nested | a row's kinds (≤ 3) | `if (/^\s*\./.test(line) && kinds.every((k) => k === "iter") && prev && prev.kind.includes("iter") && prev.star` |
| 227 | iter | NOT-WORTH | nested | one row's span (a few lines) | `.map((l) => codeOf(l, lang))` |
| 235 | iter | NOT-WORTH | alloc, nested | one file's rows, once per run | `rows.forEach((r) => {` |
| 244 | iter | NOT-WORTH | nested | one file's rows per row (≤ 60 × 60), once per run | `const outer = rows.find((o) => o !== r && /loop\|iter\|timer/.test(o.kind) && /loop\|iter/.test(r.kind) && o.star` |
| 253 | iter | NOT-WORTH | alloc, nested | one file's rows, once per run | `return rows.map(({ start, end, body, call, ...r }) => r);` |
| 268 | loop | NOT-WORTH | nested | the files of the repo's source folders, once per run | `for (const name of names) {` |
| 276 | iter | NOT-WORTH | nested | seven roots | `ROOTS.forEach(walk);` |
| 278 | iter | NOT-WORTH | nested | ~100 files | `return files.sort();` |
| 283 | iter | NOT-WORTH | nested | ~100 files, once per run | `return listFiles(root).flatMap((f) => scan(readFileSync(join(root, f), "utf8"), f));` |
| 290 | loop | NOT-WORTH | retry, nested | once per gate run over the rows (its "retry" is the flag's name) [bounded: the rows] | `for (const r of rows) {` |
| 293 | iter | NOT-WORTH | nested | three flags per row | `else if (r.flags.some((f) => ["no-timeout", "retry", "spin"].includes(f)) && !/\[bounded: [^\]]+\]/.test(r.rea` |
| 303 | iter | NOT-WORTH | nested | six verdicts | `const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, 0]));` |
| 305 | iter | NOT-WORTH | nested | the rows, once per doc build | `rows.forEach((r) => r.verdict && byVerdict[r.verdict]++);` |
| 308 | iter | NOT-WORTH | nested | the rows, once per doc build | `rows.forEach((r) => r.kind.split("+").forEach((k) => (kinds[k] = (kinds[k] ?? 0) + 1)));` |
| 311 | iter | NOT-WORTH | nested | the rows, once per doc build | `rows.forEach((r) => r.flags.forEach((f) => (flags[f] = (flags[f] ?? 0) + 1)));` |
| 314 | iter | NOT-WORTH | alloc, nested | the rows, once per doc build | `const areas = [...new Set(rows.map((r) => area(r.file)))];` |
| 317 | iter | NOT-WORTH | nested | a few areas | `out.push('\| Verdict \| ${areas.join(" \| ")} \| All \|', '\|---\|${areas.map(() => "---\|").join("")}---\|');` |
| 319 | loop+iter | NOT-WORTH | nested | six verdicts × a few areas, once per doc build | `for (const v of VERDICTS) out.push('\| ${v} \| ${areas.map((a) => rows.filter((r) => area(r.file) === a && r.ver` |
| 321 | iter | NOT-WORTH | nested | a few areas × the rows, once per doc build | `out.push('\| **Total** \| ${areas.map((a) => rows.filter((r) => area(r.file) === a).length).join(" \| ")} \| **${r` |
| 323 | iter | NOT-WORTH | nested | a few kinds | `const kindText = Object.entries(kinds).map(([k, n]) => '${k} ${n}');` |
| 325 | iter | NOT-WORTH | nested | a few flags | `const flagText = Object.entries(flags).map(([k, n]) => '${k} ${n}');` |
| 328 | iter | NOT-WORTH | alloc, nested | the rows, once per doc build | `const files = [...new Set(rows.map((r) => r.file))];` |
| 330 | loop | NOT-WORTH | nested | the listed files, once per doc build | `for (const f of files) {` |
| 334 | iter | NOT-WORTH | nested | the rows per file, once per doc build | `.filter((r) => r.file === f)` |
| 348 | iter | NOT-WORTH |  | the gate's problems | `bad.forEach((b) => console.log(b));` |
| 354 | iter | NOT-WORTH |  | the rows, once per run | `else rows.forEach((r) => console.log([r.file, r.line, r.kind, r.verdict \|\| "-", r.flags.join(",") \|\| "-", r.he` |

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

#### tools/update_e2e.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 18 | loop | SERIAL-REQUIRED |  | waits for the app's page (bounded by timeoutMs) | `while (Date.now() < until) {` |
| 21 | iter+wait | SERIAL-REQUIRED | nested | polls the test copy's DevTools port, 2 s timeout per ask | `const t = (await (await fetch('http://127.0.0.1:${port}/json', { signal: AbortSignal.timeout(2000) })).json())` |
| 42 | iter | NOT-WORTH |  | pending DevTools calls when the socket closes | `ws.addEventListener("close", () => wait.forEach((r) => r({ error: "closed" })));` |
| 59 | loop | SERIAL-REQUIRED | alloc | polls the app's update state every 500 ms (bounded by timeoutMs) | `while (Date.now() < until) {` |
| 85 | loop | SERIAL-REQUIRED | alloc | waits for the old page to go and a new one to come (≤ 60 s) | `while (Date.now() < until && !moved) {` |
| 89 | iter+wait | SERIAL-REQUIRED | nested | polls the test copy's DevTools port, 2 s timeout per ask | `const t = (await (await fetch('http://127.0.0.1:${port}/json', { signal: AbortSignal.timeout(2000) })).json())` |

#### tools/update_e2e.sh

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 17 | loop | NOT-WORTH |  | the command line | `while [ $# -gt 0 ]; do` |
| 45 | loop | NOT-WORTH |  | the test copy's few processes at cleanup | `for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null \|\| true; done` |
| 70 | timer | SERIAL-REQUIRED |  | 1 s between checks while the test copy starts | `sleep 1` |
| 83 | timer | SERIAL-REQUIRED |  | the driver step and its failure dump (one run) | `node "$APP/tools/update_e2e.mjs" --port 9350 --expect "$VER" --out "$DIR" \|\| { echo "--- processes:"; ps -eo p` |

#### tools/verify-feed.mjs

| Line | Kind | Verdict | Special attention | Reason | Code |
|---|---|---|---|---|---|
| 14 | wait | SERIAL-REQUIRED | no-timeout | one feed read per check (CI / by hand) [bounded: the feed job's timeout-minutes: 20] | `const r = await fetch(src, { cache: "no-store" });` |
| 19 | iter | NOT-WORTH |  | one or two feeds | `const items = local.length ? local.map((f) => ({ src: f, channel: /latest-dev\.json$/.test(f) ? "dev" : "stabl` |
| 22 | loop | NOT-WORTH | alloc | two feeds | `for (const { src, channel } of items) {` |

