//! The subcommands (docs/CLI.md). `render` keys into a staging folder beside the output (`.corridorkey-<run>`, same
//! drive) and only after the whole job renames the requested frames to their final names: a failed, stopped or killed
//! run never leaves a frame at a final name, and a step or list (`1001-1100x2`) keys the whole span (the networks are
//! temporal) and keeps only the frames asked for.
use crate::args::Kind;
use crate::exit;
use crate::frames::{self, Output, Pattern};
use crate::progress::{CliSink, Format, Verbosity};
use crate::report::Report;
use ck_core::config::EngineConfig;
use ck_core::runtime::{ModelSet, Runtime};
use clap::ArgMatches;
use serde_json::{json, Map, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Why a run ends without success: its exit code and what to say.
#[derive(Debug)]
pub struct Fail {
    pub exit: i32,
    pub message: String,
}

fn fail(exit: i32, message: impl Into<String>) -> Fail {
    Fail { exit, message: message.into() }
}

impl From<ck_core::Error> for Fail {
    fn from(e: ck_core::Error) -> Fail {
        Fail { exit: exit::for_error(e.code, crate::signals::stopped_by()), message: e.message }
    }
}

/// The whole command line: parse, run, the exit code.
pub fn main(argv: Vec<OsString>) -> i32 {
    let m = match crate::args::command().try_get_matches_from(argv) {
        Ok(m) => m,
        Err(e) => {
            // --help / --version print to stdout and exit 0; a mistake prints to stderr and exits 2 (clap's own)
            let _ = e.print();
            return e.exit_code();
        }
    };
    let (name, sub) = m.subcommand().expect("a subcommand is required");
    // the card, before ONNX Runtime or the CUDA driver starts (no other thread exists yet)
    if let Some(v) = crate::cuda_visible(
        sub.try_get_one::<String>("gpu").ok().flatten().map(String::as_str),
        std::env::var("CUDA_VISIBLE_DEVICES").ok().as_deref(),
        std::env::var("CUE_GPU_CORES").ok().as_deref(),
    ) {
        std::env::set_var("CUDA_VISIBLE_DEVICES", v);
    }
    ck_core::config::set_process_env();
    let verbosity = if sub.try_get_one::<bool>("quiet").ok().flatten() == Some(&true) {
        Verbosity::Quiet
    } else if sub.try_get_one::<bool>("verbose").ok().flatten() == Some(&true) {
        Verbosity::Verbose
    } else {
        Verbosity::Normal
    };
    let fmt = sub.try_get_one::<String>("progress-format").ok().flatten().and_then(|f| Format::parse(f)).unwrap_or(Format::Both);
    let (mut out, mut err) = (std::io::stdout(), std::io::stderr());
    let mut sink = CliSink::new(fmt, verbosity, &mut out, &mut err);
    let started = Instant::now();
    let mut report = Report { command: if name == "verify" { "verify" } else { "render" }, ..Report::default() };
    let res = match name {
        "render" => render(sub, false, &mut sink, &mut report),
        "verify" => render(sub, true, &mut sink, &mut report),
        "prepare" => prepare(sub, &mut sink),
        "info" => info(sub),
        _ => Err(fail(exit::USAGE, format!("unknown command {name}"))),
    };
    let mut code = match &res {
        Ok(()) => exit::DONE,
        Err(f) => f.exit,
    };
    if let Some(path) = sub.try_get_one::<String>("report").ok().flatten() {
        report.command = if name == "prepare" { "prepare" } else { report.command };
        report.exit = code;
        report.message = res.as_ref().err().map(|f| f.message.clone());
        report.seconds = started.elapsed().as_secs_f64();
        report.seen = sink.seen.clone();
        if let Err(e) = report.write(Path::new(path)) {
            sink.fail(exit::OUTPUT, &e);
            if code == exit::DONE {
                code = exit::OUTPUT;
            }
        }
    }
    if let Err(f) = &res {
        sink.fail(f.exit, &f.message);
    }
    code
}

/// A string argument, if given.
fn opt<'a>(m: &'a ArgMatches, id: &str) -> Option<&'a str> {
    m.try_get_one::<String>(id).ok().flatten().map(String::as_str)
}

/// The engine's settings from the runtime flags (and the CK_ENGINE_* environment, as the engine reads it).
fn engine_config(m: &ArgMatches) -> Result<EngineConfig, Fail> {
    let mut args = vec!["corridorkey".to_string()];
    // loop: NOT-WORTH — three flags
    for k in ["models", "ort", "device"] {
        if let Some(v) = opt(m, k) {
            args.extend([format!("--{k}"), v.to_string()]);
        }
    }
    let threads = m.try_get_one::<u32>("threads").ok().flatten().map(|t| t.to_string());
    let env = move |k: &str| if k == "CK_ENGINE_THREADS" && threads.is_some() { threads.clone() } else { std::env::var(k).ok() };
    EngineConfig::parse(&args, &env, std::env::consts::OS).map_err(|e| fail(exit::USAGE, e))
}

/// The runtime and model set a job needs; Err: what is missing (exit 7), or a build without OpenColorIO (exit 8).
fn runtime(cfg: &EngineConfig, report: &mut Report) -> Result<(&'static Runtime, ModelSet), Fail> {
    ck_core::ocio::require_real_ocio().map_err(|e| fail(exit::ENGINE, e))?;
    let Some(models) = cfg.models.clone() else {
        return Err(fail(exit::ASSETS, "no models: give the model set's folder with --models DIR (or CK_ENGINE_MODELS)"));
    };
    if !models.is_dir() {
        return Err(fail(exit::ASSETS, format!("no models folder at {} (--models DIR, or CK_ENGINE_MODELS)", models.display())));
    }
    let rt = Runtime::init(cfg).map_err(|e| fail(exit::ASSETS, format!("ONNX Runtime didn't load: {} (--ort LIB, or CK_ENGINE_ORT)", e.message)))?;
    let set = ModelSet::open(&models).map_err(|e| fail(exit::ASSETS, e.message))?;
    report.models_dir = Some(models.to_string_lossy().into_owned());
    report.model_set = set.version.clone();
    report.onnxruntime = Some(rt.ort_version.clone());
    report.gpu = rt.gpu.as_ref().map(|g| json!({"name": g.name, "driver": g.driver, "vram_total_mb": g.total / 1048576}));
    Ok((rt, set))
}

/// The run's own name: two runs of one clip (on one machine, or sharing a folder) never share a file.
fn run_id() -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    format!("{}-{t:x}", std::process::id())
}

/// The run's folders, removed with everything in them when the run ends, however it ends (a SIGKILL leaves them:
/// hidden `.corridorkey-<run>` folders, safe to delete).
struct RunDirs(Vec<PathBuf>);

impl Drop for RunDirs {
    fn drop(&mut self) {
        // loop: NOT-WORTH — two folders
        for d in &self.0 {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

/// One result file: where the engine writes it, where it goes.
struct Target {
    staged: PathBuf,
    target: PathBuf,
    /// an EXR frame (checked whole), else a video
    exr: bool,
}

/// The job file's run object (`--job`), checked.
fn job_file(path: &str) -> Result<Map<String, Value>, Fail> {
    let text = std::fs::read_to_string(path).map_err(|e| fail(exit::USAGE, format!("--job {path}: {e}")))?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(o)) => Ok(o),
        Ok(_) => Err(fail(exit::USAGE, format!("--job {path}: not a run object ({{\"input\", \"output_dir\", \"options\"}})"))),
        Err(e) => Err(fail(exit::USAGE, format!("--job {path}: {e}"))),
    }
}

/// `render` and `verify`.
fn render(m: &ArgMatches, verify: bool, sink: &mut CliSink, report: &mut Report) -> Result<(), Fail> {
    let job = match opt(m, "job") {
        Some(p) => job_file(p)?,
        None => Map::new(),
    };
    let jstr = |k: &str| job.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let input = opt(m, "input").or(opt(m, "clip")).map(str::to_string).or_else(|| jstr("input"));
    let output = opt(m, "output").map(str::to_string).or_else(|| jstr("output_dir"));
    let usage = "corridorkey render -i plates/sh010.####.exr -o key/sh010_key.####.exr";
    let Some(output) = output else {
        return Err(fail(exit::USAGE, format!("where should the results go? Give -o DIR or -o key.####.exr (as in {usage})")));
    };
    report.output = Some(output.clone());
    let out = frames::parse_output(&output).map_err(|e| fail(exit::USAGE, e))?;
    let mut options = match job.get("options") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(o)) => o.clone(),
        Some(_) => return Err(fail(exit::USAGE, "--job: options must be an object")),
    };
    // loop: NOT-WORTH — three option names
    for k in ["num_frames", "start_mode", "seed"] {
        if options.contains_key(k) {
            return Err(fail(exit::USAGE, format!("--job: {k} picks a preview sample in the app; on the command line --frames picks the frames")));
        }
    }
    // the flags win over the job file
    // loop: NOT-WORTH — the run options' flags, once per run
    for (flag, key, kind, ..) in crate::args::RUN_OPTIONS {
        match kind {
            Kind::On if m.get_flag(flag) => {
                options.insert(key.into(), json!(true));
            }
            Kind::Off if m.get_flag(flag) => {
                options.insert(key.into(), json!(false));
            }
            Kind::Text | Kind::Number => {
                if let Some(v) = opt(m, flag) {
                    options.insert(key.into(), json!(v));
                }
            }
            _ => {}
        }
    }
    if let Some(list) = opt(m, "outputs") {
        // loop: NOT-WORTH — ≤ four names
        options.insert("outputs".into(), json!(list.split(',').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>()));
    }
    if let Some(w) = opt(m, "window") {
        let (c, s) = w.split_once('/').map(|(c, s)| (c, Some(s))).unwrap_or((w, None));
        options.insert("hann_chunk".into(), json!(c.trim()));
        if let Some(s) = s {
            options.insert("hann_stride".into(), json!(s.trim()));
        }
    }
    // EXR is the farm's format (the app's default is video)
    options.entry("output_format").or_insert(json!("exr"));

    // the frames asked for: -F, -s / -e, or the job file's range
    let job_range = (options.remove("frame_start"), options.remove("frame_end"));
    let spec: Option<String> = m.get_many::<String>("frames").map(|v| v.cloned().collect::<Vec<_>>().join(","));
    let (start, end) = (m.get_one::<u64>("start").copied(), m.get_one::<u64>("end").copied());
    let has_range = spec.is_some() || start.is_some() || end.is_some() || job_range.0.is_some() || job_range.1.is_some();
    if !has_range && (options.contains_key("preroll") || options.contains_key("tail")) {
        return Err(fail(exit::USAGE, "--preroll and --tail warm up a part of the shot: give the part with -F (or -s / -e) too"));
    }

    // the clip
    let Some(input) = input else {
        return Err(fail(exit::USAGE, format!("which clip? Give -i INPUT (a video, a frame folder or plate.####.exr), as in {usage}")));
    };
    report.input = Some(input.clone());
    let input = match Pattern::parse(&input) {
        Some(p) => frames::input_folder(&p.map_err(|e| fail(exit::USAGE, e))?).map_err(|e| fail(exit::INPUT, e))?.to_string_lossy().into_owned(),
        None => input,
    };
    if !Path::new(&input).exists() {
        return Err(fail(exit::INPUT, format!("input not found: {input}")));
    }
    let meta = ck_core::clip::probe_size(Path::new(&input), -1, 1.0)?;
    let shot = ck_core::clip::FrameNumbers::for_source(&meta.source, meta.num_frames);
    let (Some(&first), Some(&last)) = (shot.numbers.first(), shot.numbers.last()) else {
        return Err(fail(exit::INPUT, format!("{input}: no frames")));
    };
    let whole_number = |v: &Value, what: &str| {
        v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).ok_or_else(|| fail(exit::USAGE, format!("--job: {what} must be a whole number")))
    };
    let describe = shot.describe();
    let outside = |what: String| fail(exit::USAGE, format!("{what} is outside the shot ({first}-{last}, {} frames; numbered {describe})", shot.numbers.len()));
    // the shot's frames numbered a..=b (a folder may skip numbers); ends outside the shot are refused, as -F's are
    // (a farm would mark frames done that were never written)
    let in_shot = |a: u64, b: u64, (sa, sb): (&str, &str)| -> Result<Vec<u64>, Fail> {
        if !(first..=last).contains(&a) {
            return Err(outside(format!("{sa} {a}")));
        }
        if !(first..=last).contains(&b) {
            return Err(outside(format!("{sb} {b}")));
        }
        if a > b {
            return Err(fail(exit::USAGE, format!("{sa} {a} is after {sb} {b} (write {sa} {b} {sb} {a})")));
        }
        // loop: NOT-WORTH — the shot's numbers, once per run
        Ok(shot.numbers.iter().copied().filter(|n| (a..=b).contains(n)).collect())
    };
    // a spec keys to the end of its ranges (`1001-1100x2`: to 1100, as `1001-1100` does), clamped to the shot
    let mut key_end = None;
    let requested: Option<Vec<u64>> = if let Some(spec) = spec {
        let (r, end) = frames::parse_frames(&spec).map_err(|e| fail(exit::USAGE, format!("-F {e}")))?;
        key_end = Some(end.min(last));
        Some(r)
    } else if start.is_some() || end.is_some() {
        let (a, b) = (start.unwrap_or(first), end.unwrap_or(last));
        Some(in_shot(a, b, ("-s", "-e"))?)
    } else {
        match job_range {
            (Some(a), Some(b)) => {
                let (a, b) = (whole_number(&a, "frame_start")?, whole_number(&b, "frame_end")?);
                Some(in_shot(a, b, ("--job: frame_start", "--job: frame_end"))?)
            }
            (None, None) => None,
            _ => return Err(fail(exit::USAGE, "--job: frame_start and frame_end go together: give both")),
        }
    };
    if let Some(r) = &requested {
        // loop: NOT-WORTH — the frames asked for, once per run
        if let Some(n) = r.iter().find(|n| shot.numbers.binary_search(n).is_err()) {
            if !(first..=last).contains(n) {
                return Err(outside(format!("frame {n}")));
            }
            return Err(fail(exit::USAGE, format!("the shot has no frame {n} ({first}-{last}, {} frames; numbered {describe})", shot.numbers.len())));
        }
        if r.is_empty() {
            return Err(fail(exit::USAGE, format!("no frame of the shot ({first}-{last}) in -s / -e")));
        }
        let end = key_end.unwrap_or(0).max(r[r.len() - 1]);
        options.insert("frame_start".into(), json!(r[0]));
        options.insert("frame_end".into(), json!(end));
        key_end = Some(end);
    }
    // the frames the engine writes (the span), and the ones kept
    let span: Vec<u64> = match (&requested, key_end) {
        // loop: NOT-WORTH — the shot's numbers, once per run
        (Some(r), Some(end)) => shot.numbers.iter().copied().filter(|n| (r[0]..=end).contains(n)).collect(),
        _ => shot.numbers.clone(),
    };
    let kept = requested.clone().unwrap_or_else(|| span.clone());
    report.requested = requested.clone().unwrap_or_default();
    report.span = span.clone();

    // the job as the engine takes it (the protocol's own checks), with the run's own folders
    let run = run_id();
    let target_dir = match &out {
        Output::Folder(d) => d.clone(),
        Output::Pattern(p) => p.dir.clone(),
    };
    let staging = if target_dir.as_os_str().is_empty() { PathBuf::from(".") } else { target_dir.clone() }.join(format!(".corridorkey-{run}"));
    let temp_root = opt(m, "temp")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("OPENJD_SESSION_WORKING_DIR").filter(|v| !v.is_empty()).map(PathBuf::from))
        .or_else(|| jstr("temp_dir").map(PathBuf::from))
        .unwrap_or_else(std::env::temp_dir);
    let temp = temp_root.join(format!("corridorkey-{run}"));
    let req = json!({"id": "corridorkey", "input": input, "output_dir": staging, "temp_dir": temp, "options": options});
    let job = ck_core::job::parse(&req).map_err(|e| fail(exit::USAGE, crate::args::in_flag_words(&e.message)))?;
    if !job.exr && matches!(out, Output::Pattern(_)) {
        return Err(fail(exit::USAGE, format!("{output}: a frame pattern is for EXR; video outputs go in a folder (-o out/)")));
    }
    if !job.exr && requested.as_ref().is_some_and(|r| r.len() != shot.numbers.len()) {
        return Err(fail(exit::USAGE, "a video can't be split: key the whole shot for video outputs, or use EXR (the default) for a part of it"));
    }

    // every result file: where the engine writes it, where it goes
    let clip = ck_core::clip::raw_clip_name(&input);
    let mut targets = Vec::new();
    // loop: NOT-WORTH — ≤ four outputs
    for name in &job.outputs {
        let sfx = ck_core::job::suffix(name, job.despill_strength);
        if !job.exr {
            let file = format!("{clip}_{sfx}.{}", job.writer.codec.ext());
            targets.push(Target { staged: staging.join(&file), target: target_dir.join(&file), exr: false });
            continue;
        }
        let folder = format!("{clip}_{sfx}_exr");
        let pattern = match &out {
            Output::Pattern(p) if job.outputs.len() > 1 => Some(p.for_output(name)),
            Output::Pattern(p) => Some(p.clone()),
            Output::Folder(_) => None,
        };
        // loop: NOT-WORTH — one target per kept frame, once per run
        for &n in &kept {
            let file = format!("{clip}_{sfx}.{n:0w$}.exr", w = shot.width);
            let target = match &pattern {
                Some(p) => p.path(n),
                None => target_dir.join(&folder).join(&file),
            };
            targets.push(Target { staged: staging.join(&folder).join(&file), target, exr: true });
        }
    }
    let settings = (
        staging.join(format!("{clip}_settings.txt")),
        match &out {
            Output::Pattern(p) => p.settings_path(),
            Output::Folder(_) => target_dir.join(format!("{clip}_settings.txt")),
        },
    );

    let whole = |t: &Target| if t.exr { ck_core::writers::exr_complete(&t.target) } else { std::fs::metadata(&t.target).is_ok_and(|m| m.len() > 0) };
    if verify {
        // loop: NOT-WORTH — one check per target, once per run (each reads its file)
        let missing: Vec<String> = targets.iter().filter(|t| !whole(t)).map(|t| t.target.to_string_lossy().into_owned()).collect();
        report.missing = missing.clone();
        if missing.is_empty() {
            sink.note(&format!("verify: all {} file(s) there and whole", targets.len()));
            return Ok(());
        }
        // loop: NOT-WORTH — the missing files, printed once
        for f in &missing {
            println!("missing or incomplete: {f}");
        }
        return Err(fail(exit::INCOMPLETE, format!("{} of {} file(s) missing or incomplete (first: {})", missing.len(), targets.len(), missing[0])));
    }
    // loop: NOT-WORTH — one existence check per target, once per run
    let existing: Vec<&Target> = targets.iter().filter(|t| t.target.exists()).collect();
    // loop: NOT-WORTH — reads each target once, only when all of them are there
    if m.get_flag("skip-existing") && existing.len() == targets.len() && targets.iter().all(whole) {
        sink.note(&format!("every requested file ({}) is already there and whole: nothing to do (--skip-existing)", targets.len()));
        report.skipped = true;
        report.kept = kept;
        return Ok(());
    }
    if let Some(t) = existing.first().filter(|_| !m.get_flag("overwrite") && !m.get_flag("skip-existing")) {
        let more = if existing.len() > 1 { format!(" (and {} more)", existing.len() - 1) } else { String::new() };
        return Err(fail(
            exit::OUTPUT,
            format!("{} is already there{more}: add --overwrite to replace, or --skip-existing to keep a whole set", t.target.display()),
        ));
    }

    let cfg = engine_config(m)?;
    let (rt, set) = runtime(&cfg, report)?;
    sink.note(&format!(
        "corridorkey {}: ONNX Runtime {}, provider {}, models {}{}",
        crate::VERSION,
        rt.ort_version,
        rt.provider().map(|p| p.name()).unwrap_or("none"),
        set.dir.display(),
        set.version.as_deref().map(|v| format!(" ({v})")).unwrap_or_default()
    ));
    let _dirs = RunDirs(vec![staging.clone(), temp.clone()]);
    // the output folder holds the staging folder; the results' own folders are made when they arrive
    let mkdir = |d: &Path| match d.as_os_str().is_empty() {
        true => Ok(()),
        false => std::fs::create_dir_all(d).map_err(|e| fail(exit::OUTPUT, format!("can't make the output folder {}: {e}", d.display()))),
    };
    mkdir(&target_dir)?;
    crate::signals::install();
    let mut pipeline = ck_core::pipeline::Pipeline::new(rt, set);
    // a panic in the engine is an engine error with its words, the run's folders still removed
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pipeline.run(&job, sink)))
        .unwrap_or_else(|p| Err(ck_core::Error::engine(format!("internal error: {}", ck_core::panic_message(&*p)))));
    if let Err(e) = res {
        let mut f = Fail::from(e);
        if let Some(sig) = crate::signals::stopped_by() {
            f.message = format!("stopped by {} ({}); nothing was put at the output's names", if sig == 2 { "SIGINT" } else { "SIGTERM" }, f.message);
        }
        return Err(f);
    }
    // the job is whole: its frames to their names (renames on one drive)
    // loop: NOT-WORTH — one rename per target, once per run
    for t in &targets {
        if !t.staged.exists() {
            return Err(fail(exit::ENGINE, format!("the engine didn't write {}", t.staged.display())));
        }
        mkdir(t.target.parent().unwrap_or(Path::new("")))?;
        std::fs::rename(&t.staged, &t.target).map_err(|e| fail(exit::OUTPUT, format!("can't put {} in place: {e}", t.target.display())))?;
    }
    let _ = std::fs::rename(&settings.0, &settings.1);
    report.kept = kept;
    sink.note(&format!("wrote {} file(s) to {output}", targets.len()));
    Ok(())
}

/// `prepare`: what a farm task needs, checked before tasks start (and TensorRT built for a size).
fn prepare(m: &ArgMatches, sink: &mut CliSink) -> Result<(), Fail> {
    let cfg = engine_config(m)?;
    let mut report = Report::default();
    let (rt, set) = runtime(&cfg, &mut report)?;
    println!("onnxruntime: {}", rt.ort_version);
    let Some(provider) = rt.provider() else {
        return Err(fail(exit::NO_GPU, rt.unavailable_reason()));
    };
    let precision = rt.precision(provider);
    // loop: NOT-WORTH — five networks
    let missing: Vec<String> = set.assets(precision).into_iter().filter(|(_, have)| !have).map(|(p, _)| p).collect();
    if !missing.is_empty() {
        return Err(fail(exit::ASSETS, format!("missing ONNX model(s) {} ({}) in {}", missing.join(", "), precision.name(), set.dir.display())));
    }
    println!("models: {} ({}, {})", set.dir.display(), set.version.as_deref().unwrap_or("no manifest"), precision.name());
    println!("provider: {} (tensorrt available: {})", provider.name(), rt.tensorrt_ep);
    let ffmpeg =
        ck_core::decode::tool_version("ffmpeg").map_err(|_| fail(exit::ASSETS, "ffmpeg binary not found: install ffmpeg (it reads and writes the videos)"))?;
    println!("ffmpeg: {ffmpeg}");
    match (&rt.gpu, provider) {
        (_, ck_core::runtime::Provider::Cpu) => {
            println!("memory: {:.1} GB free on the host (CPU provider)", ck_core::gpu::host_available().unwrap_or(0) as f64 / 1073741824.0)
        }
        (Some(g), _) => {
            let free = ck_core::gpu::card_memory().map(|(_, free, _)| free).unwrap_or(0);
            println!("gpu: {} (driver {}), {:.1} GB free of {:.1} GB", g.name, g.driver, free as f64 / 1073741824.0, g.total as f64 / 1073741824.0);
        }
        (None, _) => {}
    }
    if let Some(size) = opt(m, "tensorrt-size") {
        let parsed = size.split_once(['x', 'X']).and_then(|(w, h)| Some((w.trim().parse::<usize>().ok()?, h.trim().parse::<usize>().ok()?)));
        let Some((w, h)) = parsed.filter(|(w, h)| (1..=16384).contains(w) && (1..=16384).contains(h)) else {
            return Err(fail(exit::USAGE, format!("--tensorrt-size {size}: write the clip's size as WIDTHxHEIGHT, as in 4096x2160")));
        };
        let cap = match opt(m, "max-vram") {
            Some(v) => Some(
                v.trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|g| g.is_finite() && *g > 0.0)
                    .ok_or_else(|| fail(exit::USAGE, format!("--max-vram {v}: a number of GB above 0")))?,
            ),
            None => None,
        };
        crate::signals::install();
        let mut pipeline = ck_core::pipeline::Pipeline::new(rt, set);
        let built = pipeline.trt_build(w, h, 1000, cap, sink)?;
        println!("tensorrt: {built}");
    }
    println!("ready");
    Ok(())
}

/// `info`: what this machine runs with.
fn info(m: &ArgMatches) -> Result<(), Fail> {
    let cfg = engine_config(m)?;
    let rt = Runtime::init(&cfg).map_err(|e| fail(exit::ASSETS, format!("ONNX Runtime didn't load: {} (--ort LIB, or CK_ENGINE_ORT)", e.message)))?;
    let set = cfg.models.as_ref().map(|d| ModelSet::open(d)).transpose().map_err(|e| fail(exit::ASSETS, e.message))?;
    let prov = rt.provider();
    let precision = prov.map(|p| rt.precision(p));
    let v = json!({
        "corridorkey": crate::VERSION,
        "engine": "onnxruntime",
        "onnxruntime": rt.ort_version,
        "device": cfg.device.name(),
        "provider": prov.map(|p| p.name()),
        "precision": precision.map(|p| p.name()),
        "unavailable": if prov.is_none() { Some(rt.unavailable_reason()) } else { None },
        "gpu": rt.gpu.as_ref().map(|g| json!({"name": g.name, "driver": g.driver, "vram_total_mb": g.total / 1048576})),
        "tensorrt_available": rt.tensorrt_ep,
        "coreml_available": rt.coreml_ep,
        "models": set.as_ref().map(|s| json!({"dir": s.dir, "set": s.version, "assets": precision.map(|p| json!(s.assets(p)))})),
        "ocio": ck_core::ocio::version(),
        "decoders": ck_core::decode::Decoders::read(None).to_json(),
    });
    if m.get_flag("json") {
        println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        return Ok(());
    }
    // loop: NOT-WORTH — the info's dozen keys
    for (k, val) in v.as_object().into_iter().flatten() {
        println!("{k}: {}", if let Value::String(s) = val { s.clone() } else { val.to_string() });
    }
    Ok(())
}
