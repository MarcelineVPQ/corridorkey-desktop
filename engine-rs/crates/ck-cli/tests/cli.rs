//! The `corridorkey` binary as a farm runs it: exit codes, messages, verify, --skip-existing / --overwrite, and a
//! launcher that exits before its task (PID 1 style). No models or card needed: these stop before the runtime.
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn bin() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_corridorkey"));
    // never a card in tests; no farm variables from the environment the tests run in
    c.env("CUDA_VISIBLE_DEVICES", "").env_remove("CUE_GPU_CORES").env_remove("OPENJD_SESSION_WORKING_DIR").env_remove("CK_ENGINE_MODELS");
    c
}

fn run(args: &[&str]) -> Output {
    bin().args(args).output().unwrap()
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// A scratch folder, removed when dropped.
struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch(tag: &str) -> Dir {
    let p = std::env::temp_dir().join(format!("ck-cli-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    Dir(p)
}

/// A whole 8x8 EXR at `p`.
fn exr(p: &Path) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    exr::prelude::write_rgb_file(p, 8, 8, |x, y| (x as f32 / 8.0, y as f32 / 8.0, 0.5)).unwrap();
}

/// A plate folder `plates` with frames `plate.0001.exr` ...
fn plates(d: &Path, numbers: &[u64]) -> PathBuf {
    let dir = d.join("plates");
    // loop: NOT-WORTH — a few test frames
    for n in numbers {
        exr(&dir.join(format!("plate.{n:04}.exr")));
    }
    dir
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

#[test]
fn usage_mistakes_exit_2_and_say_what_to_type() {
    let d = scratch("usage");
    let pl = plates(&d.0, &[1, 2, 3]);
    let out = d.0.join("out");
    let o = run(&["render", "-i", s(&pl)]);
    assert_eq!(o.status.code(), Some(2));
    assert!(text(&o.stderr).contains("-o DIR"), "{}", text(&o.stderr));
    // the farm's failure line on stdout
    assert!(text(&o.stdout).starts_with("openjd_fail: "), "{}", text(&o.stdout));
    let cases: [(&[&str], &str); 6] = [
        (&["-F", "3-1"], "write 1-3"),
        (&["-F", "5"], "outside the shot"),
        (&["--preroll", "8"], "-F"),
        (&["--hint-quality", "2"], "--hint-quality must be between 0 and 1"),
        (&["-s", "3", "-e", "1"], "write -s 1 -e 3"),
        (&["--format", "video", "-F", "1-2"], "a video can't be split"),
    ];
    // loop: NOT-WORTH — a test's few cases
    for (extra, says) in cases {
        let mut a = vec!["render", "-i", s(&pl), "-o", s(&out)];
        a.extend(extra);
        let o = run(&a);
        assert_eq!(o.status.code(), Some(2), "{extra:?}: {}", text(&o.stderr));
        assert!(text(&o.stderr).contains(says), "{extra:?}: {}", text(&o.stderr));
    }
    let o = run(&["render", "-i", s(&pl), "-o", &format!("{}/key.exr", s(&out))]);
    assert_eq!(o.status.code(), Some(2));
    assert!(text(&o.stderr).contains("key.####.exr"), "{}", text(&o.stderr));
    let o = run(&["render", "--frame", "1"]);
    assert_eq!(o.status.code(), Some(2));
    assert!(text(&o.stderr).contains("--frames"), "{}", text(&o.stderr));
    // a clip that isn't there is an input error
    let o = run(&["render", "-i", s(&d.0.join("nope.mov")), "-o", s(&out)]);
    assert_eq!(o.status.code(), Some(3), "{}", text(&o.stderr));
    // nothing was made at the output
    assert!(!out.exists());
}

#[test]
fn start_and_end_outside_the_shot_are_refused_as_frames_are() {
    // farm review 2026-10-26 M1: `-s 0 -e 99` on plates 1-3 verified the 3 frames there and exited 0, so a farm
    // marked frames done that were never written; -F refuses the same range (exit 2)
    let d = scratch("ends");
    let pl = plates(&d.0, &[1, 2, 3]);
    let pat = d.0.join("key/key.####.exr");
    // loop: NOT-WORTH — three frames
    for n in 1..=3 {
        exr(&d.0.join(format!("key/key.{n:04}.exr")));
    }
    let job = d.0.join("job.json");
    std::fs::write(&job, r#"{"options": {"frame_start": 2, "frame_end": 9}}"#).unwrap();
    let cases: [&[&str]; 6] = [&["-s", "0", "-e", "99"], &["-s", "0", "-e", "2"], &["-e", "4"], &["-s", "0"], &["-s", "4"], &["--job", s(&job)]];
    // loop: NOT-WORTH — a test's few cases
    for extra in cases {
        // loop: NOT-WORTH — both commands
        for cmd in ["verify", "render"] {
            let mut a = vec![cmd, "-i", s(&pl), "-o", s(&pat), "--outputs", "alpha", "--models", "/nonexistent/models"];
            a.extend(extra);
            let o = run(&a);
            assert_eq!(o.status.code(), Some(2), "{cmd} {extra:?}: {}", text(&o.stderr));
            assert!(text(&o.stderr).contains("outside the shot (1-3"), "{cmd} {extra:?}: {}", text(&o.stderr));
        }
    }
    // either end alone runs to the shot's end or from its start; ends inside the shot are fine
    // loop: NOT-WORTH — a test's few cases
    for extra in [&["-s", "2"][..], &["-e", "2"], &["-s", "1", "-e", "3"]] {
        let mut a = vec!["verify", "-i", s(&pl), "-o", s(&pat), "--outputs", "alpha"];
        a.extend(extra);
        assert_eq!(run(&a).status.code(), Some(0), "{extra:?}");
    }
}

#[test]
fn help_and_version_exit_0() {
    let o = run(&["--version"]);
    assert_eq!(o.status.code(), Some(0));
    // the app's version (package.json), not the Rust workspace's: farm logs and reports name the release
    let pkg: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../package.json")).unwrap()).unwrap();
    assert_eq!(text(&o.stdout).trim(), format!("corridorkey {}", pkg["version"].as_str().unwrap()));
    let o = run(&["render", "--help"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(text(&o.stdout).contains("Examples:"), "{}", text(&o.stdout));
    assert_eq!(run(&["help", "verify"]).status.code(), Some(0));
}

#[test]
fn spec_is_json_for_tools_and_hidden_from_help() {
    let o = run(&["__spec", "--json"]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
    let s: Value = serde_json::from_slice(&o.stdout).unwrap();
    let names: Vec<&str> = s["commands"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["render", "verify", "prepare", "info"]);
    // loop: NOT-WORTH — two help screens
    for args in [&["help"][..], &["--help"][..]] {
        let o = run(args);
        assert_eq!(o.status.code(), Some(0));
        let help = text(&o.stdout);
        assert!(help.contains("render") && !help.contains("__spec"), "{help}");
    }
    assert_eq!(run(&["__spec"]).status.code(), Some(2), "--json is required");
}

#[test]
fn verify_finds_missing_and_cut_frames() {
    let d = scratch("verify");
    let pl = plates(&d.0, &[1, 2, 3]);
    let pat = d.0.join("key").join("key.####.exr");
    let report = d.0.join("r.json");
    let verify = || run(&["verify", "-i", s(&pl), "-o", s(&pat), "-F", "1-3", "--outputs", "alpha", "--report", s(&report)]);
    exr(&d.0.join("key/key.0001.exr"));
    exr(&d.0.join("key/key.0002.exr"));
    let o = verify();
    assert_eq!(o.status.code(), Some(9), "{}", text(&o.stderr));
    assert!(text(&o.stdout).contains(&format!("missing or incomplete: {}", s(&d.0.join("key/key.0003.exr")))), "{}", text(&o.stdout));
    // the frames as ranges, ready for a requeue (SME review N6)
    assert!(text(&o.stdout).contains("missing frames: 3 (re-render them: -F 3)"), "{}", text(&o.stdout));
    assert!(text(&o.stderr).contains("1 of 3 file(s) missing or incomplete (frames 3)"), "{}", text(&o.stderr));
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&report).unwrap()).unwrap();
    assert_eq!((r["schema"].as_str(), r["command"].as_str(), r["exit_code"].as_i64()), (Some("corridorkey-report/1"), Some("verify"), Some(9)));
    assert_eq!(r["missing"].as_array().unwrap().len(), 1);
    // a cut frame (a killed writer of an older version, a full disk) is no better than a missing one
    exr(&d.0.join("key/key.0003.exr"));
    let whole = std::fs::read(d.0.join("key/key.0003.exr")).unwrap();
    std::fs::write(d.0.join("key/key.0003.exr"), &whole[..whole.len() / 2]).unwrap();
    assert_eq!(verify().status.code(), Some(9));
    std::fs::write(d.0.join("key/key.0003.exr"), &whole).unwrap();
    let o = verify();
    assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
    // several outputs share a pattern by name; a folder output is the engine's own layout
    let o = run(&["verify", "-i", s(&pl), "-o", s(&pat), "-F", "1"]);
    assert!(text(&o.stdout).contains("key_alpha.0001.exr") && text(&o.stdout).contains("key_fg.0001.exr"), "{}", text(&o.stdout));
    let o = run(&["verify", "-i", s(&pl), "-o", s(&d.0.join("out")), "--outputs", "alpha", "-e", "1"]);
    assert!(text(&o.stdout).contains(s(&d.0.join("out/plates_alpha_exr/plates_alpha.0001.exr"))), "{}", text(&o.stdout));
}

#[test]
fn exr_plates_are_read_scene_linear_by_default_and_the_report_says_why() {
    // Marcy 2026-10-27 "make the CLI match the app": an EXR folder starts scene-linear, --no-linear reads it display-coded
    let d = scratch("linear");
    let pl = plates(&d.0, &[1, 2]);
    let (report, out) = (d.0.join("r.json"), d.0.join("out"));
    let linear = |extra: &[&str]| {
        let mut a = vec!["verify", "-i", s(&pl), "-o", s(&out), "--report", s(&report)];
        a.extend(extra);
        let o = run(&a);
        assert_eq!(o.status.code(), Some(9), "{extra:?}: {}", text(&o.stderr));
        let r: Value = serde_json::from_str(&std::fs::read_to_string(&report).unwrap()).unwrap();
        r["frame_dir_linear"].clone()
    };
    assert_eq!(linear(&[]), serde_json::json!({"value": true, "why": "default: EXR plates"}));
    assert_eq!(linear(&["--no-linear"]), serde_json::json!({"value": false, "why": "--no-linear"}));
    assert_eq!(linear(&["--linear"]), serde_json::json!({"value": true, "why": "--linear"}));
    // a pattern is its folder: the same default
    let pattern = format!("{}/plate.####.exr", s(&pl));
    let o = run(&["verify", "-i", &pattern, "-o", s(&out), "--report", s(&report)]);
    assert_eq!(o.status.code(), Some(9), "{}", text(&o.stderr));
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&report).unwrap()).unwrap();
    assert_eq!(r["frame_dir_linear"]["why"], "default: EXR plates");
    // a job file's choice, when no flag is given
    let job = d.0.join("job.json");
    std::fs::write(&job, r#"{"options": {"frame_dir_linear": false}}"#).unwrap();
    assert_eq!(linear(&["--job", s(&job)]), serde_json::json!({"value": false, "why": "--job"}));
    // the two flags are one or the other
    let o = run(&["render", "-i", s(&pl), "-o", s(&out), "--linear", "--no-linear"]);
    assert_eq!(o.status.code(), Some(2), "{}", text(&o.stderr));
}

#[test]
fn skip_existing_runs_nothing_only_when_every_frame_is_whole() {
    let d = scratch("skip");
    let pl = plates(&d.0, &[1, 2, 3]);
    let pat = d.0.join("key").join("key.%04d.exr");
    // loop: NOT-WORTH — three frames
    for n in 1..=3 {
        exr(&d.0.join(format!("key/key.{n:04}.exr")));
    }
    let report = d.0.join("r.json");
    // no models given: a run that gets past the check stops at the models (exit 7), one that skips never needs them
    let render = |extra: &[&str]| {
        let mut a = vec!["render", "-i", s(&pl), "-o", s(&pat), "--outputs", "alpha", "--models", "/nonexistent/models", "--report", s(&report)];
        a.extend(extra);
        run(&a)
    };
    let o = render(&["--skip-existing"]);
    assert_eq!(o.status.code(), Some(0), "{}", text(&o.stderr));
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&report).unwrap()).unwrap();
    assert_eq!((r["skipped"].as_bool(), r["exit_reason"].as_str()), (Some(true), Some("done")));
    // frames there and no flag: refused, saying what to add
    let o = render(&[]);
    assert_eq!(o.status.code(), Some(4));
    assert!(text(&o.stderr).contains("--overwrite") && text(&o.stderr).contains("--skip-existing"), "{}", text(&o.stderr));
    assert_eq!(render(&["--overwrite"]).status.code(), Some(7));
    // one frame cut: the set isn't whole, so it is keyed again
    let p = d.0.join("key/key.0002.exr");
    let whole = std::fs::read(&p).unwrap();
    std::fs::write(&p, &whole[..whole.len() - 10]).unwrap();
    let o = render(&["--skip-existing"]);
    assert_eq!(o.status.code(), Some(7), "{}", text(&o.stderr));
    assert!(text(&o.stderr).contains("--models"), "{}", text(&o.stderr));
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&report).unwrap()).unwrap();
    assert_eq!((r["exit_code"].as_i64(), r["exit_reason"].as_str()), (Some(7), Some("assets")));
}

#[test]
#[cfg(unix)]
fn a_launcher_that_exits_first_doesnt_end_the_task() {
    // farm launchers and containers: the task's parent is PID 1 (or a subreaper), or exits before it; the engine
    // ends itself then (its parent-death watch), the command line must not. That holds by construction (only
    // ck-engine calls proc::end_with_parent); this only shows an orphaned task runs to its end, since `verify` ends
    // before any watch could fire (farm senior review 2026-10-26 N5)
    let d = scratch("orphan");
    let pl = plates(&d.0, &[1, 2]);
    let pat = d.0.join("key/key.####.exr");
    exr(&d.0.join("key/key.0001.exr"));
    exr(&d.0.join("key/key.0002.exr"));
    let report = d.0.join("r.json");
    // the shell exits at once; its subshell starts corridorkey half a second later, an orphan by then
    let st = Command::new("sh")
        .args(["-c", r#"(sleep 0.5; exec "$0" verify -i "$1" -o "$2" --outputs alpha --report "$3" >/dev/null 2>&1) & exit 0"#])
        .args([env!("CARGO_BIN_EXE_corridorkey"), s(&pl), s(&pat), s(&report)])
        .env("CUDA_VISIBLE_DEVICES", "")
        .status()
        .unwrap();
    assert!(st.success());
    let end = std::time::Instant::now() + std::time::Duration::from_secs(20);
    // loop: SERIAL-REQUIRED — a 50 ms poll for the orphan's report [bounded: 20 s]
    while !report.exists() && std::time::Instant::now() < end {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let r: Value = serde_json::from_str(&std::fs::read_to_string(&report).expect("the orphaned task ran to its end")).unwrap();
    assert_eq!(r["exit_code"].as_i64(), Some(0));
}

/// A line pasted into a terminal (the Queue's Copy as command) gives no --models or --ort: the CLI falls back to the
/// app's own install, the newest of each, and says which (P4 SME review 2026-10-27 S2). It stops here before the
/// runtime (a missing input), so no card or real runtime is needed.
#[test]
fn falls_back_to_the_apps_models_and_runtime_and_says_so() {
    let d = scratch("appinstall");
    let app = d.0.join("data/corridorkey-desktop");
    std::fs::create_dir_all(app.join("models/2.0.0-onnx.4")).unwrap();
    std::fs::write(app.join("models/2.0.0-onnx.4/models.json"), "{}").unwrap();
    let capi = app.join("runtime/ort-1.31.0/onnxruntime/capi");
    std::fs::create_dir_all(&capi).unwrap();
    let lib = if cfg!(windows) {
        "onnxruntime.dll"
    } else if cfg!(target_os = "macos") {
        "libonnxruntime.1.31.0.dylib"
    } else {
        "libonnxruntime.so.1.31.0"
    };
    std::fs::write(capi.join(lib), "").unwrap();
    std::fs::create_dir_all(app.join("runtime/ort-1.31.0/onnxruntime_gpu-1.31.0.dist-info")).unwrap();
    let data = d.0.join("data");
    let home = |c: &mut Command| {
        c.env_remove("CK_ENGINE_ORT").env_remove("ORT_DYLIB_PATH").env("XDG_DATA_HOME", &data).env("LOCALAPPDATA", &data).env("HOME", &d.0);
    };
    let mut c = bin();
    home(&mut c);
    let o = c.args(["render", "-i", s(&d.0.join("nope.mov")), "-o", s(&d.0.join("out"))]).output().unwrap();
    let err = text(&o.stderr);
    if !cfg!(target_os = "macos") {
        // macOS keeps Application Support under HOME: the same rule, checked in appinstall.rs's tests
        assert!(err.contains(&format!("no --models given: using the app's model set {}", app.join("models/2.0.0-onnx.4").display())), "{err}");
        assert!(err.contains(&format!("no --ort given: using the app's ONNX Runtime {}", capi.join(lib).display())), "{err}");
    }
    assert_eq!(o.status.code(), Some(3), "{err}");
    // given, nothing is said
    let mut c = bin();
    home(&mut c);
    let o = c.args(["render", "-i", s(&d.0.join("nope.mov")), "-o", s(&d.0.join("out")), "--models", "/m", "--ort", "/o"]).output().unwrap();
    assert!(!text(&o.stderr).contains("using the app's"), "{}", text(&o.stderr));
}
