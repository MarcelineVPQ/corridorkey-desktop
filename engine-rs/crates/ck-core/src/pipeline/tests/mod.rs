//! The pipeline's own tests. Whole jobs run on fakes (tests/fakes.rs): fake networks (shaped values made from their
//! inputs), frames made in memory, in-memory writers; no ONNX Runtime session, ffmpeg or graphics card. Temporary
//! files (the RVM features, the low-VRAM states and foundation features) go to a scratch folder per test.
mod fakes;
mod jobs;
mod retry;

use super::*;
use crate::clip::ClipMeta;
use crate::hann::{taper_weights, window_starts};
use crate::runtime::Data;
use fakes::*;
use keying::hint_window;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

#[test]
fn a_job_never_builds_tensorrt_when_told_not_to() {
    let range = |built| TrtRange {
        bucket: crate::tensorrt::bucket_for(2176, 4096, 8, true).unwrap(),
        card_dir: PathBuf::from("/c"),
        dir: PathBuf::from("/c/r"),
        built,
    };
    // built: used either way; not built: built by the job only when it may build (the app's jobs may not)
    assert!(trt_job_may_use(range(true), false).is_ok());
    assert!(trt_job_may_use(range(false), true).is_ok_and(|r| !r.built));
    assert_eq!(trt_job_may_use(range(false), false).err().as_deref(), Some(TRT_NOT_BUILT));
}

#[test]
fn a_size_built_for_another_window_says_so() {
    // bug hunt 2026-10-26 T1: the HD range built at window 24 (the app's background build), a short clip's automatic
    // window 80; the job ran on CUDA saying the range "isn't built yet"
    let b = crate::tensorrt::bucket_for(1152, 1920, 80, false).unwrap();
    let names: Vec<String> = [
        "h1024-1280_w1792-2176_t1-24_f1-4",
        "h1024-1280_w1792-2176_t1-8_f1-4",
        "h1024-1280_w1792-2176_t1-80_f1-80",
        "h1792-2176_w3584-4096_t1-8_f1-4",
        "h1024-1280_w1792-2176_t1-48_f1-4",
    ]
    .map(String::from)
    .to_vec();
    // the 48 folder is a build that didn't finish; the 80 folder is the job's own range (not built: it's why we're here)
    let windows = other_windows(&b, &names, |n| !n.contains("_t1-48_"));
    assert_eq!(windows, vec![8, 24]);
    assert_eq!(trt_other_window(&windows, 80), "TensorRT for this resolution is built for a window of 8 or 24 frames; this job's automatic window is 80");
    assert!(other_windows(&b, &names[3..4], |_| true).is_empty(), "another size's range doesn't count");
}

#[test]
fn a_build_covers_the_card_not_the_moment() {
    // 1.0.0-dev.7 item 1: a build made while another program used the card came out "t1-2" and jobs at window 4 ran
    // on CUDA. The build's window comes from the card's total memory only (no free-memory reading goes in), so it is
    // the same every time on one card, and a larger card gets the larger window. Fake cards of 8, 16 and 32 GiB.
    let hd = (1152, 1920);
    let k4 = (2176, 4096);
    // 1280x1080 (the 1.6 MP range, measured at 48 on 2026-10-24)
    let mp16 = (1152, 1280);
    let w = |shape, total| trt_build_profile(shape, 1000, total, None).chunk;
    assert_eq!([w(hd, 8.0), w(hd, 16.0), w(hd, 32.0)], [BUILD_HD.0, BUILD_HD.1, BUILD_HD.2]);
    assert_eq!([w(k4, 8.0), w(k4, 16.0), w(k4, 32.0)], [BUILD_4K.0, BUILD_4K.1, BUILD_4K.2]);
    // review 2026-10-29 N-M1: Marcy's 16 GB card builds each measured size's measured window
    assert_eq!([w(mp16, 16.0), w(hd, 16.0), w(k4, 16.0)], [48, 24, 8]);
    // review 2026-10-29 R2-S2: the known gaps on a free 16 GiB card, pinned, so a change can't widen or hide them: the
    // clip lengths (1-200 frames) that run more frames at a time than the card's build of their size, so on CUDA with
    // their reason (trt_serving). 1280x1080: 49-64 frames run all their frames at once, past the measured 48 (65-79 pick
    // 48: the 80 window doesn't fit). The 1440p-class sizes, never measured, are kept within the 4K build's pixels x
    // frames (2560x1440 15, 2560x1080 and 1920x1440 19) under the card's window of 24, so every clip longer than that
    // runs on CUDA until a build of their size is measured (a GPU check with Marcy).
    let (p1440, uw, p1920) = ((1536, 2560), (1152, 2560), (1536, 1920));
    let cuda = |shape| -> Vec<usize> { (1..=200).filter(|&f| select_vram_profile(shape, f, 16.0, false, true).chunk.min(f) > w(shape, 16.0)).collect() };
    let from = |a: usize, b: usize| (a..=b).collect::<Vec<_>>();
    assert_eq!(cuda(mp16), from(49, 64));
    assert_eq!((cuda(hd), cuda(k4)), (vec![], vec![]));
    assert_eq!([w(p1440, 16.0), w(uw, 16.0), w(p1920, 16.0)], [15, 19, 19]);
    assert_eq!([cuda(p1440), cuda(uw), cuda(p1920)], [from(16, 200), from(20, 200), from(20, 200)]);
    // the frames a job on that card runs per window (its window, capped at a short clip's length), whatever is free
    // (free + own <= total), are never more: on 8 and 16 GB cards always, but for the 1280x1080 gap above (a decision for
    // Marcy). On 32 GB, past the measured builds (CUDA, trt_serving)
    // loop: NOT-WORTH — a test's three cards x three sizes x a few budgets and clip lengths
    for total in [8.0, 16.0, 32.0] {
        // loop: NOT-WORTH — as above
        for shape in [mp16, hd, k4] {
            let built = trt_build_profile(shape, 1000, total, None);
            assert!(built.low_vram, "TensorRT builds keep low-VRAM mode");
            // loop: NOT-WORTH — as above
            for free in [total * 0.2, total * 0.5, total * 0.9, total] {
                // loop: NOT-WORTH — as above
                for frames in [3, 12, 30, 50, 1000] {
                    let ran = select_vram_profile(shape, frames, free, false, true).chunk.min(frames);
                    let gap = ran > measured(shape) && (total > 16.0 || (ran == frames && shape == mp16 && (49..=64).contains(&frames)));
                    assert!(ran <= built.chunk || gap, "{shape:?} {total} GiB card, {free} GiB free, {frames} frames");
                }
            }
        }
    }
    // a graphics-memory limit caps it as it caps a job
    let capped = trt_build_profile(hd, 1000, 32.0, Some(8.0)).chunk;
    assert!(capped >= select_vram_profile(hd, 1000, 8.0, true, true).chunk && capped < w(hd, 32.0), "{capped}");
}

// the build windows the table gives fake 8, 16 and 32 GiB cards (vram.rs, low-VRAM mode): the longest window whose peak
// fits the card, never past the window measured to build at that size (reviews 2026-10-29 M2, N-M1: tensorrt::build_cap,
// 4K 8 and HD 24; the table alone gave a 32 GiB card HD 56 and 4K 16, unmeasured builds)
const BUILD_HD: (usize, usize, usize) = (8, 24, 24);
const BUILD_4K: (usize, usize, usize) = (2, 8, 8);

/// tensorrt::build_cap for a padded shape's range.
fn measured(shape: (usize, usize)) -> usize {
    crate::tensorrt::build_cap(&crate::tensorrt::bucket_for(shape.0, shape.1, 1, true).unwrap()).0
}

#[test]
fn a_longer_range_is_used_only_when_its_memory_fits() {
    // review 2026-10-29 M1: a busy card's HD job picks window 8; the card's build is t1-24. Its engines may hold the
    // memory of 24 frames, so the job takes them only when a job at window 24 would fit its budget; else CUDA, with
    // a reason no build fixes (the app offers none)
    let hd = (1152, 1920);
    let mp = (hd.0 * hd.1) as f64 / 1e6;
    let names = vec!["h1024-1280_w1792-2176_t1-24_f1-4".to_string()];
    let need = crate::tensorrt::bucket_for(hd.0, hd.1, 8, true).unwrap();
    let all = |_: &str| true;
    // budgets where the job's own window is 8 and where it is 24 (the table's, fake cards)
    // loop: NOT-WORTH — a test's 200 budgets
    let at = |w: usize| (10..210).map(|t| t as f64 / 10.0).find(|&b| select_vram_profile(hd, 1000, b, false, true).chunk == w).unwrap();
    let (busy, free) = (at(8), at(24));
    let why = trt_serving(&need, &names, all, mp, true, Some((busy, None))).unwrap_err();
    assert!(why.starts_with(TRT_CARD_BUSY) && why.ends_with("so this run used CUDA"), "{why}");
    // no number presented as TensorRT's own need (it is CUDA's table at that window: review N-N1)
    assert!(!why.contains("needs about"), "{why}");
    // a limit above the free memory: still the card (review N-S1)
    assert!(trt_serving(&need, &names, all, mp, true, Some((busy, Some(busy + 4.0)))).unwrap_err().starts_with(TRT_CARD_BUSY));
    // the job's own limit is the smaller: it says so, and how to raise it, never that another program holds the card
    let why = trt_serving(&need, &names, all, mp, true, Some((busy, Some(busy)))).unwrap_err();
    assert!(why.starts_with(TRT_LIMIT_TOO_SMALL) && why.contains("raise Memory limit") && !why.contains("busy"), "{why}");
    assert_eq!(trt_serving(&need, &names, all, mp, true, Some((free, None))).unwrap().map(|b| b.key()).as_deref(), Some(names[0].as_str()));
    // a manual window (no budget): any range that serves it
    assert!(trt_serving(&need, &names, all, mp, true, None).unwrap().is_some());
    // nothing built: a build serves it
    assert_eq!(trt_serving(&need, &[], all, mp, true, Some((busy, None))), Ok(None));
    // more frames at a time than any build of the size is made for: CUDA, and no build offered (it would not serve it)
    let long = crate::tensorrt::bucket_for(hd.0, hd.1, 48, true).unwrap();
    let why = trt_serving(&long, &[], all, mp, true, Some((40.0, None))).unwrap_err();
    assert!(
        why.starts_with(&format!("{TRT_BUILD_CAP} 24 frames at a time (the longest build measured at this size)")) && !why.starts_with(TRT_CARD_BUSY),
        "{why}"
    );
    // a size never measured says so (1440p: within the 4K build)
    let qhd = crate::tensorrt::bucket_for(1536, 2560, 24, true).unwrap();
    let why = trt_serving(&qhd, &[], all, 1536.0 * 2560.0 / 1e6, true, Some((40.0, None))).unwrap_err();
    assert!(why.contains("this size isn't measured yet") && why.contains("this clip runs 24 at a time"), "{why}");
}

#[test]
fn a_job_uses_a_built_range_at_any_smaller_window() {
    // a range built for windows 1..N serves every window up to N (same size; the foundations' batch inside it too)
    let names: Vec<String> = [
        "h1792-2176_w3584-4096_t1-8_f1-4",
        "h1024-1280_w1792-2176_t1-24_f1-4",
        "h1024-1280_w1792-2176_t1-48_f1-4",
        "h1024-1280_w1792-2176_t1-80_f1-4",
        "not-a-range",
    ]
    .map(String::from)
    .to_vec();
    let all = |_: &str| true;
    let key =
        |shape: (usize, usize), window, low| serving_range(&crate::tensorrt::bucket_for(shape.0, shape.1, window, low).unwrap(), &names, all).map(|b| b.key());
    // loop: NOT-WORTH — a test's eight windows
    for window in 1..=8 {
        assert_eq!(key((2176, 4096), window, true).as_deref(), Some("h1792-2176_w3584-4096_t1-8_f1-4"), "4K window {window}");
    }
    assert_eq!(key((2176, 4096), 16, true), None, "a longer window than any built");
    // the smallest that serves (the least memory); one not built doesn't count
    assert_eq!(key((1152, 1920), 8, true).as_deref(), Some("h1024-1280_w1792-2176_t1-24_f1-4"));
    assert_eq!(key((1152, 1920), 40, true).as_deref(), Some("h1024-1280_w1792-2176_t1-48_f1-4"));
    let need = crate::tensorrt::bucket_for(1152, 1920, 40, true).unwrap();
    assert_eq!(serving_range(&need, &names, |n| !n.contains("_t1-48_")).map(|b| b.key()).as_deref(), Some("h1024-1280_w1792-2176_t1-80_f1-4"));
    // the normal mode runs the foundations over the whole window: a low-VRAM range (batches of 4) serves it only up to 4
    assert_eq!(key((1152, 1920), 8, false), None);
    assert_eq!(key((1152, 1920), 4, false).as_deref(), Some("h1024-1280_w1792-2176_t1-24_f1-4"));
    // another size's range never serves
    assert_eq!(key((768, 1024), 4, true), None);
    // the card's own build serves every window a job on that card picks (as trt_range asks: the window capped at the
    // clip's frames), for each fake card, whatever is free and however long the clip
    // loop: NOT-WORTH — a test's three cards x two sizes x a few budgets and clip lengths
    for total in [8.0, 16.0, 32.0] {
        // loop: NOT-WORTH — as above
        for shape in [(1152, 1280), (1152, 1920), (2176, 4096)] {
            let b = trt_build_profile(shape, 1000, total, None);
            let built = vec![crate::tensorrt::bucket_for(shape.0, shape.1, b.chunk, b.low_vram).unwrap().key()];
            // loop: NOT-WORTH — as above
            for free in [total * 0.3, total * 0.6, total] {
                // loop: NOT-WORTH — as above
                for frames in [3, 12, 50, 1000] {
                    let p = select_vram_profile(shape, frames, free, false, true);
                    let need = crate::tensorrt::bucket_for(shape.0, shape.1, p.chunk.min(frames), p.low_vram).unwrap();
                    // (past the measured builds, CUDA: a 32 GiB card's HD 48, and on 16 GiB only the 1280x1080 gap of 49-64 frames,
                    // a_build_covers_the_card_not_the_moment)
                    let short = need.t.1 == frames && shape == (1152, 1280) && (49..=64).contains(&frames);
                    let served = serving_range(&need, &built, all).is_some() || (need.t.1 > measured(shape) && (total > 16.0 || short));
                    assert!(served, "{shape:?} {total} GiB card, window {}, {frames} frames", p.chunk);
                }
            }
        }
    }
}

#[test]
fn a_png_says_its_bit_depth() {
    // bug hunt 2026-10-26 I11: a 16-bit PNG folder now says at which depth it is read, as a deep video does
    let d = scratch("png-depth");
    let mut head = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR\0\0\0\x04\0\0\0\x04".to_vec();
    head.push(16);
    std::fs::write(d.0.join("a.png"), &head).unwrap();
    head[24] = 8;
    std::fs::write(d.0.join("b.png"), &head).unwrap();
    std::fs::write(d.0.join("c.exr"), b"v/1\x01 not a png at all").unwrap();
    assert_eq!(png_bit_depth(&d.0.join("a.png")), Some(16));
    assert_eq!(png_bit_depth(&d.0.join("b.png")), Some(8));
    assert_eq!(png_bit_depth(&d.0.join("c.exr")), None);
    assert_eq!(png_bit_depth(&d.0.join("missing.png")), None);
}

/// A scratch folder, removed with everything in it when dropped.
struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch(tag: &str) -> Dir {
    static N: AtomicUsize = AtomicUsize::new(0);
    let p = std::env::temp_dir().join(format!("ck-pipeline-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&p).unwrap();
    Dir(p)
}

/// A models folder of empty files (the fake loader doesn't read them; the pipeline only looks them up).
fn fake_models(dir: &Path) -> ModelSet {
    let m = dir.join("models");
    std::fs::create_dir_all(&m).unwrap();
    // loop: NOT-WORTH — five empty files
    for p in crate::runtime::PIECES {
        std::fs::write(m.join(format!("{p}_fp32.onnx")), b"").unwrap();
    }
    ModelSet::open(&m).unwrap()
}

fn key(provider: Provider) -> ModelKey {
    ModelKey { provider, precision: Precision::Fp32, trt_cache: None, vram_cap: None, coreml: None }
}

/// The test clip's model shape: not square, so a swapped height and width shows.
const SHAPE: (usize, usize) = (128, 192);

/// A pipeline on fake networks and a job over `n` fake frames with `options` (the protocol's run options).
struct Harness {
    pipe: Pipeline<FakeLoader>,
    loader: FakeLoader,
    frames: FakeFrames,
    job: JobConfig,
    /// the job's sink asks it to stop at this stop point (RecSink::stop_at)
    stop_at: Option<usize>,
    /// the automatic window's budget (JobPlan::budget_gb): the RTX 5080's 13.08 GB unless a test sets another
    budget_gb: Option<f64>,
    /// the scratch folder (models, temp, out), removed with the harness
    _dir: Dir,
}

/// What each in-memory writer is handed, by output name.
type Seen = Vec<(String, Arc<Mutex<Written>>)>;

/// What a job left: its result, every reply, and what each writer was handed.
struct Outcome {
    res: Result<(), Error>,
    sink: RecSink,
    written: Vec<(String, Written)>,
}

impl Outcome {
    fn frames(&self) -> Vec<usize> {
        // loop: NOT-WORTH — ≤ four writers
        self.written.iter().map(|(_, w)| w.frames).collect()
    }
}

impl Harness {
    fn new(cfg: FakeCfg, n: usize, options: Value) -> Harness {
        let dir = scratch("job");
        let job = crate::job::parse(&json!({
            "id": "t", "input": "/mem/clip", "output_dir": dir.0.join("out"), "temp_dir": dir.0.join("tmp"), "options": options
        }))
        .unwrap();
        std::fs::create_dir_all(&job.temp_dir).unwrap();
        let loader = FakeLoader::new(cfg);
        let pipe = Pipeline::with_loader(loader.clone(), fake_models(&dir.0), ArenaShrink::Auto);
        Harness { pipe, loader, frames: FakeFrames { n, first: 0, shape: SHAPE, fail_at: None }, job, stop_at: None, budget_gb: Some(13.08), _dir: dir }
    }

    fn writers(&self) -> (crate::outputs::Writers, Seen) {
        let (mut ws, mut seen) = (Vec::new(), Vec::new());
        // loop: NOT-WORTH — ≤ four outputs
        for name in &self.job.outputs {
            let (w, s) = MemWriter::new(name);
            ws.push((name.clone(), Box::new(w) as Box<dyn Writer>));
            seen.push((name.clone(), s));
        }
        (ws, seen)
    }

    /// Steps 2-4 once (no retry) at `chunk` / `stride`.
    fn keying(&mut self, key: &ModelKey, trt: Option<&dyn Fn(&str) -> TrtSettings>, chunk: usize, stride: usize, low_vram: bool) -> Outcome {
        let meta = self.frames.meta();
        self.keying_meta(&meta, key, trt, chunk, stride, low_vram)
    }

    /// Steps 2-4 once on `meta` (a ranged job's: `ClipMeta::select_range`), the frames from `self.frames`.
    fn keying_meta(
        &mut self,
        meta: &ClipMeta,
        key: &ModelKey,
        trt: Option<&dyn Fn(&str) -> TrtSettings>,
        chunk: usize,
        stride: usize,
        low_vram: bool,
    ) -> Outcome {
        let (mut writers, seen) = self.writers();
        let mut report = FrameReport { total: meta.write_range().len(), last_sent: None, last_done: None };
        let mut sink = RecSink { stop_at: self.stop_at, ..RecSink::default() };
        let ctx = JobCtx::new(&self.job, meta, &self.frames, trt, "clip");
        let plan = JobPlan { chunk, stride, low_vram, key: key.clone(), budget_gb: self.budget_gb, cuda: None };
        let res = self.pipe.keying(&ctx, &plan, &mut writers, &mut report, &mut sink, &mut false);
        // loop: NOT-WORTH — ≤ four writers
        let written = seen.iter().map(|(n, s)| (n.clone(), *s.lock().unwrap())).collect();
        Outcome { res, sink, written }
    }

    /// The job's temporary folder's files.
    fn temp_files(&self) -> Vec<PathBuf> {
        // loop: NOT-WORTH — a test job's few temp files
        std::fs::read_dir(&self.job.temp_dir).map(|d| d.filter_map(|e| e.ok().map(|e| e.path())).collect()).unwrap_or_default()
    }
}

/// One number for a job: every network run (network, inputs) in order, then what each writer was handed.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn digest(loader: &FakeLoader, out: &Outcome) -> u64 {
    let mut h = Fnv::new();
    // loop: NOT-WORTH — a test job's runs
    for r in loader.runs() {
        h.bytes(r.piece.as_bytes());
        h.u64(r.hash);
    }
    // loop: NOT-WORTH — ≤ four writers
    for (n, w) in &out.written {
        h.bytes(n.as_bytes());
        h.u64(w.frames as u64);
        h.u64(w.hash);
    }
    h.0
}

fn options(extra: Value) -> Value {
    let mut o = json!({"outputs": ["alpha", "fg"], "output_format": "exr", "exr_dtype": "float"});
    // loop: NOT-WORTH — a few options
    for (k, v) in extra.as_object().unwrap() {
        o[k] = v.clone();
    }
    o
}

#[test]
fn the_hint_made_in_the_graphs_type_is_the_same_tensor() {
    // three frames of 5 values: a matte, none, a matte; the old way made a float32 window and converted it
    let plane = 5;
    let a: Vec<f32> = vec![0.0, 0.25, 0.5039, 1.0, 0.123];
    let b: Vec<f32> = vec![1.0, 0.0, 0.33, 0.66, 0.999];
    let src = vec![Some(&a[..]), None, Some(&b[..])];
    let mut old = vec![0f32; 3 * plane];
    old[..plane].copy_from_slice(&a);
    old[2 * plane..].copy_from_slice(&b);
    let new16 = hint_window(&src, plane, half::f16::from_f32);
    let old16 = Data::F32(old.clone()).into_f16();
    // loop: NOT-WORTH — fifteen values
    assert_eq!(new16.iter().map(|x| x.to_bits()).collect::<Vec<_>>(), old16.iter().map(|x| x.to_bits()).collect::<Vec<_>>());
    assert_eq!(hint_window(&src, plane, |v| v), old);
    // a window without mattes: the shared zeros are the same as a fresh zero window
    let zeros = vec![half::f16::ZERO; 4 * plane];
    assert_eq!(Data::F16Ref(&zeros[..3 * plane]).into_f16(), Data::F32(vec![0f32; 3 * plane]).into_f16());
}

#[test]
fn an_unmeasurable_context_is_not_counted_as_0() {
    // senior review 2026-10-27 S3: C-RADIO first (its fp32 file loads as fp16, smaller on the card) gave Some(0), and
    // a later low-VRAM job's arenas left no room for the CUDA context; None keeps arena_limit's 0.5 GiB default
    assert_eq!(overhead_outside_weights(1_500 << 20, 1_725_204_048), None);
    assert_eq!(overhead_outside_weights(1_300 << 20, 926_574_332), Some((1_300 << 20) - 926_574_332));
    assert_eq!(overhead_outside_weights(7, 7), Some(0));
}

#[test]
fn tensorrt_cache_root_per_system() {
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        // loop: NOT-WORTH — a test's two or three variables
        move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    };
    // loop: NOT-WORTH — a path's few parts
    let j = |parts: &[&str]| parts.iter().collect::<PathBuf>();
    // the app's folder wins everywhere
    assert_eq!(trt_root_for("windows", env(&[("CK_ENGINE_TRT_CACHE", "/app/cache/tensorrt"), ("LOCALAPPDATA", "C:/L")])), j(&["/app/cache/tensorrt"]));
    assert_eq!(trt_root_for("linux", env(&[("XDG_CACHE_HOME", "/x"), ("HOME", "/h")])), j(&["/x", "corridorkey-desktop", "tensorrt"]));
    assert_eq!(trt_root_for("linux", env(&[("XDG_CACHE_HOME", ""), ("HOME", "/h")])), j(&["/h", ".cache", "corridorkey-desktop", "tensorrt"]));
    assert_eq!(trt_root_for("windows", env(&[("LOCALAPPDATA", "C:/L"), ("HOME", "/h")])), j(&["C:/L", "corridorkey-desktop", "cache", "tensorrt"]));
    assert_eq!(trt_root_for("windows", env(&[("USERPROFILE", "C:/U")])), j(&["C:/U", "AppData", "Local", "corridorkey-desktop", "cache", "tensorrt"]));
    assert_eq!(
        trt_root_for("macos", env(&[("HOME", "/Users/m"), ("XDG_CACHE_HOME", "/x")])),
        j(&["/Users/m", "Library", "Caches", "corridorkey-desktop", "tensorrt"])
    );
}

/// A job's runs and outputs, pinned: the fake job's every network input and every value handed to the writers,
/// in order, in both modes and both precisions. A refactor of the pipeline must leave these numbers as they are;
/// they change only when the pipeline's data flow (or the fakes) change on purpose.
/// Pinned per system: macOS gives other last bits than Linux in all four (CI, 2026-10-25), most likely its own
/// cos/powf (the Hann ramp, sRGB), not measured. Windows has no values yet, so the test doesn't run there.
/// The all-loaded values changed with the pipelining pass (backlog row 182): the run order (a window's final frames
/// reach stage 2 after the next window's stage 1) and C-RADIO / MoGe running only on a window's new frames (their
/// batches); stage 1's and stage 2's inputs and the writers' values are the same, as the low-VRAM values (unchanged)
/// and `low_vram_gives_the_same_stage_inputs_and_outputs_as_all_loaded` show. The macOS all-loaded values were re-pinned
/// on the Mac mini M6 (2026-10-29, engine f4ad15c; the low-VRAM values printed there unchanged).
#[cfg(target_os = "linux")]
const GOLDEN: [(bool, bool, u64); 4] =
    [(false, true, 0xdcb370e41e1092f1), (true, true, 0xcfba85519ddc2a58), (false, false, 0xb94d059ac599c7b1), (true, false, 0x3ef929924fac70f3)];
#[cfg(target_os = "macos")]
const GOLDEN: [(bool, bool, u64); 4] =
    [(false, true, 0x3f8785637d7d3b43), (true, true, 0x84a03419b0a788fa), (false, false, 0xfc422bd052fb37c5), (true, false, 0xf3d3acc57d5890b3)];

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn a_fake_job_is_pinned_in_both_modes_and_precisions() {
    let mut got = Vec::new();
    // loop: NOT-WORTH — four combinations
    for (low_vram, half, _) in GOLDEN {
        let mut cfg = FakeCfg::new(SHAPE);
        cfg.half = half;
        let mut h = Harness::new(cfg, 9, options(json!({"hann_chunk": 4, "hann_stride": 2})));
        // low-VRAM on CUDA: the next phase's networks load ahead on their own threads
        let k = key(if low_vram { Provider::Cuda } else { Provider::Cpu });
        let out = h.keying(&k, None, 4, 2, low_vram);
        out.res.as_ref().unwrap();
        assert_eq!(out.frames(), vec![9, 9]);
        got.push((low_vram, half, digest(&h.loader, &out)));
    }
    println!("{got:#x?}");
    assert_eq!(got, GOLDEN);
}

#[test]
fn low_vram_gives_the_same_stage_inputs_and_outputs_as_all_loaded() {
    // loop: NOT-WORTH — both precisions and the mixed set
    for (half, mixed) in [(true, false), (false, false), (true, true)] {
        let run = |low_vram: bool| {
            let mut cfg = FakeCfg::new(SHAPE);
            cfg.half = half;
            cfg.mixed = mixed;
            let mut h = Harness::new(cfg, 9, options(json!({"hann_chunk": 4, "hann_stride": 2})));
            let out = h.keying(&key(Provider::Cpu), None, 4, 2, low_vram);
            out.res.as_ref().unwrap();
            // loop: NOT-WORTH — a test job's runs
            let hashes = |p: &str| h.loader.runs_of(p).iter().map(|r| r.hash).collect::<Vec<_>>();
            (hashes("rvm"), hashes("stage1"), hashes("stage2"), out.written)
        };
        let (all, low) = (run(false), run(true));
        assert_eq!(all.0, low.0, "RVM inputs (half {half}, mixed {mixed})");
        assert_eq!(all.1, low.1, "stage 1 inputs (half {half}, mixed {mixed})");
        assert_eq!(all.2, low.2, "stage 2 inputs (half {half}, mixed {mixed})");
        assert_eq!(all.3, low.3, "the writers' frames (half {half}, mixed {mixed})");
        assert_eq!(all.2.len(), 9);
    }
}

/// The mixed-precision set (2.0.0-onnx.4 on: MoGe, RVM and the features float32, stage 1's frames and hints and
/// stage 2's frame float16, outputs in either type): every network gets its inputs in the type it takes. RVM and
/// the foundations take and make float32 exactly as in the float32 set, so their runs are the float32 job's.
#[test]
fn a_mixed_precision_set_feeds_each_input_in_its_own_type() {
    let run = |half: bool, mixed: bool| {
        let mut cfg = FakeCfg::new(SHAPE);
        cfg.half = half;
        cfg.mixed = mixed;
        let mut h = Harness::new(cfg, 9, options(json!({"hann_chunk": 4, "hann_stride": 2})));
        let out = h.keying(&key(Provider::Cuda), None, 4, 2, true);
        out.res.as_ref().unwrap();
        assert_eq!(out.frames(), vec![9, 9]);
        let runs = h.loader.runs();
        (runs, out.written)
    };
    let (mixed, _) = run(true, true);
    let (f32s, _) = run(false, false);
    let (f16s, _) = run(true, false);
    // loop: NOT-WORTH — a test job's runs
    let hashes = |r: &[Run], p: &str| r.iter().filter(|x| x.piece == p).map(|x| x.hash).collect::<Vec<_>>();
    // loop: NOT-WORTH — three networks
    for p in ["rvm", "cradio", "moge"] {
        assert_eq!(hashes(&mixed, p), hashes(&f32s, p), "{p}: float32 inputs as in the float32 set");
        assert_ne!(hashes(&mixed, p), hashes(&f16s, p), "{p}: not rounded to float16");
    }
    assert_eq!(hashes(&mixed, "stage1").len(), hashes(&f16s, "stage1").len());
    assert_eq!(hashes(&mixed, "stage2").len(), 9);
}

#[test]
fn an_unknown_own_memory_reading_unloads_the_networks_first() {
    // review 2026-10-27 MUST: on Windows (WDDM) NVML can't report this process's memory, so from the second automatic
    // job on its loaded networks counted as another program's (a smaller window)
    let mut h = Harness::new(FakeCfg::new(SHAPE), 1, options(json!({})));
    let net = h.loader.load("rvm", Provider::Cuda, std::path::Path::new("/m"), None).unwrap();
    h.pipe.nets.insert("rvm", net);
    let (loader, reads) = (h.loader.clone(), std::cell::Cell::new(0));
    // 2 GiB free while the network is loaded (it holds 4), 6 GiB once it is dropped
    let read = |own: Option<u64>| {
        reads.set(reads.get() + 1);
        let dropped = loader.events().iter().any(|e| matches!(e, Event::Drop("rvm")));
        let free: u64 = if dropped { 6 << 30 } else { 2 << 30 };
        Some((free + own.unwrap_or(0), free, own))
    };
    // own memory known: one reading, the network stays
    assert_eq!(h.pipe.budget_from(|| read(Some(4 << 30))), Some(6 << 30));
    assert_eq!((reads.get(), h.pipe.nets.len()), (1, 1));
    // unknown: the network is dropped first, and the reading sees its memory free
    assert_eq!(h.pipe.budget_from(|| read(None)), Some(6 << 30));
    assert_eq!((reads.get(), h.pipe.nets.len()), (3, 0));
}

#[test]
fn a_clip_shorter_than_every_core_ml_window_is_refused_in_words() {
    // review 2026-10-27: a 1-3 frame clip on Core ML failed "pick a window it was built for"
    let e = coreml_short_clip(2, 8, &[8, 16]).unwrap();
    assert!(e.starts_with("this clip has 2 frame(s), fewer than the Core ML set's smallest window (8 frames)"), "{e}");
    // a window the set has, a clip at least as long as the window, or no set: not this message
    assert_eq!(coreml_short_clip(2, 8, &[2, 8]), None);
    assert_eq!(coreml_short_clip(8, 8, &[8]), None);
    assert_eq!(coreml_short_clip(2, 8, &[]), None);
}

#[test]
fn the_exr_warning_names_real_settings() {
    // final review 2026-10-28 N8: it said "pass --frame_dir_linear", a flag neither the app nor the CLI has
    assert!(!EXR_LINEAR_HINT.contains("--frame_dir_linear"), "{EXR_LINEAR_HINT}");
    assert!(EXR_LINEAR_HINT.contains("Frames are scene-linear") && EXR_LINEAR_HINT.contains("--linear"), "{EXR_LINEAR_HINT}");
}
