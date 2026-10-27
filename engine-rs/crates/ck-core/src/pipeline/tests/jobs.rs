//! Whole jobs on fakes: the windows, the blend, the low-VRAM staging, the TensorRT fallback, a job stopped part way.
use super::fakes::*;
use super::*;
use std::collections::BTreeSet;

/// The model view's first value of fake frame `t` (FakeStream: display ((t*31) % 97) / 96, model display*2 - 0.5,
/// both bfloat16).
fn model_first(t: usize) -> f32 {
    let d = half::bf16::from_f32(((t * 31) % 97) as f32 / 96.0).to_f32();
    half::bf16::from_f32(d * 2.0 - 0.5).to_f32()
}

/// The stage-1 windows the job logged, as (t0, t1).
fn logged_windows(sink: &RecSink) -> Vec<(usize, usize)> {
    // loop: NOT-WORTH — a test job's log lines
    sink.logs()
        .iter()
        .filter_map(|l| {
            let r = l.trim().strip_prefix("window ")?.split_once('[')?.1.strip_suffix(']')?;
            let (a, b) = r.split_once(':')?;
            Some((a.parse().ok()?, b.parse().ok()?))
        })
        .collect()
}

/// A run's phase: the foundations' two networks are one phase.
fn phase(piece: &str) -> &str {
    match piece {
        "cradio" | "moge" => "foundations",
        p => p,
    }
}

/// The phases in the order they ran (consecutive runs of one phase once).
fn phase_order(runs: &[Run]) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    // loop: NOT-WORTH — a test job's runs
    for r in runs {
        if out.last() != Some(&phase(r.piece)) {
            out.push(phase(r.piece));
        }
    }
    out
}

/// Each run with the networks loaded while it ran.
fn loaded_at_each_run(events: &[Event]) -> Vec<(&'static str, BTreeSet<&'static str>)> {
    let (mut loaded, mut out) = (BTreeSet::new(), Vec::new());
    // loop: NOT-WORTH — a test job's events
    for e in events {
        match e {
            Event::Load(p, _) => {
                loaded.insert(*p);
            }
            Event::Drop(p) => {
                loaded.remove(p);
            }
            Event::Run(r) => out.push((r.piece, loaded.clone())),
        }
    }
    out
}

fn set(pieces: &[&'static str]) -> BTreeSet<&'static str> {
    // loop: NOT-WORTH — ≤ five names
    pieces.iter().copied().collect()
}

/// Runs `f` on its own thread; fails the test when it takes longer than a minute (a thread left waiting).
fn within<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    // loop: SERIAL-REQUIRED — the test's job on its own thread, watched by the deadline below
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    // loop: SERIAL-REQUIRED — waits for the test's job [bounded: 60 s deadline]
    rx.recv_timeout(std::time::Duration::from_secs(60)).expect("the job didn't end: a thread was left waiting")
}

#[test]
fn every_frame_is_covered_by_the_right_windows_and_written_once() {
    // (frames, window, stride): overlapping, the last window pulled back to the end, a clip shorter than the
    // window, windows that only touch, one-frame windows
    // loop: NOT-WORTH — five cases
    for (n, chunk, stride) in [(9, 4, 2), (8, 4, 2), (3, 4, 2), (10, 3, 3), (5, 1, 1)] {
        let mut h = Harness::new(FakeCfg::new(SHAPE), n, options(json!({})));
        let out = h.keying(&key(Provider::Cpu), None, chunk, stride, false);
        out.res.as_ref().unwrap();
        let wins = logged_windows(&out.sink);
        let starts = window_starts(n, chunk, stride);
        // loop: NOT-WORTH — a few windows
        assert_eq!(wins, starts.iter().map(|&t0| (t0, (t0 + chunk).min(n))).collect::<Vec<_>>(), "{n}/{chunk}/{stride}");
        assert_eq!(wins[0].0, 0);
        assert_eq!(wins.last().unwrap().1, n, "the last window ends at the clip's end");
        // loop: NOT-WORTH — a few windows
        for w in wins.windows(2) {
            assert!(w[1].0 <= w[0].1, "{n}/{chunk}/{stride}: a gap between {w:?}");
            assert!(w[1].0 - w[0].0 <= stride, "{n}/{chunk}/{stride}: windows more than a stride apart");
        }
        // stage 1 took each window's own frames, at the window's length and the model shape
        let s1 = h.loader.runs_of("stage1");
        assert_eq!(s1.len(), wins.len());
        // loop: NOT-WORTH — a few windows
        for (r, &(t0, t1)) in s1.iter().zip(&wins) {
            assert_eq!(r.shape("rgb"), &[1, t1 - t0, 3, SHAPE.0, SHAPE.1]);
            assert_eq!(r.firsts[0], model_first(t0), "window [{t0}:{t1}] starts at its frame");
        }
        // stage 2 ran once per frame, in order, on that frame
        let s2 = h.loader.runs_of("stage2");
        // loop: NOT-WORTH — a few frames
        assert_eq!(s2.iter().map(|r| r.firsts[0]).collect::<Vec<_>>(), (0..n).map(model_first).collect::<Vec<_>>());
        assert_eq!(out.frames(), vec![n, n]);
        let last = out.sink.of_type("frames").last().cloned().unwrap().clone();
        assert_eq!((last["done"].as_u64(), last["total"].as_u64()), (Some(n as u64), Some(n as u64)));
    }
}

#[test]
fn the_blend_is_the_hann_weighted_mean_of_the_windows() {
    // stage 1's state for every frame of window i is 0.125 * i (nothing else): a frame's blended state is the taper
    // weighted mean of its windows' numbers, the weights normalised
    // loop: NOT-WORTH — three cases
    for (n, chunk, stride) in [(9, 4, 2), (12, 6, 3), (10, 4, 4)] {
        let mut cfg = FakeCfg::new(SHAPE);
        (cfg.half, cfg.base_term, cfg.window_term) = (false, 0.0, 0.125);
        let mut h = Harness::new(cfg, n, options(json!({"carry_hint": false})));
        let out = h.keying(&key(Provider::Cpu), None, chunk, stride, false);
        out.res.as_ref().unwrap();
        let starts = window_starts(n, chunk, stride);
        let mut expect = vec![(0f64, 0f64); n];
        // loop: NOT-WORTH — a few windows
        for (i, &t0) in starts.iter().enumerate() {
            let tc = (t0 + chunk).min(n) - t0;
            let w = taper_weights(tc, chunk.saturating_sub(stride), i == 0, i == starts.len() - 1);
            // loop: NOT-WORTH — a window's frames
            for (j, wj) in w.iter().enumerate() {
                expect[t0 + j].0 += *wj as f64 * 0.125 * i as f64;
                expect[t0 + j].1 += *wj as f64;
            }
        }
        let s2 = h.loader.runs_of("stage2");
        assert_eq!(s2.len(), n);
        // loop: NOT-WORTH — a few frames
        for (t, r) in s2.iter().enumerate() {
            let want = expect[t].0 / expect[t].1;
            // the blended state goes to stage 2 as float16 (≤ 1 ulp at these values)
            assert!((r.firsts[1] as f64 - want).abs() < 3e-4, "{n}/{chunk}/{stride} frame {t}: {} against {want}", r.firsts[1]);
        }
        // a frame only the first window covers keeps its state; one in the middle of an even overlap is the mean
        assert_eq!(s2[0].firsts[1], 0.0);
    }
}

#[test]
fn low_vram_stages_rvm_then_foundations_then_stage_1_then_stage_2() {
    let mut h = Harness::new(FakeCfg::new(SHAPE), 9, options(json!({})));
    h.keying(&key(Provider::Cpu), None, 4, 2, true).res.unwrap();
    let runs = h.loader.runs();
    assert_eq!(phase_order(&runs), vec!["rvm", "foundations", "stage1", "stage2"]);
    // loop: NOT-WORTH — a test job's runs
    let count = |p: &str| runs.iter().filter(|r| r.piece == p).count();
    // RVM and stage 2 once per frame, the foundations in chunks of 4 frames, stage 1 once per window
    assert_eq!((count("rvm"), count("cradio"), count("moge"), count("stage1"), count("stage2")), (9, 3, 3, 4, 9));
    // on the CPU nothing loads ahead: only the running phase's networks are loaded
    // loop: NOT-WORTH — a test job's runs
    for (piece, loaded) in loaded_at_each_run(&h.loader.events()) {
        let want = match phase(piece) {
            "foundations" => set(&["cradio", "moge"]),
            p => set(&[crate::runtime::PIECES.into_iter().find(|x| *x == p).unwrap()]),
        };
        assert_eq!(loaded, want, "while {piece} ran");
    }
}

#[test]
fn low_vram_on_cuda_loads_the_next_phase_ahead_once() {
    let mut h = Harness::new(FakeCfg::new(SHAPE), 9, options(json!({})));
    h.keying(&key(Provider::Cuda), None, 4, 2, true).res.unwrap();
    let events = h.loader.events();
    assert_eq!(phase_order(&h.loader.runs()), vec!["rvm", "foundations", "stage1", "stage2"]);
    // loop: NOT-WORTH — a test job's events
    let loads: Vec<&str> = events.iter().filter_map(|e| if let Event::Load(p, _) = e { Some(*p) } else { None }).collect();
    assert_eq!(set(&loads), set(&crate::runtime::PIECES), "every network loaded");
    assert_eq!(loads.len(), 5, "each network loaded once (a network loaded ahead is the one its phase uses)");
    // an earlier phase's networks are gone by the time a later phase runs
    let order = ["rvm", "foundations", "stage1", "stage2"];
    // loop: NOT-WORTH — a test job's runs
    for (piece, loaded) in loaded_at_each_run(&events) {
        assert!(loaded.contains(piece), "{piece} ran without being loaded");
        let at = order.iter().position(|p| *p == phase(piece)).unwrap();
        // loop: NOT-WORTH — ≤ five loaded networks
        for l in &loaded {
            assert!(order.iter().position(|p| *p == phase(l)).unwrap() >= at, "{l} still loaded while {piece} ran");
        }
    }
}

#[test]
fn all_loaded_mode_loads_every_network_first_and_streams_stage_2() {
    let mut h = Harness::new(FakeCfg::new(SHAPE), 9, options(json!({})));
    h.keying(&key(Provider::Cpu), None, 4, 2, false).res.unwrap();
    let events = h.loader.events();
    // loop: NOT-WORTH — a test job's runs
    for (piece, loaded) in loaded_at_each_run(&events) {
        assert_eq!(loaded, set(&crate::runtime::PIECES), "while {piece} ran");
    }
    let runs = h.loader.runs();
    // loop: NOT-WORTH — a test job's runs
    let pieces: Vec<&str> = runs.iter().map(|r| r.piece).collect();
    assert!(pieces[..9].iter().all(|p| *p == "rvm"), "the RVM prepass first: {pieces:?}");
    // each window: C-RADIO, MoGe, stage 1, then stage 2 for the frames no later window covers
    assert_eq!(pieces[9..13], ["cradio", "moge", "stage1", "stage2"]);
    // loop: NOT-WORTH — a test job's runs
    let first_s2 = pieces.iter().position(|p| *p == "stage2").unwrap();
    let last_s1 = pieces.iter().rposition(|p| *p == "stage1").unwrap();
    assert!(first_s2 < last_s1, "stage 2 runs while the windows go on");
}

#[test]
fn a_network_tensorrt_cant_load_runs_on_cuda_at_the_same_window() {
    let mut cfg = FakeCfg::new(SHAPE);
    cfg.fail_load = Some(Arc::new(|piece, prov| (prov == Provider::TensorRt && piece == "stage1").then(|| Error::engine("no tactic for this shape".into()))));
    let mut h = Harness::new(cfg, 9, options(json!({})));
    let dir = h.job.temp_dir.join("trt");
    let k = ModelKey { trt_cache: Some(dir.clone()), ..key(Provider::TensorRt) };
    let trt = move |p: &str| TrtSettings { dir: dir.join(p) };
    let out = h.keying(&k, Some(&trt), 4, 2, false);
    out.res.as_ref().unwrap();
    // loop: NOT-WORTH — a test job's events
    let loads: Vec<(&str, Provider)> = h.loader.events().iter().filter_map(|e| if let Event::Load(p, v) = e { Some((*p, *v)) } else { None }).collect();
    // loop: NOT-WORTH — five loads
    for (p, v) in &loads {
        assert_eq!(*v, if *p == "stage1" { Provider::Cuda } else { Provider::TensorRt }, "{p}");
    }
    assert_eq!(loads.len(), 5);
    // the same window as asked for (the fallback doesn't shrink it)
    // loop: NOT-WORTH — four windows
    assert!(h.loader.runs_of("stage1").iter().all(|r| r.shape("rgb")[1] == 4));
    let prov = out.sink.of_type("provider");
    assert_eq!(prov.len(), 1);
    assert_eq!(prov[0]["provider"], "tensorrt+cuda");
    assert_eq!(prov[0]["pieces"]["stage1"], "cuda");
    assert_eq!(prov[0]["pieces"]["stage2"], "tensorrt");
    assert!(prov[0]["fallbacks"]["stage1"].as_str().unwrap().contains("no tactic for this shape"));
    // loop: NOT-WORTH — a test job's log lines
    assert!(out.sink.logs().iter().any(|l| l.contains("TensorRT could not run stage1; it runs on CUDA")));
    assert_eq!(out.frames(), vec![9, 9]);
}

/// bug hunt 2026-10-26 (GPU, a broken stage-1 engine in a low-VRAM TensorRT job): the only `provider` reply came after
/// the RVM phase and said "tensorrt" with no fallbacks while stage 1 ran on CUDA.
#[test]
fn a_later_low_vram_phase_falling_back_is_reported() {
    let mut cfg = FakeCfg::new(SHAPE);
    cfg.fail_load = Some(Arc::new(|piece, prov| (prov == Provider::TensorRt && piece == "stage1").then(|| Error::engine("no engine".into()))));
    let mut h = Harness::new(cfg, 9, options(json!({})));
    let dir = h.job.temp_dir.join("trt");
    let k = ModelKey { trt_cache: Some(dir.clone()), ..key(Provider::TensorRt) };
    let trt = move |p: &str| TrtSettings { dir: dir.join(p) };
    let out = h.keying(&k, Some(&trt), 4, 2, true);
    out.res.as_ref().unwrap();
    let prov = out.sink.of_type("provider");
    let last = prov.last().unwrap();
    assert_eq!(last["provider"], "tensorrt+cuda", "{prov:?}");
    assert!(last["fallbacks"]["stage1"].as_str().unwrap().contains("no engine"), "{prov:?}");
    assert_eq!(last["pieces"]["stage1"], "cuda");
    assert_eq!(out.frames(), vec![9, 9]);
}

#[test]
fn every_network_falling_back_is_a_cuda_job() {
    let mut cfg = FakeCfg::new(SHAPE);
    cfg.fail_load = Some(Arc::new(|_, prov| (prov == Provider::TensorRt).then(|| Error::engine("no engine".into()))));
    let mut h = Harness::new(cfg, 5, options(json!({})));
    let dir = h.job.temp_dir.join("trt");
    let k = ModelKey { trt_cache: Some(dir.clone()), ..key(Provider::TensorRt) };
    let trt = move |p: &str| TrtSettings { dir: dir.join(p) };
    let out = h.keying(&k, Some(&trt), 4, 2, false);
    out.res.as_ref().unwrap();
    assert_eq!(out.sink.of_type("provider")[0]["provider"], "cuda");
    assert_eq!(out.frames(), vec![5, 5]);
}

/// A failure part way (the way a stop reaches the pipeline): `fail` decides it; the job ends with that error, every
/// thread it started has ended, its temporary files are gone, the frames written before it stay written, and the
/// same pipeline runs the next job.
fn stopped_part_way(low_vram: bool, fail: FailRun, fail_frame: Option<usize>, code: crate::ErrorCode, written: usize) {
    let mut cfg = FakeCfg::new(SHAPE);
    cfg.fail_run = Some(fail);
    let mut h = Harness::new(cfg, 9, options(json!({})));
    h.frames.fail_at = fail_frame;
    let (h, out) = within(move || {
        let out = h.keying(&key(Provider::Cuda), None, 4, 2, low_vram);
        (h, out)
    });
    let mut h = h;
    let e = out.res.as_ref().unwrap_err();
    assert_eq!(e.code, code, "{e}");
    assert_eq!(out.frames(), vec![written, written]);
    assert_eq!(h.temp_files(), Vec::<PathBuf>::new(), "the job's temporary files are removed");
    // the next job on the same pipeline (the failure no longer comes)
    h.frames.fail_at = None;
    let (_h, again) = within(move || {
        let out = h.keying(&key(Provider::Cuda), None, 4, 2, low_vram);
        (h, out)
    });
    again.res.as_ref().unwrap();
    assert_eq!(again.frames(), vec![9, 9]);
}

#[test]
fn a_stop_request_ends_the_job_after_the_current_frame() {
    // `corridorkey render` on SIGTERM / SIGINT (a farm's cancel, Ctrl+C): the sink says stop, the job ends `cancelled`
    // at its next frame or window, its temporary files removed; nothing after the stop point is keyed
    // loop: NOT-WORTH — both modes
    for low_vram in [false, true] {
        let mut h = Harness::new(FakeCfg::new(SHAPE), 9, options(json!({})));
        h.stop_at = Some(0);
        let (h, out) = within(move || {
            let out = h.keying(&key(Provider::Cuda), None, 4, 2, low_vram);
            (h, out)
        });
        assert_eq!(out.res.as_ref().unwrap_err().code, crate::ErrorCode::Cancelled, "low_vram {low_vram}");
        assert_eq!(out.frames(), vec![0, 0]);
        assert!(h.loader.runs_of("rvm").is_empty(), "nothing keyed after a stop asked before the job (low_vram {low_vram})");
        assert_eq!(h.temp_files(), Vec::<PathBuf>::new());
        // asked part way (past the 9 RVM steps and the first window): the job stops before the clip's end, cleanly
        let mut h = Harness::new(FakeCfg::new(SHAPE), 9, options(json!({})));
        h.stop_at = Some(13);
        let (h, out) = within(move || {
            let out = h.keying(&key(Provider::Cuda), None, 4, 2, low_vram);
            (h, out)
        });
        assert_eq!(out.res.as_ref().unwrap_err().code, crate::ErrorCode::Cancelled, "low_vram {low_vram}");
        let f = out.frames();
        assert!(f[0] < 9 && f[0] == f[1], "frames written {f:?} (low_vram {low_vram})");
        assert_eq!(h.loader.runs_of("rvm").len(), 9, "the RVM pass ran whole (low_vram {low_vram})");
        assert!(h.loader.runs_of("stage2").len() < 9);
        assert_eq!(h.temp_files(), Vec::<PathBuf>::new());
    }
}

/// Fails `piece`'s run number `at` (from 0, counted over the test) with `code`.
fn fail_nth(piece: &'static str, at: usize, code: crate::ErrorCode) -> FailRun {
    let n = std::sync::atomic::AtomicUsize::new(0);
    Arc::new(move |p, _| (p == piece && n.fetch_add(1, Ordering::Relaxed) == at).then(|| Error::new(code, "stopped".into())))
}

#[test]
fn a_job_stopped_in_the_windows_ends_cleanly() {
    use crate::ErrorCode::Cancelled;
    // the third window fails: the first two windows' final frames (0-3) were rendered and written
    stopped_part_way(false, fail_nth("stage1", 2, Cancelled), None, Cancelled, 4);
}

#[test]
fn a_job_stopped_in_the_low_vram_stage_2_phase_ends_cleanly() {
    use crate::ErrorCode::Cancelled;
    // stage 2's fourth frame fails: three frames written; the stage-2 input thread is stopped and joined
    stopped_part_way(true, fail_nth("stage2", 3, Cancelled), None, Cancelled, 3);
}

#[test]
fn a_frame_that_cant_be_read_ends_the_job_cleanly() {
    // frame 5 fails in the RVM prepass, before any frame is written
    stopped_part_way(true, Arc::new(|_, _| None), Some(5), crate::ErrorCode::Input, 0);
    stopped_part_way(false, Arc::new(|_, _| None), Some(5), crate::ErrorCode::Input, 0);
}

/// A shot of 56 fake frames (`source`'s numbers) narrowed to `range`, keyed at window 4/2: the ranged job, its meta,
/// and the same frames keyed as a clip of their own (the keyed span, nothing written skipped).
fn ranged_job(source: crate::clip::Source, range: crate::job::FrameRange, low_vram: bool) -> (ClipMeta, Outcome, Vec<Run>, Outcome, Vec<Run>) {
    let mut meta = FakeFrames { n: 56, first: 0, shape: SHAPE, fail_at: None }.meta();
    meta.source = source;
    meta.select_range(&range, true, false).unwrap();
    let k = key(if low_vram { Provider::Cuda } else { Provider::Cpu });
    let mut h = Harness::new(FakeCfg::new(SHAPE), meta.num_frames, options(json!({})));
    h.frames.first = meta.start_frame;
    let out = h.keying_meta(&meta, &k, None, 4, 2, low_vram);
    out.res.as_ref().unwrap();
    let mut whole = Harness::new(FakeCfg::new(SHAPE), meta.num_frames, options(json!({})));
    whole.frames.first = meta.start_frame;
    let span = whole.keying(&k, None, 4, 2, low_vram);
    span.res.as_ref().unwrap();
    (meta, out, h.loader.runs(), span, whole.loader.runs())
}

/// Checks a ranged job of shot frames 7..=25 keyed (index), 15..=25 written: the warm-up frames reach RVM, stage 1
/// and the carry exactly as the frames of a clip of their own; only the written frames reach stage 2 and the writers.
fn check_ranged(meta: &ClipMeta, out: &Outcome, runs: &[Run], span: &Outcome, span_runs: &[Run]) {
    assert_eq!((meta.start_frame, meta.num_frames, meta.write_range()), (7, 19, 8..19));
    // loop: NOT-WORTH — a test job's runs
    let of = |r: &[Run], p: &str| r.iter().filter(|x| x.piece == p).map(|x| x.hash).collect::<Vec<_>>();
    assert_eq!(of(runs, "rvm").len(), 19, "RVM saw every keyed frame");
    assert_eq!(of(runs, "rvm"), of(span_runs, "rvm"), "RVM: the span from a zero state");
    assert_eq!(of(runs, "stage1"), of(span_runs, "stage1"), "stage 1: the span's windows, hints and carry");
    assert_eq!(of(runs, "stage2"), of(span_runs, "stage2")[8..].to_vec(), "stage 2: the written frames only");
    // loop: NOT-WORTH — a test job's runs
    let s1: Vec<f32> = runs.iter().filter(|r| r.piece == "stage1").map(|r| r.firsts[0]).collect();
    assert_eq!(s1[0], model_first(7), "the first window starts at the first warm-up frame (shot frame 7)");
    // loop: NOT-WORTH — a test job's runs
    let s2: Vec<f32> = runs.iter().filter(|r| r.piece == "stage2").map(|r| r.firsts[0]).collect();
    // loop: NOT-WORTH — eleven frames
    assert_eq!(s2, (15..=25).map(model_first).collect::<Vec<_>>(), "stage 2 on shot frames 15..=25, in order");
    assert_eq!(out.frames(), vec![11, 11]);
    assert_eq!(span.frames(), vec![19, 19]);
    let last = out.sink.of_type("frames").last().cloned().unwrap().clone();
    assert_eq!((last["done"].as_u64(), last["total"].as_u64()), (Some(11), Some(11)));
}

#[test]
fn a_frame_range_keys_its_warm_up_and_writes_only_the_range() {
    // a folder numbered 65-120; frames 80-90 with 8 warm-up frames: 72-90 keyed, 80-90 written with their numbers
    // loop: NOT-WORTH — 56 names
    let paths: Vec<PathBuf> = (65..=120).map(|i| PathBuf::from(format!("/plates/s_{i:05}.exr"))).collect();
    let range = crate::job::FrameRange { start: 80, end: 90, preroll: 8, tail: 0 };
    // loop: NOT-WORTH — both modes
    for low_vram in [false, true] {
        let (meta, out, runs, span, span_runs) = ranged_job(crate::clip::Source::Frames(paths.clone()), range, low_vram);
        check_ranged(&meta, &out, &runs, &span, &span_runs);
        assert_eq!(meta.source, crate::clip::Source::Frames(paths[7..=25].to_vec()), "the folder's files 72-90");
        let n = meta.exr_numbers();
        // loop: NOT-WORTH — eleven numbers
        assert_eq!((n.numbers.clone(), n.width, n.from_source), ((80..=90).collect::<Vec<u64>>(), 5, true));
        assert_eq!((n.file_name("s_alpha", 0).unwrap(), n.describe()), ("s_alpha.00080.exr".to_string(), "source (80-90)".to_string()));
        assert_eq!(meta.range.as_ref().unwrap().keyed, (72, 90));
    }
}

#[test]
fn a_video_range_is_numbered_from_the_shots_1001() {
    // a video of 56 frames is numbered 1001-1056; 1016-1026 with 8 warm-up frames: decoded from source frame 7
    let range = crate::job::FrameRange { start: 1016, end: 1026, preroll: 8, tail: 0 };
    // loop: NOT-WORTH — both modes
    for low_vram in [false, true] {
        let (meta, out, runs, span, span_runs) = ranged_job(crate::clip::Source::Video(PathBuf::from("/c/shot.mp4")), range, low_vram);
        check_ranged(&meta, &out, &runs, &span, &span_runs);
        let n = meta.exr_numbers();
        // loop: NOT-WORTH — eleven numbers
        assert_eq!((n.numbers.clone(), n.width, n.from_source), ((1016..=1026).collect::<Vec<u64>>(), 4, false));
        assert_eq!(n.file_name("shot_fg", 10).unwrap(), "shot_fg.1026.exr");
        assert_eq!(meta.range.as_ref().unwrap().keyed, (1008, 1026));
    }
}

#[test]
fn a_tail_is_keyed_after_the_range_and_not_written() {
    let range = crate::job::FrameRange { start: 1016, end: 1026, preroll: 0, tail: 4 };
    let mut meta = FakeFrames { n: 56, first: 0, shape: SHAPE, fail_at: None }.meta();
    meta.source = crate::clip::Source::Video(PathBuf::from("/c/shot.mp4"));
    meta.select_range(&range, true, false).unwrap();
    assert_eq!((meta.start_frame, meta.num_frames, meta.write_range()), (15, 15, 0..11));
    let mut h = Harness::new(FakeCfg::new(SHAPE), meta.num_frames, options(json!({})));
    h.frames.first = meta.start_frame;
    let out = h.keying_meta(&meta, &key(Provider::Cpu), None, 4, 2, false);
    out.res.as_ref().unwrap();
    assert_eq!(h.loader.runs_of("rvm").len(), 15);
    // loop: NOT-WORTH — a test job's runs
    let s2: Vec<f32> = h.loader.runs_of("stage2").iter().map(|r| r.firsts[0]).collect();
    // loop: NOT-WORTH — eleven frames
    assert_eq!(s2, (15..=25).map(model_first).collect::<Vec<_>>());
    assert_eq!(out.frames(), vec![11, 11]);
}

#[test]
fn a_whole_shot_job_is_unchanged() {
    // no range: every frame written, numbered as before (the pinned digests above are the outputs, unchanged)
    let meta = FakeFrames { n: 9, first: 0, shape: SHAPE, fail_at: None }.meta();
    assert_eq!((meta.range.clone(), meta.write_range()), (None, 0..9));
    // a range that writes the whole shot leaves the job exactly as a whole-shot job, video output too
    // loop: NOT-WORTH — 56 names
    let paths: Vec<PathBuf> = (65..=120).map(|i| PathBuf::from(format!("/plates/s_{i:05}.exr"))).collect();
    let mut shot = FakeFrames { n: 56, first: 0, shape: SHAPE, fail_at: None }.meta();
    shot.source = crate::clip::Source::Frames(paths);
    let before = shot.clone();
    shot.select_range(&crate::job::FrameRange { start: 65, end: 120, preroll: 8, tail: 8 }, false, true).unwrap();
    assert_eq!(shot, before);
    assert_eq!(shot.exr_numbers(), crate::clip::FrameNumbers::for_source(&before.source, 56));
}

#[test]
fn bad_frame_ranges_are_refused() {
    // loop: NOT-WORTH — 56 names
    let paths: Vec<PathBuf> = (65..=120).map(|i| PathBuf::from(format!("/plates/s_{i:05}.exr"))).collect();
    let shot = || {
        let mut m = FakeFrames { n: 56, first: 0, shape: SHAPE, fail_at: None }.meta();
        m.source = crate::clip::Source::Frames(paths.clone());
        m
    };
    let r = |start, end, preroll| crate::job::FrameRange { start, end, preroll, tail: 0 };
    let refuse = |range: crate::job::FrameRange, exr: bool, hint: bool| {
        let e = shot().select_range(&range, exr, hint).unwrap_err();
        assert_eq!(e.code.as_str(), "bad-request", "{range:?}: {}", e.message);
        e.message
    };
    // outside the shot: the message names the shot's range
    assert!(refuse(r(60, 90, 0), true, false).contains("(65-120)"));
    assert!(refuse(r(80, 121, 0), true, false).contains("(65-120)"));
    // part of a shot on video output
    assert!(refuse(r(80, 90, 0), false, false).contains("use EXR for a range"));
    // a first-frame hint with a span that doesn't start at the shot's first frame
    assert!(refuse(r(80, 90, 8), true, true).contains("first-frame hint"));
    // ... and with one that does (the warm-up reaches back to frame 65): taken
    let mut m = shot();
    m.select_range(&r(70, 90, 8), true, true).unwrap();
    assert_eq!((m.start_frame, m.write_range()), (0, 5..26));
    // a range between a folder's numbers
    let mut gap = shot();
    gap.source = crate::clip::Source::Frames(vec![PathBuf::from("/p/a_0065.exr"), PathBuf::from("/p/a_0066.exr"), PathBuf::from("/p/a_0070.exr")]);
    gap.num_frames = 3;
    assert_eq!(gap.select_range(&r(67, 69, 0), true, false).unwrap_err().code.as_str(), "bad-request");
}
