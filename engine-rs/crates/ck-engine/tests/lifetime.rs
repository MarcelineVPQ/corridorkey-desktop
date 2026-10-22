//! The engine process ends with its parent (the app): the real binary, started by a shell that then exits.
//! Before this, an engine whose app had died stayed up (idle here; in a job, until the job's end).
use std::io::BufRead;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn alive(pid: u32) -> bool {
    // a zombie is gone for this purpose (its reaper collects it)
    std::fs::read_to_string(format!("/proc/{pid}/stat")).map(|s| !s.contains(") Z ")).unwrap_or(false)
}

#[test]
#[cfg(target_os = "linux")]
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
