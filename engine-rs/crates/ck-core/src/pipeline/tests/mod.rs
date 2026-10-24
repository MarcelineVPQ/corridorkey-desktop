//! The pipeline's own tests. Whole jobs run on fakes (tests/fakes.rs): fake networks (shaped values made from their
//! inputs), frames made in memory, in-memory writers; no ONNX Runtime session, ffmpeg or graphics card. Temporary
//! files (the RVM features, the low-VRAM states and foundation features) go to a scratch folder per test.
mod fakes;
mod jobs;

use super::*;
use crate::hann::{taper_weights, window_starts};
use crate::runtime::Data;
use fakes::*;
use keying::hint_window;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

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
    ModelKey { provider, precision: Precision::Fp32, trt_cache: None, vram_cap: None }
}

/// The test clip's model shape: not square, so a swapped height and width shows.
const SHAPE: (usize, usize) = (128, 192);

/// A pipeline on fake networks and a job over `n` fake frames with `options` (the protocol's run options).
struct Harness {
    pipe: Pipeline<FakeLoader>,
    loader: FakeLoader,
    frames: FakeFrames,
    job: JobConfig,
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
        Harness { pipe, loader, frames: FakeFrames { n, shape: SHAPE, fail_at: None }, job, _dir: dir }
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
        let (mut writers, seen) = self.writers();
        let mut report = FrameReport { total: meta.num_frames, last_sent: None, last_done: None };
        let mut sink = RecSink::default();
        let ctx = JobCtx::new(&self.job, &meta, &self.frames, trt, "clip");
        let plan = JobPlan { chunk, stride, low_vram, key: key.clone() };
        let res = self.pipe.keying(&ctx, &plan, &mut writers, &mut report, &mut sink);
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
const GOLDEN: [(bool, bool, u64); 4] =
    [(false, true, 0x265571e2e192f112), (true, true, 0xcfba85519ddc2a58), (false, false, 0xa666b7b72d4a6ab3), (true, false, 0x3ef929924fac70f3)];

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
    assert_eq!(got, GOLDEN.to_vec());
}

#[test]
fn low_vram_gives_the_same_stage_inputs_and_outputs_as_all_loaded() {
    // loop: NOT-WORTH — both precisions
    for half in [true, false] {
        let run = |low_vram: bool| {
            let mut cfg = FakeCfg::new(SHAPE);
            cfg.half = half;
            let mut h = Harness::new(cfg, 9, options(json!({"hann_chunk": 4, "hann_stride": 2})));
            let out = h.keying(&key(Provider::Cpu), None, 4, 2, low_vram);
            out.res.as_ref().unwrap();
            // loop: NOT-WORTH — a test job's runs
            let hashes = |p: &str| h.loader.runs_of(p).iter().map(|r| r.hash).collect::<Vec<_>>();
            (hashes("rvm"), hashes("stage1"), hashes("stage2"), out.written)
        };
        let (all, low) = (run(false), run(true));
        assert_eq!(all.0, low.0, "RVM inputs (half {half})");
        assert_eq!(all.1, low.1, "stage 1 inputs (half {half})");
        assert_eq!(all.2, low.2, "stage 2 inputs (half {half})");
        assert_eq!(all.3, low.3, "the writers' frames (half {half})");
        assert_eq!(all.2.len(), 9);
    }
}
