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
fn help_and_version_exit_0() {
    let o = run(&["--version"]);
    assert_eq!(o.status.code(), Some(0));
    assert_eq!(text(&o.stdout).trim(), format!("corridorkey {}", env!("CARGO_PKG_VERSION")));
    let o = run(&["render", "--help"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(text(&o.stdout).contains("Examples:"), "{}", text(&o.stdout));
    assert_eq!(run(&["help", "verify"]).status.code(), Some(0));
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
    // ends itself then (its parent-death watch), the command line must not
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
