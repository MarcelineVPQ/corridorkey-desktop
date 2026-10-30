//! The out-of-memory retry (`attempts`): an automatic window that runs out of graphics memory before any frame was
//! written is halved and the job restarted, down to a one-frame window; nothing else is retried.
use super::fakes::*;
use super::*;
use crate::ErrorCode;

/// What `attempts` did: the outcome, the window it ended at, the windows it retried at (the settings file's
/// callback).
struct Retried {
    out: Outcome,
    plan: JobPlan,
    retried: Vec<(usize, usize)>,
}

impl Harness {
    fn attempts(&mut self, chunk: usize, stride: usize, low_vram: bool) -> Retried {
        self.attempts_on(Provider::Cpu, chunk, stride, low_vram)
    }

    fn attempts_on(&mut self, provider: Provider, chunk: usize, stride: usize, low_vram: bool) -> Retried {
        let meta = self.frames.meta();
        let (mut writers, seen) = self.writers();
        let mut report = FrameReport { total: meta.num_frames, last_sent: None, last_done: None };
        let mut sink = RecSink::default();
        let ctx = JobCtx::new(&self.job, &meta, &self.frames, None, "clip");
        // a TensorRT job carries its CUDA key (run_job)
        let cuda = (provider == Provider::TensorRt).then(|| key(Provider::Cuda));
        let mut plan = JobPlan { chunk, stride, low_vram, key: key(provider), budget_gb: self.budget_gb, cuda };
        let mut retried = Vec::new();
        let res = self.pipe.attempts(&ctx, &mut plan, &mut writers, &mut report, &mut sink, &mut |p, _| retried.push((p.chunk, p.stride)));
        // loop: NOT-WORTH — ≤ four writers
        let written = seen.iter().map(|(n, s)| (n.clone(), *s.lock().unwrap())).collect();
        Retried { out: Outcome { res, sink, written }, plan, retried }
    }
}

/// Stage 1 runs out of memory on every window longer than `max` frames.
fn oom_above(max: usize) -> FailRun {
    Arc::new(move |p, shapes| {
        // loop: NOT-WORTH — ≤ six inputs
        let tc = shapes.iter().find(|(n, _)| n == "rgb").map(|(_, s)| s[1]).unwrap_or(0);
        (p == "stage1" && tc > max).then(|| Error::ort("stage1", "CUDA failure 2: out of memory"))
    })
}

fn with_fail(fail: FailRun) -> FakeCfg {
    let mut cfg = FakeCfg::new(SHAPE);
    cfg.fail_run = Some(fail);
    cfg
}

#[test]
fn an_automatic_window_out_of_memory_halves_and_restarts() {
    // loop: NOT-WORTH — both modes
    for low_vram in [false, true] {
        // an automatic window (no hann_chunk / hann_stride / low_vram in the request)
        let mut h = Harness::new(with_fail(oom_above(2)), 10, options(json!({})));
        assert!(!h.job.manual);
        let r = h.attempts(8, 4, low_vram);
        r.out.res.as_ref().unwrap();
        assert_eq!(r.retried, vec![(4, 2), (2, 1)], "low_vram {low_vram}");
        assert_eq!((r.plan.chunk, r.plan.stride, r.plan.low_vram), (2, 1, low_vram), "the window really used");
        assert_eq!(r.out.frames(), vec![10, 10]);
        // the first window of each attempt that failed, then every window of the last one at ≤ 2 frames
        // loop: NOT-WORTH — a test job's runs
        let s1: Vec<usize> = h.loader.runs_of("stage1").iter().map(|r| r.shape("rgb")[1]).collect();
        assert_eq!(s1[..2], [8, 4]);
        assert!(s1[2..].iter().all(|&tc| tc == 2), "{s1:?}");
        // each attempt is the whole job again, from the RVM prepass
        assert_eq!(h.loader.runs_of("rvm").len(), 30);
        let mem = r.out.sink.of_type("memory");
        assert_eq!(mem.len(), 2);
        assert_eq!((mem[0]["hann_chunk"].as_u64(), mem[0]["retry_after_oom"]["hann_chunk"].as_u64()), (Some(4), Some(8)));
        assert_eq!((mem[1]["hann_chunk"].as_u64(), mem[1]["retry_after_oom"]["hann_chunk"].as_u64()), (Some(2), Some(4)));
        assert!(mem[0]["retry_after_oom"]["message"].as_str().unwrap().contains("ran out of memory"));
        // loop: NOT-WORTH — a test job's log lines
        assert!(r.out.sink.logs().iter().any(|l| l.contains("out of graphics memory at window 8/4: retrying at 4/2")));
        // the networks were unloaded between attempts (the next one loads what it needs again)
        // loop: NOT-WORTH — a test job's events
        let loads = h.loader.events().iter().filter(|e| matches!(e, Event::Load("stage1", _))).count();
        assert_eq!(loads, 3);
        assert_eq!(h.temp_files(), Vec::<PathBuf>::new());
    }
}

#[test]
fn a_tensorrt_job_out_of_memory_goes_on_on_cuda_once() {
    // review 2026-10-29 M1: TensorRT's engines hold their range's memory, which a halved window doesn't shrink. The
    // job goes on on CUDA at the same window (once, saying why), then CUDA's own halving as before
    let mut h = Harness::new(with_fail(oom_above(2)), 10, options(json!({})));
    let r = h.attempts_on(Provider::TensorRt, 8, 4, true);
    r.out.res.as_ref().unwrap();
    assert_eq!(r.plan.key.provider, Provider::Cuda);
    assert_eq!(r.retried, vec![(4, 2), (2, 1)], "the switch keeps the window; CUDA halves it");
    // loop: NOT-WORTH — a test job's runs
    let s1: Vec<usize> = h.loader.runs_of("stage1").iter().map(|r| r.shape("rgb")[1]).collect();
    assert_eq!(s1[..3], [8, 8, 4], "TensorRT at 8, CUDA at 8, then 4");
    // (the fake has no TensorRT folder, so its networks' own fallback replies come too: only the switch is counted)
    // loop: NOT-WORTH — a test job's replies
    let prov: Vec<&Value> = r.out.sink.of_type("provider").into_iter().filter(|m| m["fallback_reason"] == TRT_OUT_OF_MEMORY).collect();
    assert_eq!(prov.len(), 1, "one switch");
    assert_eq!(prov[0]["provider"].as_str(), Some("cuda"));
    assert_eq!(r.out.frames(), vec![10, 10]);
}

#[test]
fn the_retry_stops_at_a_one_frame_window() {
    let mut h = Harness::new(with_fail(oom_above(0)), 10, options(json!({})));
    let r = h.attempts(8, 4, false);
    assert_eq!(r.out.res.as_ref().unwrap_err().code, ErrorCode::Oom);
    assert_eq!(r.retried, vec![(4, 2), (2, 1), (1, 1)]);
    assert_eq!(r.plan.chunk, 1);
    // four attempts, each ending at its first window
    assert_eq!(h.loader.runs_of("stage1").len(), 4);
    assert_eq!(r.out.frames(), vec![0, 0]);
}

#[test]
fn a_failure_that_isnt_out_of_memory_is_not_retried() {
    let fail: FailRun = Arc::new(|p, _| (p == "stage1").then(|| Error::ort("stage1", "Invalid input name: rgbx")));
    let mut h = Harness::new(with_fail(fail), 10, options(json!({})));
    let r = h.attempts(8, 4, false);
    assert_eq!(r.out.res.as_ref().unwrap_err().code, ErrorCode::Engine);
    assert_eq!((r.retried.len(), r.plan.chunk, h.loader.runs_of("stage1").len()), (0, 8, 1));
}

#[test]
fn a_window_the_request_set_is_not_retried() {
    let mut h = Harness::new(with_fail(oom_above(2)), 10, options(json!({"hann_chunk": 8, "hann_stride": 4})));
    assert!(h.job.manual);
    let r = h.attempts(8, 4, false);
    assert_eq!(r.out.res.as_ref().unwrap_err().code, ErrorCode::Oom);
    assert_eq!((r.retried.len(), r.plan.chunk, h.loader.runs_of("stage1").len()), (0, 8, 1));
}

#[test]
fn out_of_memory_after_frames_were_written_is_not_retried() {
    // the third window runs out of memory: frames 0-1 are already with the writers, so a smaller window can't
    // start the job over (frames 2-3, blended while the third window ran, would have gone to stage 2 after it)
    let n = std::sync::atomic::AtomicUsize::new(0);
    let fail: FailRun = Arc::new(move |p, _| (p == "stage1" && n.fetch_add(1, Ordering::Relaxed) == 2).then(|| Error::oom("out of memory".into())));
    let mut h = Harness::new(with_fail(fail), 10, options(json!({})));
    let r = h.attempts(4, 2, false);
    assert_eq!(r.out.res.as_ref().unwrap_err().code, ErrorCode::Oom);
    assert_eq!((r.retried.len(), r.plan.chunk), (0, 4));
    assert_eq!(r.out.frames(), vec![2, 2]);
}

/// senior Rust review 2026-10-26 S2: an out-of-memory in a phase the window doesn't size (the RVM prepass; the
/// low-VRAM stage-2 pass) fails at once with its own cause, instead of re-running the job at every halved window
#[test]
fn out_of_memory_outside_the_windows_is_not_retried() {
    let oom_in = |piece: &'static str| -> FailRun { Arc::new(move |p, _| (p == piece).then(|| Error::ort(piece, "CUDA failure 2: out of memory"))) };
    // loop: NOT-WORTH — three cases
    for (piece, low_vram) in [("rvm", false), ("rvm", true), ("stage2", true)] {
        let mut h = Harness::new(with_fail(oom_in(piece)), 10, options(json!({})));
        let r = h.attempts(8, 4, low_vram);
        let e = r.out.res.as_ref().unwrap_err();
        assert_eq!(e.code, ErrorCode::Oom, "{piece} low_vram {low_vram}");
        assert!(e.message.contains(&format!("ran out of memory ({piece})")), "{}", e.message);
        assert_eq!((r.retried.clone(), r.plan.chunk), (vec![], 8), "{piece} low_vram {low_vram}");
        assert_eq!(r.out.sink.of_type("memory").len(), 0);
        // one attempt: its RVM pass ran once (or failed at its first frame)
        assert!(h.loader.runs_of("rvm").len() <= 10, "{piece} low_vram {low_vram}");
    }
}

/// S2: in the normal mode stage 2 runs inside the windows (its memory shares the card with the window's), so its
/// out-of-memory before any frame was written still halves the window
#[test]
fn normal_mode_stage2_out_of_memory_in_the_windows_is_retried() {
    let n = std::sync::atomic::AtomicUsize::new(0);
    let fail: FailRun = Arc::new(move |p, _| (p == "stage2" && n.fetch_add(1, Ordering::Relaxed) == 0).then(|| Error::oom("out of memory".into())));
    let mut h = Harness::new(with_fail(fail), 10, options(json!({})));
    let r = h.attempts(8, 4, false);
    r.out.res.as_ref().unwrap();
    assert_eq!(r.retried, vec![(4, 2)]);
    assert_eq!(r.out.frames(), vec![10, 10]);
}

/// perf review 2026-10-29 S5: a network loading behind the RVM pass (normal mode, CUDA) that runs out of memory fails
/// the job at once with its own cause: the loads are taken before the windows, so a smaller window isn't tried
#[test]
fn out_of_memory_in_a_load_behind_the_rvm_pass_is_not_retried() {
    let mut cfg = FakeCfg::new(SHAPE);
    cfg.fail_load = Some(Arc::new(|p, prov| (p == "stage2" && prov == Provider::Cuda).then(|| Error::oom("loading stage2: out of memory".into()))));
    let mut h = Harness::new(cfg, 10, options(json!({})));
    let r = h.attempts_on(Provider::Cuda, 8, 4, false);
    let e = r.out.res.as_ref().unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Oom, "loading stage2: out of memory"));
    assert!(r.retried.is_empty(), "{:?}", r.retried);
    assert_eq!(r.plan.chunk, 8);
    assert_eq!(r.out.sink.of_type("memory").len(), 0);
    assert!(h.loader.runs_of("stage1").is_empty(), "no window ran");
    // the loads ran behind the RVM pass (their own threads), and the RVM pass ran once
    // loop: NOT-WORTH — ≤ five loads
    assert!(h.loader.threads.lock().unwrap().iter().any(|(p, t)| *p == "stage1" && t == "load-stage1"));
    assert_eq!(h.loader.runs_of("rvm").len(), 10);
}
