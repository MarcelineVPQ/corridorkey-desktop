//! `corridorkey render` end to end on the CPU provider with the real models, against the same job through the
//! engine protocol (corridorkey-engine): the outputs are bit-identical. Ignored by default (it needs a model set and
//! a minute or two of CPU); run it with
//!
//!   cargo build -p ck-engine && cargo test -p ck-cli --test e2e -- --ignored --test-threads=1
//!
//! CK_TEST_MODELS: the model set (default the app's ~/.local/share/corridorkey-desktop/models/2.0.0-onnx.5);
//! CK_TEST_PRECISION: the CPU's precision (default fp16: that set has no fp32 files). No graphics card is used.
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn models() -> PathBuf {
    std::env::var_os("CK_TEST_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").expect("HOME")).join(".local/share/corridorkey-desktop/models/2.0.0-onnx.5"))
}

fn precision() -> String {
    std::env::var("CK_TEST_PRECISION").unwrap_or_else(|_| "fp16".into())
}

/// Both binaries' environment: no card, the CPU's precision, no farm variables.
fn env(c: &mut Command) -> &mut Command {
    c.env("CUDA_VISIBLE_DEVICES", "")
        .env("CK_ENGINE_PRECISION", precision())
        .env("CK_ENGINE_THREADS", "8")
        .env_remove("CUE_GPU_CORES")
        .env_remove("OPENJD_SESSION_WORKING_DIR")
}

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch(tag: &str) -> Dir {
    let p = std::env::temp_dir().join(format!("ck-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    Dir(p)
}

/// A small green-screen shot: `n` frames, 1001 on, a grey square moving across green.
fn shot(d: &Path, n: u64) -> PathBuf {
    let dir = d.join("sh010");
    std::fs::create_dir_all(&dir).unwrap();
    // loop: NOT-WORTH — a few test frames
    for i in 0..n {
        let x0 = 40 + 12 * i as usize;
        exr::prelude::write_rgb_file(dir.join(format!("sh010.{:04}.exr", 1001 + i)), 320, 192, |x, y| {
            if (x0..x0 + 96).contains(&x) && (48..144).contains(&y) {
                (0.55, 0.5, 0.45)
            } else {
                (0.1, 0.65, 0.15)
            }
        })
        .unwrap();
    }
    dir
}

/// The same job through the engine protocol (the app's path): its output folder.
fn engine(input: &Path, out: &Path, temp: &Path, options: serde_json::Value) {
    let bin = Path::new(env!("CARGO_BIN_EXE_corridorkey")).with_file_name(format!("corridorkey-engine{}", std::env::consts::EXE_SUFFIX));
    assert!(bin.exists(), "{} is missing: cargo build -p ck-engine first", bin.display());
    let mut c = Command::new(bin);
    env(&mut c).args(["--models", models().to_str().unwrap(), "--device", "cpu"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = c.spawn().unwrap();
    let req = serde_json::json!({"cmd": "run", "id": "e", "input": input, "output_dir": out, "temp_dir": temp, "options": options});
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{req}\n{{\"cmd\":\"quit\"}}").unwrap();
    drop(stdin);
    let replies = std::io::BufReader::new(child.stdout.take().unwrap());
    // loop: SERIAL-REQUIRED — the engine's replies until it quits [bounded: the job ends, then quit]
    let last: Vec<String> = replies.lines().map_while(Result::ok).filter(|l| l.contains("\"result\"") || l.contains("\"error\"")).collect();
    // loop: NOT-WORTH — reaps the engine after quit [bounded: it exits after quit]
    assert!(child.wait().unwrap().success());
    assert!(last.iter().any(|l| l.contains("\"type\":\"result\"")), "the engine's job failed: {last:?}");
}

/// The files of a folder, by name.
fn files(dir: &Path) -> Vec<String> {
    // loop: NOT-WORTH — a few test files
    let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

/// `corridorkey render` on the CPU with the test's models.
fn render() -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_corridorkey"));
    env(&mut c).args(["render", "--models", models().to_str().unwrap(), "--device", "cpu"]);
    c
}

#[test]
#[ignore]
fn a_whole_shot_and_a_stepped_list_match_the_engine_bit_for_bit() {
    let d = scratch("whole");
    let input = shot(&d.0, 6);
    let (eng, out, temp) = (d.0.join("engine"), d.0.join("cli"), d.0.join("temp"));
    engine(
        &input,
        &eng,
        &d.0.join("etemp"),
        serde_json::json!({"output_format": "exr", "outputs": ["alpha", "fg"], "hann_chunk": 4, "hann_stride": 2, "frame_dir_linear": true}),
    );
    let o = render().args(["-i", input.to_str().unwrap(), "-o", out.to_str().unwrap(), "--window", "4/2", "--temp", temp.to_str().unwrap()]).output().unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
    assert!(String::from_utf8_lossy(&o.stdout).contains("openjd_progress: 100"));
    // loop: NOT-WORTH — two outputs
    for sub in ["sh010_alpha_exr", "sh010_fg_exr"] {
        let names = files(&eng.join(sub));
        assert_eq!(names.len(), 6);
        assert_eq!(files(&out.join(sub)), names, "{sub}");
        // loop: NOT-WORTH — six frames
        for n in &names {
            assert!(std::fs::read(eng.join(sub).join(n)).unwrap() == std::fs::read(out.join(sub).join(n)).unwrap(), "{sub}/{n} differs");
        }
    }
    // the run's own folders are gone: only the results and the settings file are left
    assert_eq!(files(&out), ["sh010_alpha_exr", "sh010_fg_exr", "sh010_settings.txt"]);
    assert_eq!(files(&temp), Vec::<String>::new());

    // a stepped list to a pattern: the spec's whole range 1002-1005 is keyed as the engine's range job keys it, only 1002
    // and 1004 kept, so they are bit for bit the frames of a 1002-1005 run (farm review S1: it keyed only to 1004)
    let eng2 = d.0.join("engine2");
    engine(
        &input,
        &eng2,
        &d.0.join("etemp2"),
        serde_json::json!({"output_format": "exr", "outputs": ["alpha"], "hann_chunk": 4, "hann_stride": 2, "frame_start": 1002, "frame_end": 1005, "frame_dir_linear": true}),
    );
    let pat = d.0.join("key/key.$F4.exr");
    let report = d.0.join("report.json");
    let o = render()
        .args(["-i", &format!("{}/sh010.####.exr", input.display()), "-o", pat.to_str().unwrap(), "-F", "1002-1005x2", "--outputs", "alpha", "--window", "4/2"])
        .args(["--temp", temp.to_str().unwrap(), "--report", report.to_str().unwrap(), "--progress-format", "json"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
    assert_eq!(files(&d.0.join("key")), ["key.1002.exr", "key.1004.exr", "key_settings.txt"]);
    // loop: NOT-WORTH — two frames
    for n in [1002, 1004] {
        let a = std::fs::read(eng2.join(format!("sh010_alpha_exr/sh010_alpha.{n}.exr"))).unwrap();
        assert!(a == std::fs::read(d.0.join(format!("key/key.{n}.exr"))).unwrap(), "frame {n} differs");
    }
    let r: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&report).unwrap()).unwrap();
    assert_eq!((r["exit_code"].as_i64(), r["provider"].as_str()), (Some(0), Some("cpu")));
    assert_eq!(r["window"], serde_json::json!({"chunk": 4, "stride": 2, "low_vram": false, "auto": false}));
    assert_eq!(r["frames"]["keyed"], serde_json::json!({"first": 1002, "last": 1005}));
    assert_eq!(r["frames"]["written"], serde_json::json!({"first": 1002, "last": 1004, "count": 2}));
    assert_eq!(r["frame_times"].as_array().unwrap().len(), 4);
    // EXR plates: scene-linear by default, as the app starts an EXR folder (the engine jobs above say so)
    assert_eq!(r["frame_dir_linear"], serde_json::json!({"value": true, "why": "default: EXR plates"}));
}

#[test]
#[ignore]
#[cfg(unix)]
fn sigterm_stops_cleanly_with_143_and_leaves_nothing_at_the_final_names() {
    let d = scratch("term");
    let input = shot(&d.0, 6);
    let (out, temp) = (d.0.join("cli"), d.0.join("temp"));
    let mut child = render()
        .args(["-i", input.to_str().unwrap(), "-o", out.to_str().unwrap(), "--window", "4/2", "--temp", temp.to_str().unwrap()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = std::io::BufReader::new(child.stdout.take().unwrap()).lines();
    // loop: SERIAL-REQUIRED — the run's stdout until its RVM pass starts [bounded: the run ends]
    for l in lines.by_ref() {
        if l.unwrap().starts_with("openjd_status: RVM pass") {
            break;
        }
    }
    assert!(Command::new("kill").args(["-TERM", &child.id().to_string()]).status().unwrap().success());
    // loop: SERIAL-REQUIRED — the rest of its stdout [bounded: it stops after the current frame]
    let rest: Vec<String> = lines.map_while(Result::ok).collect();
    // loop: NOT-WORTH — reaps the stopped run [bounded: it has closed its stdout]
    let code = child.wait().unwrap().code();
    assert_eq!(code, Some(143), "{rest:?}");
    assert!(rest.iter().any(|l| l.starts_with("openjd_fail: stopped by SIGTERM")), "{rest:?}");
    // no staging folder, no temporary files, no frame at a final name
    assert_eq!(files(&out), Vec::<String>::new());
    assert_eq!(files(&temp), Vec::<String>::new());
}
