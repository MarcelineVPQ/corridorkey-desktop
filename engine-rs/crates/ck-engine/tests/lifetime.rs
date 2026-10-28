//! The engine process ends with its parent (the app): the real binary, started by a shell that then exits.
//! Before this, an engine whose app had died stayed up (idle here; in a job, until the job's end). Also the binary's
//! own startup answers: --help, --version and failures, on stderr whatever its parent.
// Linux only (it reads /proc): the whole file, so its imports and helper don't count as unused on macOS/Windows
#![cfg(target_os = "linux")]
use std::io::BufRead;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn alive(pid: u32) -> bool {
    // a zombie is gone for this purpose (its reaper collects it)
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| !s.contains(") Z ")).unwrap_or(false)
}

#[test]
fn the_engine_ends_when_its_parent_does() {
    let models = std::env::temp_dir().join(format!("ck-lifetime-{}", std::process::id()));
    std::fs::create_dir_all(&models).unwrap();
    let bin = env!("CARGO_BIN_EXE_corridorkey-engine");
    // sh starts the engine (stdin: the test's pipe, kept open, so the engine waits for requests; a background job's
    // stdin would be /dev/null otherwise), prints its pid, waits a moment and exits
    let mut sh = Command::new("sh")
        .args(["-c", r#"exec 3<&0; "$0" --models "$1" --device cpu 2>/dev/null <&3 & echo $!; sleep 1"#, bin, models.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufReader::new(sh.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let pid: u32 = line.trim().parse().unwrap();
    assert!(alive(pid), "the engine started");
    // the engine's stdin stays open (Child::wait would close it first, and EOF ends an engine anyway)
    let keep_stdin = sh.stdin.take();
    // loop: NOT-WORTH — the test's shell [bounded: it sleeps 1 s]
    sh.wait().unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    // loop: SERIAL-REQUIRED — a 50 ms poll [bounded: 5 s]
    while alive(pid) && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(50));
    }
    let still = alive(pid);
    if still {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
    drop(keep_stdin);
    let _ = std::fs::remove_dir_all(&models);
    assert!(!still, "the engine outlived its parent");
}

#[test]
fn the_usage_lists_every_device() {
    // final review 2026-10-28 N1: it said auto|cuda|cpu; the engine also takes coreml and migraphx
    let out = Command::new(env!("CARGO_BIN_EXE_corridorkey-engine")).arg("--help").output().unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success() && err.contains("--device auto|cuda|cpu|coreml|migraphx"), "{err}");
}

#[test]
fn a_startup_failure_is_on_stderr_too() {
    // final review 2026-10-28 N4: an unreadable models.json went only to stdout, so the app's error report (the
    // stderr tail) had nothing
    let models = std::env::temp_dir().join(format!("ck-startup-{}", std::process::id()));
    std::fs::create_dir_all(&models).unwrap();
    std::fs::write(models.join("models.json"), "{ not json").unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_corridorkey-engine"))
        .args(["--models", models.to_str().unwrap(), "--device", "cpu"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let _ = std::fs::remove_dir_all(&models);
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success() && err.contains("engine failed to start:") && err.contains("models.json"), "{err}");
}

#[test]
fn under_a_parent_of_pid_1_version_answers_and_a_run_says_why_it_exits() {
    // final review 2026-10-28 N9: with getppid() == 1 (a container's first shell) the engine exited 1 silently, even
    // for --version. A user and PID namespace makes the shell PID 1; where unprivileged namespaces are off, skip.
    let bin = env!("CARGO_BIN_EXE_corridorkey-engine");
    let ns =
        |args: &[&str]| Command::new("unshare").args(["-Urpf", "sh", "-c", r#""$0" "$@"; echo "exit $?" >&2"#, bin]).args(args).stdin(Stdio::null()).output();
    let Ok(probe) = Command::new("unshare").args(["-Urpf", "true"]).output() else { return };
    if !probe.status.success() {
        eprintln!("skipped: no unprivileged user namespaces here");
        return;
    }
    let v = ns(&["--version"]).unwrap();
    assert!(String::from_utf8_lossy(&v.stdout).starts_with("corridorkey-engine "), "{v:?}");
    let r = ns(&["--models", "/nonexistent", "--device", "cpu"]).unwrap();
    let err = String::from_utf8_lossy(&r.stderr);
    assert!(err.contains("its parent process is gone (or is PID 1") && err.contains("exit 1"), "{err}");
}
