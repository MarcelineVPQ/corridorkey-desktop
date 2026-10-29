//! Steps 2-4 of a job, one attempt at its window (runtime.run_inference and hann_stage1_stream), as passes:
//!  - `rvm_pass`: one recurrent RVM step per frame over the whole clip, features to temp_dir (float16);
//!  - `foundation_pass` (low-VRAM only): C-RADIO and MoGe over the clip in chunks of 4 frames, to temp_dir;
//!  - `stage1_windows`: stage 1 on the overlapping windows, the states blended with the taper weights; in the
//!    normal mode each frame's stage 2 runs as soon as its state is final, in low-VRAM mode the states go to
//!    temp_dir;
//!  - `stage2_pass` (low-VRAM only): stage 2 over the stored states.
//!
//! Low-VRAM mode loads only each phase's networks (the next phase's load ahead on their own threads, CUDA and Core ML).
//!
//! Keeping the card busy (the pipelining pass, backlog row 182; every output byte-identical): the RVM pass's frames
//! decode while the networks load. In normal mode: on CUDA with an automatic window's budget of at least
//! `LOADS_BEHIND_MIN_GB`, MoGe, stage 1 and stage 2 load behind the RVM pass; each
//! window's states are blended on their own thread while the card runs the next window; C-RADIO and MoGe run only on
//! the frames a window doesn't share with the one before (CUDA and the CPU).
use super::frames::{FrameSource, HintWindows, WindowReader};
use super::network::{Loader, Network};
use super::temps::{F16File, FeatFile, TempPaths};
use super::{FrameReport, ModelKey, NetTotals, Pipeline, Sink};
use crate::ahead::Ahead;
use crate::clip::ClipMeta;
use crate::color::bf16_round;
use crate::decode::{load_initial_hint, Prefetch, Prepped};
use crate::hann::{taper_weights, window_starts, BatonBlend};
use crate::image::{resize_area, resize_bilinear, Planar};
use crate::job::JobConfig;
use crate::outputs::{Geometry, RenderWorker, Writers};
use crate::render::{make_checker, RenderOpts};
use crate::runtime::{Data, Provider, TrtSettings};
use crate::tensorrt::{BATON_CH, CRADIO_CH, FOUNDATION_CHUNK, MOGE_CH, RVM_CH};
use crate::Error;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

/// The `progress` stage a network load reports.
const LOAD_STAGE: &str = "load";

/// Normal mode on CUDA: MoGe, stage 1 and stage 2 load behind the RVM pass only when the automatic window was chosen
/// for at least this budget (GiB). Measured on the RTX 5080 only (16 GB, 13.08 GB budget): loaded on their own threads
/// they hold about 0.22 GB more graphics memory through the windows and 0.27 GB more at the 4K 8/4 peak, which the
/// window table (vram.rs) doesn't count. Under it (an 8 GB card's 7.0-7.4 GiB budgets) every network loads on the
/// job's thread as in dev.4, so nothing is added to a budget card's peak; a window the request set loads them before
/// the probe anyway (run_job).
pub(crate) const LOADS_BEHIND_MIN_GB: f64 = 10.0;

/// What one attempt runs with: the window and staging the job settled on (an out-of-memory retry halves the
/// window), and the networks' key (provider, precision, TensorRT range, memory budget).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct JobPlan {
    pub(crate) chunk: usize,
    pub(crate) stride: usize,
    pub(crate) low_vram: bool,
    pub(crate) key: ModelKey,
    /// the budget (GiB) the automatic window was chosen for; None: the request set the window (`LOADS_BEHIND_MIN_GB`)
    pub(crate) budget_gb: Option<f64>,
}

/// What every attempt of a job shares: the request, the probed clip, where its frames come from, the TensorRT
/// engines' folders and its temporary files (named after the clip).
pub(crate) struct JobCtx<'a> {
    pub(crate) job: &'a JobConfig,
    pub(crate) meta: &'a ClipMeta,
    pub(crate) frames: &'a dyn FrameSource,
    pub(crate) trt: Option<&'a dyn Fn(&str) -> TrtSettings>,
    pub(crate) temps: TempPaths,
    /// EXR jobs with an output colour space: the output processor (RenderOpts::color_out) and whether that space is
    /// scene-linear (RenderOpts::out_linear); None / true otherwise
    pub(crate) color_out: Option<crate::ocio::XformRef>,
    pub(crate) out_linear: bool,
}

impl<'a> JobCtx<'a> {
    pub(crate) fn new(
        job: &'a JobConfig,
        meta: &'a ClipMeta,
        frames: &'a dyn FrameSource,
        trt: Option<&'a dyn Fn(&str) -> TrtSettings>,
        clip: &'a str,
    ) -> JobCtx<'a> {
        JobCtx { job, meta, frames, trt, temps: TempPaths::new(&job.temp_dir, clip), color_out: None, out_linear: true }
    }
}

/// One attempt's measured host seconds (its timing line).
struct JobTimes {
    started: Instant,
    decode_s: f64,
    /// stage 2 calls + hand-off inside the windows (the normal mode)
    render_s: f64,
    /// host seconds around stage 1: inputs (decode wait, features, hints) and after (carry, blend, hand-off)
    s1_in_s: f64,
    s1_out_s: f64,
    /// the windows' blends (on the baton-blend thread, but the last) and the main thread's wait for them
    blend_s: f64,
    blend_wait_s: f64,
    /// wall seconds per phase (the low-VRAM phases include loading their networks)
    phases: Vec<(&'static str, f64)>,
    phase_t: Instant,
}

impl JobTimes {
    fn new(started: Instant) -> JobTimes {
        JobTimes {
            started,
            decode_s: 0.0,
            render_s: 0.0,
            s1_in_s: 0.0,
            s1_out_s: 0.0,
            blend_s: 0.0,
            blend_wait_s: 0.0,
            phases: Vec::new(),
            phase_t: Instant::now(),
        }
    }
    /// The phase `name` ended now.
    fn phase(&mut self, name: &'static str) {
        self.phases.push((name, self.phase_t.elapsed().as_secs_f64()));
        self.phase_t = Instant::now();
    }
}

/// Where the frames go: the render thread (it holds the writers until it finishes) and the `frames` replies.
struct Writing<'w, 'r> {
    render: RenderWorker<'w>,
    report: &'r mut FrameReport,
}

/// What the stage-1 windows start from: the RVM features, the low-VRAM foundation features, the first-frame hint
/// and the windows' first frames.
struct WindowsIn {
    rvm: F16File,
    found: Option<(FeatFile, FeatFile)>,
    initial_hint: Option<Vec<f32>>,
    starts: Vec<usize>,
}

/// One stage-1 window's inputs made ahead (`stage1_windows`).
struct WindowInputs {
    frames: Vec<Prepped>,
    /// stage 1's rgb, already in the type stage 1 takes (converted on the input thread, not between card calls); in
    /// normal mode stage 2 reads its frames from it too (`S2Rgb`)
    rgb: Arc<Data<'static>>,
    hint_video: Option<Vec<Arc<Vec<f32>>>>,
    found: Found,
    rvm: Vec<half::f16>,
}

/// A frame's rgb for stage 2 in normal mode: its place in a window's stage-1 rgb (frame `.1`), when stage 2 takes the
/// type stage 1 does (the same values: both are the decoded bfloat16 frame in that type), else the decoded frame,
/// converted in the run.
enum S2Rgb {
    Window(Arc<Data<'static>>, usize),
    Frame(Arc<Vec<half::bf16>>),
}

/// One stage-1 window's states waiting to be blended (on the baton-blend thread while the card runs the next window).
struct PendingBlend {
    t0: usize,
    baton: Data<'static>,
    wts: Vec<f32>,
    /// the next window's first frame: the frames before it are final once this window is blended
    next_start: usize,
}

/// Frames whose blended state is final: (frame, state as float16).
type Ready = Vec<(usize, Vec<half::f16>)>;

/// Blend a window's states into `blend` (frame by frame in order, the same sums as before) and take the frames it made
/// final; with the seconds it took.
fn blend_window(blend: &mut BatonBlend, p: PendingBlend, baton_frame: usize) -> Result<(Ready, f64), Error> {
    let t = Instant::now();
    // loop: HOT-PATH-OK — the window's frames; each frame's values blended in parallel, read in stage 1's type
    for (j, &w) in p.wts.iter().enumerate() {
        let r = j * baton_frame..(j + 1) * baton_frame;
        match p.baton.view() {
            Data::F16Ref(v) => blend.add(p.t0 + j, &v[r], w),
            Data::F32Ref(v) => blend.add(p.t0 + j, &v[r], w),
            _ => return Err(Error::engine("stage1: baton not float16 / float32".into())),
        }
    }
    drop(p.baton);
    let ready = blend.flush_before(p.next_start);
    Ok((ready, t.elapsed().as_secs_f64()))
}

/// The window's foundation features (low-VRAM: from the prepass files) or the inputs to compute them.
enum Found {
    Features(Data<'static>, Data<'static>),
    /// the first frame the inputs are for (the frames before it in the window come from the previous window's
    /// features) and the inputs
    Inputs(usize, (Vec<f32>, Vec<f32>)),
}

/// The previous window's foundation features (normal mode): its first frame and C-RADIO's and MoGe's [frames, ...].
type WindowFeatures = (usize, Data<'static>, Data<'static>);

/// A window's features: `prev`'s frames from `t0` up to `from` (`per` values per frame), then `new` (frames from `from`).
fn splice_features(prev: Option<(usize, &Data<'static>)>, t0: usize, from: usize, per: usize, new: Data<'static>) -> Result<Data<'static>, Error> {
    let Some((p0, prev)) = prev.filter(|_| from > t0) else { return Ok(new) };
    let r = (t0 - p0) * per..(from - p0) * per;
    match (prev.view(), new.view()) {
        (Data::F32Ref(p), Data::F32Ref(n)) => Ok(Data::F32([&p[r], n].concat())),
        (Data::F16Ref(p), Data::F16Ref(n)) => Ok(Data::F16([&p[r], n].concat())),
        _ => Err(Error::engine("foundation features changed type between windows".into())),
    }
}

impl<L: Loader> Pipeline<L> {
    /// Steps 2-4 at `plan`'s window (and the low-VRAM staging). Frames go to `writers` (lent to the render thread
    /// while it runs, back when the attempt ends, also on a failure). `in_windows` ends true when the failure came
    /// from the phase the window sizes (stage 1 on the windows; in the normal mode also C-RADIO, MoGe and stage 2
    /// inside them), false from any other (the RVM prepass, the normal mode's network loads, the low-VRAM foundations
    /// and stage-2 pass).
    pub(super) fn keying(
        &mut self,
        ctx: &JobCtx<'_>,
        plan: &JobPlan,
        writers: &mut Writers,
        report: &mut FrameReport,
        sink: &mut dyn Sink,
        in_windows: &mut bool,
    ) -> Result<(), Error> {
        *in_windows = false;
        let (job, meta) = (ctx.job, ctx.meta);
        let t_all = meta.num_frames;
        let mut times = JobTimes::new(Instant::now());
        self.nets.values_mut().for_each(|n| {
            let c = n.counters();
            c.run_s = 0.0;
            c.convert_s = 0.0;
            c.calls = 0;
        });
        self.stats.clear();
        self.drop_pending();
        self.load_s = 0.0;
        self.preload_s = 0.0;
        self.load_each.clear();
        self.s2_host = [0.0; 2];
        times.phase_t = Instant::now();
        let (sh, sw) = (meta.shape_h, meta.shape_w);
        let (h16, w16) = (sh / 16, sw / 16);
        let initial_hint = match crate::clip::none_path(job.hint_first_frame.as_deref()) {
            Some(p) => {
                let v = load_initial_hint(Path::new(p), meta)?;
                sink.log(&format!("  loaded initial frame-1 hint from {p}"));
                Some(v)
            }
            None => None,
        };
        // the temporary files go when the attempt ends (after every pass's own handles on them are closed)
        let _temps = ctx.temps.guard();

        let rvm = self.rvm_pass(ctx, plan, &mut times, sink)?;
        let found = if plan.low_vram { Some(self.foundation_pass(ctx, plan, &mut times, sink)?) } else { None };
        if !plan.low_vram {
            // normal mode: the networks loaded behind the RVM pass (waits only for a load not done yet), taken before
            // the windows: a load's out of memory is its own, a smaller window doesn't change it (perf review
            // 2026-10-29 S5: inside the windows it halved the window and re-ran the job up to 7 times)
            let behind = !self.pending.is_empty();
            self.ensure(&plan.key, &crate::runtime::PIECES, false, ctx.trt, sink, LOAD_STAGE)?;
            if behind {
                // their loading's freed host memory sits in the load threads' malloc arenas: give it back
                super::trim_host_memory();
            }
        }

        // 3. stage 1 on Hann windows (+ 4. stage 2 streamed, normal mode)
        let starts = window_starts(t_all, plan.chunk, plan.stride);
        sink.log(&format!("    Hann stage1: chunk={}, stride={}, windows={}, baton_grid={w16}x{h16}", plan.chunk, plan.stride, starts.len()));
        let ro = RenderOpts {
            alpha: job.outputs.iter().any(|o| o == "alpha"),
            fg: job.outputs.iter().any(|o| o == "fg"),
            checker: job.outputs.iter().any(|o| o == "checker"),
            cutout: job.outputs.iter().any(|o| o == "cutout"),
            despill: job.despill_strength as f32,
            cutout_linear: job.cutout_linear,
            exr: job.exr,
            adjust: meta.adjust,
            color_out: ctx.color_out.clone(),
            out_linear: ctx.out_linear,
        };
        let checker = make_checker(meta.h, meta.w);
        // render + hand-off to the writers on their own thread (the writers come back when `render` ends)
        let geo = Geometry { shape: (sh, sw), crop: (meta.pad.t, meta.pad.l), model: (meta.model_h, meta.model_w), hw: (meta.h, meta.w) };
        let worker_s = {
            let mut writing = Writing { render: RenderWorker::start(writers, ro, checker, geo)?, report: &mut *report };
            *in_windows = true;
            let states = self.stage1_windows(ctx, plan, WindowsIn { rvm, found, initial_hint, starts }, &mut writing, &mut times, sink)?;
            *in_windows = false;
            // low-VRAM phase 2: stage 2 over the stored states
            if let Some(states) = states {
                self.stage2_pass(ctx, plan, states, &mut writing, &mut times, sink)?;
            }
            // render + hand-off seconds on the render thread (all frames: finish waits for the queued ones)
            writing.render.finish()?
        };
        // every frame is with the writers now (before they finish encoding): say so right away
        report.report(writers, sink, true);
        self.timing_line(&times, worker_s, sink);
        Ok(())
    }

    /// Step 2, the RVM prepass: one recurrent step per frame over the whole clip (loading the networks the first phase
    /// needs: RVM alone in low-VRAM mode, all five otherwise). The features as float16 in temp_dir.
    fn rvm_pass(&mut self, ctx: &JobCtx<'_>, plan: &JobPlan, times: &mut JobTimes, sink: &mut dyn Sink) -> Result<F16File, Error> {
        let (job, meta, frames, key) = (ctx.job, ctx.meta, ctx.frames, &plan.key);
        let t_all = meta.num_frames;
        let (sh, sw) = (meta.shape_h, meta.shape_w);
        let (h64, w64) = (sh / 64, sw / 64);
        if plan.low_vram {
            self.unload();
        }
        let (he, we) = (sh / 4, sw / 4);
        // the small frames are made ahead on their own thread (they don't depend on the state); started before the
        // networks load, so the first frames are decoded by the time RVM can run
        let mut reader = Prefetch::new("rvm-decode", frames.open(true)?, 8)?;
        let dec = crate::ahead::Seconds::default();
        let dec2 = dec.clone();
        let mut small_frames = Ahead::spawn("rvm-inputs", 4, move || {
            let Some(f) = reader.next_frame()? else {
                dec2.set(reader.seconds());
                return Ok(None);
            };
            let mut small = crate::image::resize_bilinear_bf16(&f.display, 3, sh, sw, he, we);
            small.map(|v| v.clamp(0.0, 1.0));
            Ok(Some(small.data))
        })?;
        // normal mode on CUDA with room for it (`LOADS_BEHIND_MIN_GB`): C-RADIO (the first load, which reads the card's
        // own overhead, as before) and RVM now, the other three load behind the RVM pass (`keying` takes them)
        let behind = !plan.low_vram && key.provider == Provider::Cuda && plan.budget_gb.is_some_and(|b| b >= LOADS_BEHIND_MIN_GB);
        let first: &[&'static str] = match (plan.low_vram, behind) {
            (true, _) => &["rvm"],
            (false, true) => &["cradio", "rvm"],
            (false, false) => &crate::runtime::PIECES,
        };
        self.ensure(key, first, plan.low_vram, ctx.trt, sink, LOAD_STAGE)?;
        if key.provider == Provider::TensorRt {
            self.send_trt_provider(sink);
        }
        if plan.low_vram {
            // the foundations load while RVM runs
            self.preload(key, &["cradio", "moge"], true);
        } else if behind {
            self.preload(key, &["moge", "stage1", "stage2"], false);
        }
        sink.send(json!({"type": "progress", "stage": "rvm"}));
        let rvm_frame = RVM_CH * h64 * w64;
        let mut rvm_file = F16File::create(&ctx.temps.rvm, rvm_frame)?;
        {
            sink.log(&format!("    RVM continuous prepass: T={t_all}, chunk={}, input={we}x{he}, grid={}x{}", plan.chunk.clamp(1, 8), we / 16, he / 16));
            let ntok = 1 + (he / 16) * (we / 16);
            let mut state: Data<'static> = Data::F32(vec![0f32; ntok * RVM_CH]);
            let mut t = 0;
            let net = self.net("rvm")?;
            // loop: SERIAL-REQUIRED — RVM is recurrent: each frame's step takes the previous state
            while let Some(small) = small_frames.next_item()? {
                stop_point(sink)?;
                let outs = net.run(vec![("frame", vec![1, 3, he, we], small.into()), ("state", vec![1, ntok, RVM_CH], state)])?;
                // loop: NOT-WORTH — two outputs per RVM step
                let mut it = outs.into_iter();
                let (_, feat) = it.next().ok_or_else(|| Error::engine("rvm: no output".into()))?;
                let (_, st) = it.next().ok_or_else(|| Error::engine("rvm: no state".into()))?;
                state = st;
                rvm_file.put(t, &feat.into_f16())?;
                t += 1;
            }
            if t != t_all {
                return Err(Error::input(format!("{}: decoded only {t}/{t_all} requested frames", job.input)));
            }
            times.decode_s += dec.get();
            sink.log(&format!("    RVM inputs prepared on their own thread in {:.1} s", small_frames.seconds()));
        }
        times.phase("rvm");
        Ok(rvm_file)
    }

    /// TensorRT jobs: the `provider` reply once the first phase's networks are loaded (which run on TensorRT,
    /// which fell back to CUDA and why, the engines built in this job).
    /// (`pieces`: the networks loaded now; `provider` and `fallbacks` cover the whole job so far: sent again by `ensure`
    /// when a later low-VRAM phase adds a fallback)
    pub(super) fn send_trt_provider(&mut self, sink: &mut dyn Sink) {
        // loop: NOT-WORTH — five networks, once per TensorRT job
        let pieces: BTreeMap<&str, &str> = self.nets.iter().map(|(k, n)| (*k, n.provider().name())).collect();
        // loop: NOT-WORTH — five networks, once per TensorRT job
        let built: BTreeMap<&str, f64> = self.trt_seconds.iter().filter(|(_, v)| v.1).map(|(k, v)| (*k, v.0)).collect();
        // "cuda" only when every network fell back (in a low-VRAM phase only some are loaded)
        let all = self.trt_fallbacks.len() >= crate::runtime::PIECES.len();
        sink.send(json!({"type": "provider", "provider": if self.trt_fallbacks.is_empty() { "tensorrt" } else if all { "cuda" } else { "tensorrt+cuda" },
            "pieces": pieces, "fallbacks": self.trt_fallbacks, "build_s": built}));
        self.trt_reported = Some(self.trt_fallbacks.len());
    }

    /// Low-VRAM: the foundations prepass, C-RADIO and MoGe over the clip in chunks of 4 frames, their features to
    /// temp_dir in the type the networks made them.
    fn foundation_pass(&mut self, ctx: &JobCtx<'_>, plan: &JobPlan, times: &mut JobTimes, sink: &mut dyn Sink) -> Result<(FeatFile, FeatFile), Error> {
        let (meta, frames, key) = (ctx.meta, ctx.frames, &plan.key);
        let t_all = meta.num_frames;
        let (sh, sw) = (meta.shape_h, meta.shape_w);
        let (h64, w64) = (sh / 64, sw / 64);
        self.unload();
        self.ensure(key, &["cradio", "moge"], true, ctx.trt, sink, LOAD_STAGE)?;
        // stage 1 loads while the foundations run
        self.preload(key, &["stage1"], true);
        sink.send(json!({"type": "progress", "stage": "foundations"}));
        let fchunk = FOUNDATION_CHUNK;
        sink.log(&format!("    frozen VFM prepass: T={t_all}, grid={w64}x{h64}, chunk={fchunk}"));
        let mut cf = FeatFile::create(&ctx.temps.cradio, CRADIO_CH * h64 * w64)?;
        let mut mf = FeatFile::create(&ctx.temps.moge, MOGE_CH * h64 * w64)?;
        // the resized inputs are made ahead on their own thread
        let mut reader = Prefetch::new("found-decode", frames.open(true)?, 8)?;
        let dec = crate::ahead::Seconds::default();
        let dec2 = dec.clone();
        let mut done_frames = 0;
        let mut chunks = Ahead::spawn("found-inputs", 2, move || {
            let mut frames = Vec::new();
            // loop: NOT-WORTH — up to four frames
            while frames.len() < fchunk && done_frames < t_all {
                frames.push(reader.next_frame()?.ok_or_else(|| Error::input("short read".into()))?);
                done_frames += 1;
            }
            if frames.is_empty() {
                dec2.set(reader.seconds());
                return Ok(None);
            }
            Ok(Some((frames.len(), foundation_inputs(&frames, sh, sw))))
        })?;
        let mut t0 = 0;
        // loop: SERIAL-REQUIRED — chunks of 4 frames, in order
        while let Some((n, (radio, moge))) = chunks.next_item()? {
            stop_point(sink)?;
            let (c, m) = self.foundation_run(n, radio, moge, sh, sw)?;
            cf.put(t0, &c)?;
            mf.put(t0, &m)?;
            t0 += n;
        }
        times.decode_s += dec.get();
        sink.log(&format!("    foundation inputs prepared on their own thread in {:.1} s", chunks.seconds()));
        times.phase("foundations");
        Ok((cf, mf))
    }

    /// Step 3, stage 1 on the windows, in order (each window's carry hint feeds the next), each frame's states blended
    /// with the taper weights. A frame no later window covers is final: straight to stage 2 and the render thread
    /// (normal mode), or to the states file, which is returned (low-VRAM mode).
    fn stage1_windows(
        &mut self,
        ctx: &JobCtx<'_>,
        plan: &JobPlan,
        input: WindowsIn,
        out: &mut Writing<'_, '_>,
        times: &mut JobTimes,
        sink: &mut dyn Sink,
    ) -> Result<Option<F16File>, Error> {
        let (job, meta, frames, key) = (ctx.job, ctx.meta, ctx.frames, &plan.key);
        let (chunk, low_vram) = (plan.chunk, plan.low_vram);
        let WindowsIn { rvm: rvm_file, found: found_files, initial_hint, starts } = input;
        let t_all = meta.num_frames;
        let (sh, sw) = (meta.shape_h, meta.shape_w);
        let (h64, w64, h16, w16) = (sh / 64, sw / 64, sh / 16, sw / 16);
        let window_decode_s = crate::ahead::Seconds::default();
        let overlap = chunk.saturating_sub(plan.stride);
        // each window's inputs that don't depend on the previous window (decoded frames, hint video, foundation
        // and RVM features, or the foundations' resized inputs) are made on their own thread while the card runs
        // the window before (at most one window ahead: a rendezvous channel)
        // stage 1's rgb type, sent once stage 1 is loaded: the input thread decodes the first window meanwhile and
        // converts it when the type arrives
        let (rgb_type_tx, rgb_type_rx) = std::sync::mpsc::sync_channel::<bool>(1);
        // normal mode: C-RADIO's and MoGe's features of the frames two windows share are computed once and reused
        // (backlog row 182). That changes their batch size (8 -> 4 at 8/4), so the bytes stay the same only where the
        // kernels don't depend on it: checked on the RTX 5080 only (CUDA fp16, 4K 8/4 and HD 48/24); other cards,
        // other windows and the CPU provider are not checked. Core ML (fixed batches) and MIGraphX (a compile per
        // batch size) compute every window's frames, as before.
        let reuse_found = matches!(key.provider, Provider::Cuda | Provider::Cpu);
        let mut windows = {
            let mut reader = WindowReader::open(frames)?;
            let mut hints = match crate::clip::none_path(job.hint_video.as_deref()) {
                Some(p) => Some(HintWindows::open(Path::new(p), meta)?),
                None => None,
            };
            let mut found_files = found_files;
            let mut rvm_file = rvm_file;
            let starts = starts.clone();
            let dec = window_decode_s.clone();
            let mut i = 0;
            let mut found_to = 0;
            let mut rgb_f16: Option<bool> = None;
            Ahead::spawn_abandonable("window-inputs", 0, move |abandoned| {
                let Some(&t0) = starts.get(i) else {
                    dec.set(reader.reader.seconds());
                    return Ok(None);
                };
                i += 1;
                let t1 = (t0 + chunk).min(t_all);
                let frames = reader.window(t0, t1, abandoned)?;
                let hint_video = match hints.as_mut() {
                    Some(hw) => Some(hw.window(t0, t1, abandoned)?),
                    None => None,
                };
                // the foundations' inputs only for the frames the previous window didn't have (their features are
                // reused, `reuse_found`); every frame where they aren't
                let from = if reuse_found { t0.max(found_to) } else { t0 };
                found_to = t1;
                let found = match found_files.as_mut() {
                    None => Found::Inputs(from, foundation_inputs(&frames[from - t0..], sh, sw)),
                    Some((cf, mf)) => Found::Features(cf.get(t0, t1)?, mf.get(t0, t1)?),
                };
                let rvm = rvm_file.get(t0, t1)?;
                let f16 = match rgb_f16 {
                    Some(f) => f,
                    // loop: SERIAL-REQUIRED — once per job, the type stage 1 takes [bounded: sent right after stage 1 loads; a failed load drops the sender and this errors]
                    None => *rgb_f16.insert(rgb_type_rx.recv().map_err(|_| Error::engine("stage 1 didn't load".into()))?),
                };
                // loop: HOT-PATH-OK — ≤ 80 slice references; one parallel conversion per window
                let rgb = Data::Bf16(frames.iter().map(|f| &f.model[..]).collect());
                let rgb = Arc::new(if f16 { Data::F16(rgb.into_f16()) } else { Data::F32(rgb.into_f32()) });
                Ok(Some(WindowInputs { frames, rgb, hint_video, found, rvm }))
            })?
        };
        // the sender moved to a binding declared after `windows`, so it is dropped first: an error before stage 1's
        // type is sent (its load failing) ends the input thread's wait, and `windows`' drop can join it
        let rgb_type_tx = rgb_type_tx;
        let baton_frame = BATON_CH * h16 * w16;
        let mut baton_file = if low_vram { Some(F16File::create(&ctx.temps.baton, baton_frame)?) } else { None };
        let mut blend = BatonBlend::default();
        let mut pending: Option<PendingBlend> = None;
        let mut feats: Option<WindowFeatures> = None;
        let mut carry: BTreeMap<usize, Vec<f32>> = BTreeMap::new();
        let mut stage2_frames: BTreeMap<usize, S2Rgb> = BTreeMap::new();
        let plane = sh * sw;
        let hq_full = bf16_round(job.hint_quality as f32);
        let hq_carry = bf16_round(job.carry_hint_quality as f32);
        if low_vram {
            // stage 1 loads while the first window's inputs are made (normal mode: all five are loaded, `keying`)
            self.unload();
            self.ensure(key, &["stage1"], true, ctx.trt, sink, LOAD_STAGE)?;
        }
        // the hint is made in the type stage 1 takes; windows without any matte share one all-zero buffer, made the
        // first time one is needed
        let hint_f16 = self.net("stage1")?.wants_f16("hint");
        // the input thread waits for it before converting the first window (it can't fail: the thread holds the receiver)
        let rgb_f16 = self.net("stage1")?.wants_f16("rgb");
        let _ = rgb_type_tx.send(rgb_f16);
        // normal mode: stage 2 reads each frame from the window's stage-1 rgb when it takes the same type (backlog row
        // 182: converting it again on this thread took 1.9 s per 4K job)
        let s2_shares = !low_vram && self.net("stage2")?.wants_f16("rgb") == rgb_f16;
        let (zeros16, zeros32) = (std::cell::OnceCell::<Vec<half::f16>>::new(), std::cell::OnceCell::<Vec<f32>>::new());
        let zero_len = chunk.min(t_all) * plane;
        sink.send(json!({"type": "progress", "stage": "keying"}));
        // loop: SERIAL-REQUIRED — windows run in order: each one's carry hint feeds the next
        for (i, &t0) in starts.iter().enumerate() {
            stop_point(sink)?;
            let tw = Instant::now();
            let t1 = (t0 + chunk).min(t_all);
            let tc = t1 - t0;
            let WindowInputs { frames, rgb, hint_video, found, rvm } =
                windows.next_item()?.ok_or_else(|| Error::engine("the window input thread ended early".into()))?;
            // each frame's matte, if it has one (later sources win: the hint video, then the carry, then the
            // first-frame hint), and its quality
            let mut src: Vec<Option<&[f32]>> = vec![None; tc];
            let mut hq = vec![0f32; tc];
            if let Some(hv) = &hint_video {
                // loop: NOT-WORTH — the window's frames (≤ 80): slice references
                for (j, m) in hv.iter().enumerate() {
                    src[j] = Some(&m[..]);
                }
                // loop: NOT-WORTH — the window's hint qualities (≤ 80)
                hq.iter_mut().for_each(|q| *q = hq_full);
            }
            // loop: NOT-WORTH — the window's frames (≤ 80): slice references
            for (j, t) in (t0..t1).enumerate() {
                if let Some(c) = carry.get(&t) {
                    src[j] = Some(&c[..]);
                    hq[j] = hq_carry;
                }
            }
            if let (Some(ih), 0) = (&initial_hint, t0) {
                src[0] = Some(&ih[..]);
                hq[0] = hq_full;
            }
            // the hint in stage 1's own type, made once (it was a float32 window converted to float16 in the run): a
            // window without any matte feeds the job's one all-zero buffer, borrowed
            // loop: NOT-WORTH — the window's flags (≤ 80)
            let hint = if src.iter().all(|s| s.is_none()) {
                // loop: NOT-WORTH — the window's hint qualities (≤ 80)
                hq.iter_mut().for_each(|q| *q = -1.0);
                if hint_f16 {
                    Data::F16Ref(&zeros16.get_or_init(|| vec![half::f16::ZERO; zero_len])[..tc * plane])
                } else {
                    Data::F32Ref(&zeros32.get_or_init(|| vec![0f32; zero_len])[..tc * plane])
                }
            } else if hint_f16 {
                Data::F16(hint_window(&src, plane, half::f16::from_f32))
            } else {
                Data::F32(hint_window(&src, plane, |v| v))
            };
            drop(src);
            if s2_shares {
                // loop: HOT-PATH-OK — the window's frames: the newest window's rgb, so an older window's is freed sooner
                for (j, t) in (t0..t1).enumerate() {
                    stage2_frames.insert(t, S2Rgb::Window(rgb.clone(), j));
                }
            } else if !low_vram {
                // loop: HOT-PATH-OK — the window's frames
                for (j, t) in (t0..t1).enumerate() {
                    stage2_frames.entry(t).or_insert_with(|| S2Rgb::Frame(frames[j].model.clone()));
                }
            }
            if low_vram && i + 1 == starts.len() {
                // stage 2 loads while the last stage-1 window runs
                self.preload(key, &["stage2"], true);
            }
            // normal mode: the card runs this window (its foundations and stage 1) while the previous window's states
            // are blended on their own thread (backlog row 182: the main thread blended them with the card idle);
            // the frames that blend makes final go to stage 2 / the states file after this window's stage 1
            let prev = pending.take();
            let blend_ref = &mut blend;
            let (outs, blended) = std::thread::scope(|s| -> Result<_, Error> {
                let blending = match prev {
                    // loop: PARALLELIZE — the previous window's blend while the card runs this one [bounded: joined below, inside the scope; finite CPU work on one window's states]
                    Some(p) => Some(
                        std::thread::Builder::new()
                            .name("baton-blend".into())
                            .spawn_scoped(s, move || blend_window(blend_ref, p, baton_frame))
                            .map_err(|e| Error::engine(format!("couldn't start the baton-blend thread: {e}")))?,
                    ),
                    None => None,
                };
                let outs = (|| {
                    let (cradio, moge) = match found {
                        Found::Inputs(from, (radio, moge)) => {
                            // the new frames' features, after the previous window's for the frames it shared
                            let (c, m) = self.foundation_run(t1 - from, radio, moge, sh, sw)?;
                            let prev = feats.take();
                            let per = h64 * w64;
                            let c = splice_features(prev.as_ref().map(|p| (p.0, &p.1)), t0, from, CRADIO_CH * per, c)?;
                            let m = splice_features(prev.as_ref().map(|p| (p.0, &p.2)), t0, from, MOGE_CH * per, m)?;
                            let (_, c, m) = feats.insert((t0, c, m));
                            (c.view(), m.view())
                        }
                        Found::Features(c, m) => (c, m),
                    };
                    // the frames are done with (stage 1's rgb was made from them on the input thread)
                    drop(frames);
                    times.s1_in_s += tw.elapsed().as_secs_f64();
                    self.net("stage1")?.run(vec![
                        ("rgb", vec![1, tc, 3, sh, sw], rgb.view()),
                        ("hint", vec![1, tc, 1, sh, sw], hint),
                        ("hint_quality", vec![1, tc], hq.into()),
                        ("moge", vec![1, tc, MOGE_CH, h64, w64], moge),
                        ("cradio", vec![1, tc, CRADIO_CH, h64, w64], cradio),
                        ("rvm", vec![1, tc, RVM_CH, h64, w64], Data::F16(rvm)),
                    ])
                })();
                let tj = Instant::now();
                // loop: SERIAL-REQUIRED — joins the blend thread (also when the card's run failed) [bounded: one window's blend, finite CPU work]
                let blended = blending
                    .map(|h| h.join().map_err(|p| Error::engine(format!("the baton-blend thread panicked: {}", crate::panic_message(&*p))))?)
                    .transpose();
                times.blend_wait_s += tj.elapsed().as_secs_f64();
                Ok((outs?, blended?))
            })?;
            if let Some((ready, secs)) = blended {
                times.blend_s += secs;
                let tr = Instant::now();
                self.baton_frames(ready, &mut baton_file, &mut stage2_frames, meta, out, sink)?;
                times.render_s += tr.elapsed().as_secs_f64();
            }
            let tw = Instant::now();
            // loop: NOT-WORTH — two outputs per window
            let mut it = outs.into_iter();
            let (bs, baton) = it.next().ok_or_else(|| Error::engine("stage1: no baton".into()))?;
            let (as_, aux) = it.next().ok_or_else(|| Error::engine("stage1: no aux".into()))?;
            if bs != vec![1, tc, BATON_CH, h16, w16] || baton.len() != tc * baton_frame {
                return Err(Error::engine(format!("stage1: baton shape {bs:?}")));
            }
            let next_start = if i + 1 < starts.len() { starts[i + 1] } else { t_all };
            if job.carry_hint {
                use rayon::prelude::*;
                let (ah, aw) = (as_[3], as_[4]);
                let aplane = 4 * ah * aw;
                // only the frames the next window takes (t >= next_start) are kept: the others aren't made
                let ups: Vec<(usize, Vec<f32>)> = (next_start.max(t0)..t1)
                    // loop: HOT-PATH-OK — carry hints: only the frames the next window takes (≤ stride), in parallel, each a small upsample
                    .into_par_iter()
                    .map(|t| {
                        let j = t - t0;
                        let a0 = Planar::from_vec(1, ah, aw, aux.range_f32(j * aplane..j * aplane + ah * aw));
                        let mut up = resize_bilinear(&a0, sh, sw);
                        up.map(|v| bf16_round(v.clamp(0.0, 1.0)));
                        (t, up.data)
                    })
                    .collect();
                carry.extend(ups);
                carry = carry.split_off(&next_start);
            }
            let wts = taper_weights(tc, overlap, i == 0, i == starts.len() - 1);
            let p = PendingBlend { t0, baton, wts, next_start };
            if low_vram {
                // blended here, as before: on its own thread it measured no faster in low-VRAM mode (walking_sitting
                // 48/24, three runs each) and held one more window's states in memory
                let (ready, secs) = blend_window(&mut blend, p, baton_frame)?;
                times.blend_s += secs;
                self.baton_frames(ready, &mut baton_file, &mut stage2_frames, meta, out, sink)?;
            } else {
                // blended while the card runs the next window (or below, after the last)
                pending = Some(p);
            }
            times.s1_out_s += tw.elapsed().as_secs_f64();
            sink.log(&format!("      window {}/{} [{t0}:{t1}]", i + 1, starts.len()));
            sink.send(json!({"type": "progress", "stage": "keying", "p": ((i + 1) as f64 / starts.len() as f64 * 1e4).round() / 1e4, "detail": format!("window {}/{} done", i + 1, starts.len())}));
        }
        if let Some(p) = pending.take() {
            let (ready, secs) = blend_window(&mut blend, p, baton_frame)?;
            times.blend_s += secs;
            self.baton_frames(ready, &mut baton_file, &mut stage2_frames, meta, out, sink)?;
        }
        let ready = blend.flush_before(t_all + 1);
        self.baton_frames(ready, &mut baton_file, &mut stage2_frames, meta, out, sink)?;

        drop(windows);
        times.decode_s += window_decode_s.get();
        times.phase(if low_vram { "stage1" } else { "windows+stage2" });
        Ok(baton_file)
    }

    /// Step 4 in low-VRAM mode: stage 2 over the stored states, frame by frame in order (inputs made ahead on their own thread).
    fn stage2_pass(
        &mut self,
        ctx: &JobCtx<'_>,
        plan: &JobPlan,
        mut bf: F16File,
        out: &mut Writing<'_, '_>,
        times: &mut JobTimes,
        sink: &mut dyn Sink,
    ) -> Result<(), Error> {
        let (meta, frames) = (ctx.meta, ctx.frames);
        // only the written frames get stage 2 (a ranged job's warm-up frames are read past, its tail not read)
        let write = meta.write_range();
        self.unload();
        self.ensure(&plan.key, &["stage2"], true, ctx.trt, sink, LOAD_STAGE)?;
        // frames and stored states read and made into stage-2 inputs on their own thread, ahead of the card
        let mut reader = Prefetch::new("s2-decode", frames.open(false)?, 8)?;
        // the frame converted here, on the producer thread, to the type stage 2 takes
        let rgb_f16 = self.net("stage2")?.wants_f16("rgb");
        let (w_start, w_end) = (write.start, write.end);
        let (itx, irx) = std::sync::mpsc::sync_channel::<Result<(Data<'static>, Data<'static>), Error>>(2);
        // loop: SERIAL-REQUIRED — the low-VRAM stage-2 producer: frames in order; ends at the clip's end, an error, or a dropped receiver
        let producer = crate::ahead::spawn_named("s2-inputs", move || {
            let mut prep_s = 0.0;
            // loop: SERIAL-REQUIRED — frames in order; ends at the last written frame, an error, or a dropped receiver
            for t in 0..w_end {
                let tp = Instant::now();
                let item = reader.next_frame().and_then(|f| f.ok_or_else(|| Error::input("short read".into())));
                if t < w_start && item.is_ok() {
                    continue;
                }
                let item = item.and_then(|f| {
                    let b = bf.get(t, t + 1)?;
                    let rgb = Data::Bf16(vec![&f.model[..]]);
                    Ok((if rgb_f16 { Data::F16(rgb.into_f16()) } else { Data::F32(rgb.into_f32()) }, Data::F16(b)))
                });
                prep_s += tp.elapsed().as_secs_f64();
                let stop = item.is_err();
                if itx.send(item).is_err() || stop {
                    break;
                }
            }
            (reader.seconds(), prep_s)
        })?;
        let mut res = Ok(());
        // loop: SERIAL-REQUIRED — frames in order to the writers
        for _ in write {
            let tw = Instant::now();
            // loop: SERIAL-REQUIRED — stage 2's next input, in order [bounded: the producer sends every frame or its error, then ends]
            let item = irx.recv().map_err(|_| Error::engine("the stage-2 input thread stopped".into())).and_then(|r| r);
            self.s2_host[0] += tw.elapsed().as_secs_f64();
            if let Err(e) = item.and_then(|(rgb, b)| self.stage2_run(rgb, b, meta, out, sink)) {
                res = Err(e);
                break;
            }
        }
        drop(irx);
        // loop: SERIAL-REQUIRED — joins the producer after the receiver is dropped [bounded: its next send fails and it ends]
        let (dec_s, prep_s) = crate::ahead::joined(producer)?;
        res?;
        sink.log(&format!("    stage 2 phase: inputs prepared on their own thread in {prep_s:.1} s"));
        times.decode_s += dec_s;
        times.phase("stage2");
        Ok(())
    }

    /// The attempt's measured time per part (a `log` reply).
    fn timing_line(&mut self, times: &JobTimes, worker_s: f64, sink: &mut dyn Sink) {
        self.fold_stats();
        // loop: NOT-WORTH — five networks, once per job (the timing line)
        let each: Vec<String> = self.load_each.iter().map(|(p, s)| format!("{p} {s:.2}")).collect();
        let mut parts: Vec<String> = vec![
            format!("decode+prep {:.1} s", times.decode_s),
            format!("session loads {:.1} s on the main thread ({}), {:.1} s ahead on their own thread", self.load_s, each.join(", "), self.preload_s),
        ];
        // loop: NOT-WORTH — five networks
        for p in crate::runtime::PIECES {
            if let Some(NetTotals { run_s, convert_s, calls, first_s }) = self.stats.get(p) {
                parts.push(format!("{p} {run_s:.1} s run (first calls {first_s:.1} s) + {convert_s:.1} s convert ({calls} calls)"));
            }
        }
        parts.push(format!(
            "stage 1 host: inputs {:.1} s, after {:.1} s, blend {:.1} s (waited {:.1} s)",
            times.s1_in_s, times.s1_out_s, times.blend_s, times.blend_wait_s
        ));
        parts.push(format!("stage 2 calls + hand-off in the windows {:.1} s", times.render_s));
        parts.push(format!(
            "stage 2 main thread: inputs {:.1} s, waiting for the render thread {:.1} s; render thread {worker_s:.1} s",
            self.s2_host[0], self.s2_host[1]
        ));
        // loop: NOT-WORTH — ≤ four phases, once per job
        let ph: Vec<String> = times.phases.iter().map(|(n, s)| format!("{n} {s:.1} s")).collect();
        parts.push(format!("phases: {}", ph.join(", ")));
        sink.log(&format!("  timing: {}; wall {:.1} s", parts.join(", "), times.started.elapsed().as_secs_f64()));
    }

    /// C-RADIO and MoGe on `n` frames' resized inputs (`foundation_inputs`). Core ML's fixed-batch files: fewer
    /// frames than the batch are padded with copies of the last one, and only the `n` frames' features are kept.
    fn foundation_run(&mut self, n: usize, mut radio: Vec<f32>, mut moge: Vec<f32>, sh: usize, sw: usize) -> Result<(Data<'static>, Data<'static>), Error> {
        let (hr, wr) = (sh / 4, sw / 4);
        let (hm, wm) = (sh * 7 / 32, sw * 7 / 32);
        let fixed = self.key.as_ref().and_then(|k| k.coreml.as_ref()).map(|c| c.foundation_batch);
        let b = match fixed {
            Some(f) if n < f => {
                pad_frames(&mut radio, 3 * hr * wr, f - n);
                pad_frames(&mut moge, 3 * hm * wm, f - n);
                f
            }
            _ => n,
        };
        let c =
            // loop: NOT-WORTH — one output per C-RADIO call
            self.net("cradio")?.run(vec![("rgb", vec![b, 3, hr, wr], radio.into())])?.into_iter().next().ok_or_else(|| Error::engine("cradio: no output".into()))?;
        // loop: NOT-WORTH — one output per MoGe call
        let m =
            self.net("moge")?.run(vec![("rgb", vec![b, 3, hm, wm], moge.into())])?.into_iter().next().ok_or_else(|| Error::engine("moge: no output".into()))?;
        if c.0 != vec![b, CRADIO_CH, sh / 64, sw / 64] || m.0 != vec![b, MOGE_CH, sh / 64, sw / 64] {
            return Err(Error::engine(format!("foundation shapes {:?} / {:?}", c.0, m.0)));
        }
        let per = (sh / 64) * (sw / 64);
        Ok((keep_frames(c.1, n * CRADIO_CH * per)?, keep_frames(m.1, n * MOGE_CH * per)?))
    }

    /// Blended states that are final: to the low-VRAM file, or straight to stage 2.
    fn baton_frames(
        &mut self,
        ready: Vec<(usize, Vec<half::f16>)>,
        baton_file: &mut Option<F16File>,
        stage2_frames: &mut BTreeMap<usize, S2Rgb>,
        meta: &ClipMeta,
        out: &mut Writing<'_, '_>,
        sink: &mut dyn Sink,
    ) -> Result<(), Error> {
        let write = meta.write_range();
        // loop: SERIAL-REQUIRED — frames go to the writers in order
        for (t, b) in ready {
            if !write.contains(&t) {
                // a ranged job's warm-up or tail frame: keyed (its state was blended, its carry hint taken), never
                // written, so no stage 2
                stage2_frames.remove(&t);
                continue;
            }
            match baton_file {
                Some(f) => f.put(t, &b)?,
                None => {
                    let rgb = stage2_frames.remove(&t).ok_or_else(|| Error::engine(format!("frame {t} not cached for stage 2")))?;
                    let n = 3 * meta.shape_h * meta.shape_w;
                    match &rgb {
                        S2Rgb::Window(w, j) => {
                            let frame = match w.view() {
                                Data::F16Ref(v) => Data::F16Ref(&v[j * n..(j + 1) * n]),
                                Data::F32Ref(v) => Data::F32Ref(&v[j * n..(j + 1) * n]),
                                _ => return Err(Error::engine("stage 1's rgb not float16 / float32".into())),
                            };
                            self.stage2_run(frame, Data::F16(b), meta, out, sink)?;
                        }
                        // converted inside the run, once, to the type stage 2 takes
                        S2Rgb::Frame(model) => self.stage2_run(Data::Bf16(vec![&model[..]]), Data::F16(b), meta, out, sink)?,
                    }
                }
            }
        }
        Ok(())
    }

    /// Stage 2 on one frame; its output goes to the render thread (rendered and handed to every writer there).
    fn stage2_run(&mut self, rgb: Data<'_>, baton: Data<'_>, meta: &ClipMeta, out: &mut Writing<'_, '_>, sink: &mut dyn Sink) -> Result<(), Error> {
        stop_point(sink)?;
        let (sh, sw) = (meta.shape_h, meta.shape_w);
        let outs = self.net("stage2")?.run(vec![("rgb", vec![1, 1, 3, sh, sw], rgb), ("baton", vec![1, 1, BATON_CH, sh / 16, sw / 16], baton)])?;
        // the logits go to the render thread as stage 2 made them (float16 there becomes float32 off this thread)
        let (_, logits) = outs.into_iter().next().ok_or_else(|| Error::engine("stage2: no logits".into()))?;
        if logits.len() != 4 * sh * sw {
            return Err(Error::engine(format!("stage2: {} logits for {}x{}", logits.len(), sw, sh)));
        }
        let t = Instant::now();
        let sent = out.render.send(logits);
        self.s2_host[1] += t.elapsed().as_secs_f64();
        if let Some(done) = out.render.done() {
            out.report.count(done, sink, false);
        }
        sent
    }
}

/// A job's stop point (`Sink::stop_requested`): `cancelled` when the sink asks the job to stop.
pub(super) fn stop_point(sink: &mut dyn Sink) -> Result<(), Error> {
    if sink.stop_requested() {
        return Err(Error::new(crate::ErrorCode::Cancelled, "stopped on request".into()));
    }
    Ok(())
}

fn bf16_to_f32(v: &[half::bf16], out: &mut Vec<f32>) {
    use rayon::prelude::*;
    let start = out.len();
    out.resize(start + v.len(), 0.0);
    // loop: HOT-PATH-OK — one frame's display view to float32 (RVM / foundation inputs), parallel
    out[start..].par_iter_mut().with_min_len(1 << 14).zip(v.par_iter()).for_each(|(o, x)| *o = x.to_f32());
}

/// A window's hint tensor in the graph's type: each frame's matte (`src[j]`, bfloat16-rounded values) through `conv`
/// (float16: `half::f16::from_f32`, the same rounding the float32 window's conversion in the run did), zero where a
/// frame has none.
pub(super) fn hint_window<T: Copy + Default + Send + Sync>(src: &[Option<&[f32]>], plane: usize, conv: impl Fn(f32) -> T + Sync + Send) -> Vec<T> {
    use rayon::prelude::*;
    let mut out = vec![T::default(); src.len() * plane];
    // loop: HOT-PATH-OK — the window's frames (≤ 80); each matte converted once, in parallel
    for (dst, s) in out.chunks_mut(plane).zip(src) {
        if let Some(s) = s {
            // loop: HOT-PATH-OK — one frame's matte into the tensor, parallel
            dst.par_iter_mut().with_min_len(1 << 14).zip(s.par_iter()).for_each(|(d, &v)| *d = conv(v));
        }
    }
    out
}

/// C-RADIO's and MoGe's inputs for frames: display RGB area-resized to 1/4 and 7/32.
fn foundation_inputs(frames: &[Prepped], sh: usize, sw: usize) -> (Vec<f32>, Vec<f32>) {
    let n = frames.len();
    let (hr, wr) = (sh / 4, sw / 4);
    let (hm, wm) = (sh * 7 / 32, sw * 7 / 32);
    let mut radio = Vec::with_capacity(n * 3 * hr * wr);
    let mut moge = Vec::with_capacity(n * 3 * hm * wm);
    // loop: HOT-PATH-OK — the window's frames
    for f in frames {
        let mut d = Vec::with_capacity(f.display.len());
        bf16_to_f32(&f.display, &mut d);
        let p = Planar::from_vec(3, sh, sw, d);
        radio.extend(resize_area(&p, hr, wr).data);
        moge.extend(resize_area(&p, hm, wm).data);
    }
    (radio, moge)
}

/// Append `extra` copies of the last frame (`frame` values each) to `v` (a fixed-batch network's padding).
fn pad_frames(v: &mut Vec<f32>, frame: usize, extra: usize) {
    if frame == 0 || v.len() < frame {
        return;
    }
    let last = v.len() - frame;
    v.reserve(frame * extra);
    // loop: NOT-WORTH — ≤ 3 padding frames, only on Core ML's last prepass chunk
    for _ in 0..extra {
        v.extend_from_within(last..last + frame);
    }
}

/// The first `len` values of a network output (a padded batch's own frames).
fn keep_frames(d: Data<'static>, len: usize) -> Result<Data<'static>, Error> {
    match d {
        Data::F32(mut v) if v.len() >= len => {
            v.truncate(len);
            Ok(Data::F32(v))
        }
        Data::F16(mut v) if v.len() >= len => {
            v.truncate(len);
            Ok(Data::F16(v))
        }
        // a network's output in ONNX Runtime's buffer: as it is when it has just these frames, else copied
        Data::Out(..) if d.len() == len => Ok(d),
        Data::Out(..) if d.len() > len => Ok(match d.view() {
            Data::F16Ref(v) => Data::F16(v[..len].to_vec()),
            Data::F32Ref(v) => Data::F32(v[..len].to_vec()),
            _ => return Err(Error::engine("a network output not float16 / float32".into())),
        }),
        other => Err(Error::engine(format!("a network output of {} values, {len} expected", other.len()))),
    }
}

#[cfg(test)]
mod coreml_batch_tests {
    use super::*;

    #[test]
    fn padded_batch_keeps_only_its_own_frames() {
        // two frames of 3 values, padded to a fixed batch of 4 with copies of the last frame
        let mut v = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        pad_frames(&mut v, 3, 2);
        assert_eq!(v, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 4.0, 5.0, 6.0, 4.0, 5.0, 6.0]);
        match keep_frames(Data::F32(v), 6).unwrap() {
            Data::F32(k) => assert_eq!(k, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]),
            _ => panic!("type changed"),
        }
        assert!(keep_frames(Data::F16(vec![half::f16::ZERO; 2]), 6).is_err());
    }
}
