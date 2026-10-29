//! `corridorkey run FILE.ckcmd` (SME review 2026-10-27 N12, backlog row 151): a Console script without the app's
//! window, from cron or as a farm's pre-job. The Console's parser and rules are the app's own code (TypeScript), so
//! this starts the app's executable with `--ck-headless` (its fixed script runner, no window; never as Node, so the
//! app ships with the runAsNode fuse off: review 2026-10-28 #3), passing itself (`CK_HEADLESS_CLI`) for the script's
//! render, verify, prepare and info, which the app checks is its own. On Unix it execs the app (same process: a
//! farm's SIGTERM reaches the runner itself, and a death by signal shows as one); on Windows it waits and exits as the
//! script ended. Windows: Electron didn't call the runner's `process.on("SIGINT" | "SIGBREAK")` (measured
//! on Electron 45.1.0, VM run 2026-10-27), so this process takes the console's events (signals.rs) and asks the runner
//! to stop with a stop file it watches (CK_HEADLESS_STOP=file:<path>; a `stop` line on its stdin, the first way, was
//! never read by the Windows app: VM, dev.3 2026-10-28): the runner's own cancel, its "cancelled" report, exit 130. The runner starts in a process group of its own, which ignores Ctrl+C; Ctrl+Break still reaches every
//! process on the console, so when it ends the runner first (0xC000013A) this process says the script stopped and exits
//! 128 + the signal. A second Ctrl+C / Ctrl+Break ends this process, and the app with it (its job object,
//! ck_core::proc::children_end_with_me). It needs the app installed next to it (this binary in `resources/engine/`); a
//! bare copy on a worker says so (exit 7).
use crate::exit;
use clap::ArgMatches;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The app's executable, from this binary's path (`<app>/resources/engine/corridorkey`): Linux `<app>/corridorkey-desktop`,
/// Windows `<app>\CorridorKey.exe`, macOS `CorridorKey.app/Contents/MacOS/CorridorKey`. `CK_APP` names another, and
/// `CK_APP_ENTRY` the app folder a development Electron loads (a development build); a packaged app needs none.
pub fn app_paths(exe: &Path, os: &str, var: &dyn Fn(&str) -> Option<String>) -> Option<(PathBuf, Option<PathBuf>)> {
    let resources = exe.parent()?.parent()?;
    let root = resources.parent()?;
    let app = match var("CK_APP") {
        Some(a) => PathBuf::from(a),
        None => match os {
            "windows" => root.join("CorridorKey.exe"),
            "macos" => root.join("MacOS").join("CorridorKey"),
            _ => root.join("corridorkey-desktop"),
        },
    };
    Some((app, var("CK_APP_ENTRY").map(PathBuf::from)))
}

/// The run: the app's script runner with the file, waited for; its exit code is the script's.
pub fn run(m: &ArgMatches) -> i32 {
    let file = m.get_one::<String>("file").expect("required by clap");
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("corridorkey run: can't tell where this program is ({e})");
            return exit::ASSETS;
        }
    };
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let found = app_paths(&exe, std::env::consts::OS, &var).filter(|(app, entry)| app.is_file() && entry.as_ref().is_none_or(|e| e.exists()));
    let Some((app, entry)) = found else {
        eprintln!(
            "corridorkey run: the app isn't next to this program ({}): run needs the app installed (it runs the app's own Console code); render, verify, prepare and info work without it",
            exe.display()
        );
        return exit::ASSETS;
    };
    let mut c = Command::new(&app);
    c.args(&entry).args(HEADLESS_SWITCHES).arg(HEADLESS_FLAG).arg("run");
    if m.get_flag("keep-going") {
        c.arg("--keep-going");
    }
    // absolute: a name starting with "-" never reads as a switch (the app refuses one)
    c.arg(std::path::absolute(file).unwrap_or_else(|_| PathBuf::from(file))).env_remove("ELECTRON_RUN_AS_NODE").env("CK_HEADLESS_CLI", &exe);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // returns only when the app couldn't start
        let e = c.exec();
        eprintln!("corridorkey run: the app ({}) didn't start: {e}", app.display());
        exit::ASSETS
    }
    #[cfg(not(unix))]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP: the console's Ctrl+C doesn't reach the runner (it ignores it); this process asks
        let stop_file = std::env::temp_dir().join(format!("corridorkey-run-{}.stop", std::process::id()));
        // error: NOT-WORTH — a leftover of a reused process id goes; none there is the usual case
        let _ = std::fs::remove_file(&stop_file);
        c.creation_flags(CREATE_NEW_PROCESS_GROUP).env("CK_HEADLESS_STOP", format!("file:{}", stop_file.display()));
        // the first Ctrl+C / Ctrl+Break: the stop file; a second ends this process and the runner with it. Installed
        // before the runner starts (engine re-review 2026-10-28 #1: installed after, an event in between found the
        // console's default handler and ended this process); a file made before the runner looks is seen at its first look
        let sf = stop_file.clone();
        crate::signals::install_with(Box::new(move || {
            // error: NOT-WORTH — a temp folder that can't take a file: the second Ctrl+C still ends the run
            let _ = ask_to_stop(&sf);
        }));
        let mut child = match c.spawn() {
            Ok(ch) => ch,
            Err(e) => {
                eprintln!("corridorkey run: the app ({}) didn't start: {e}", app.display());
                return exit::ASSETS;
            }
        };
        // loop: NOT-WORTH — one wait for the script [bounded: the script's own end; the stop file stops it, a second Ctrl+C ends it]
        let waited = child.wait();
        // error: NOT-WORTH — none made (no Ctrl+C) is the usual case
        let _ = std::fs::remove_file(&stop_file);
        match waited {
            // Windows always has an exit code
            Ok(s) => script_status(s.code().unwrap_or(exit::ENGINE), crate::signals::stopped_by()),
            Err(e) => {
                eprintln!("corridorkey run: lost the app's script runner ({e})");
                exit::ENGINE
            }
        }
    }
}

/// The app's flag for its script runner (electron/main/headlessFlag.ts HEADLESS_FLAG).
pub const HEADLESS_FLAG: &str = "--ck-headless";

/// Chromium switches before the flag (headlessFlag.ts HEADLESS_SWITCHES): on Linux no display (cron, a farm worker), no
/// sandbox helper (the AppImage's, as the app's own start passes it) and never the desktop's wallet (KWallet would ask
/// to create one on the user's screen); everywhere none of Chromium's own log lines among the script's output.
#[cfg(target_os = "linux")]
const HEADLESS_SWITCHES: &[&str] = &["--no-sandbox", "--ozone-platform=headless", "--password-store=basic", "--log-level=3"];
#[cfg(not(target_os = "linux"))]
const HEADLESS_SWITCHES: &[&str] = &["--log-level=3"];

/// Windows: a new process group (CreateProcess's CREATE_NEW_PROCESS_GROUP).
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Windows: the exit code of a process the console's Ctrl+C / Ctrl+Break ended (STATUS_CONTROL_C_EXIT).
const STATUS_CONTROL_C_EXIT: i32 = 0xC000_013Au32 as i32;

/// Ask the runner to stop: its own cancel, as the Console's Ctrl+C. The stop file it watches (electron/main/console/
/// headless.ts onStopFile); asking again leaves it as it is.
pub fn ask_to_stop(stop_file: &Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new().write(true).create(true).truncate(false).open(stop_file).map(|_| ())
}

/// The exit code `run` passes on: the runner's, except when the console's event ended the runner before its own stop
/// (Ctrl+Break reaches every process on the console): then the stop, said, and 128 + the signal, as a stopped run.
pub fn script_status(code: i32, stopped_by: Option<i32>) -> i32 {
    match stopped_by {
        Some(sig) if code == STATUS_CONTROL_C_EXIT => {
            eprintln!("corridorkey run: stopped (the console's {} ended the app's script runner at once)", if sig == 2 { "Ctrl+C" } else { "Ctrl+Break" });
            128 + sig
        }
        _ => code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_app_and_its_script_runner_per_system() {
        let none = |_: &str| None;
        let (app, entry) = app_paths(Path::new("/opt/CK/resources/engine/corridorkey"), "linux", &none).unwrap();
        assert_eq!((app, entry), (PathBuf::from("/opt/CK/corridorkey-desktop"), None));
        let (app, _) = app_paths(Path::new("/Applications/CorridorKey.app/Contents/Resources/engine/corridorkey"), "macos", &none).unwrap();
        assert_eq!(app, PathBuf::from("/Applications/CorridorKey.app/Contents/MacOS/CorridorKey"));
        let (app, _) = app_paths(&PathBuf::from("C:/CK/resources/engine/corridorkey.exe"), "windows", &none).unwrap();
        assert_eq!(app, PathBuf::from("C:/CK/CorridorKey.exe"));
        // a development build names its own
        let dev = |k: &str| match k {
            "CK_APP" => Some("/dev/node_modules/electron/dist/electron".to_string()),
            "CK_APP_ENTRY" => Some("/dev".to_string()),
            _ => None,
        };
        assert_eq!(
            app_paths(Path::new("/dev/engine-rs/target/release/corridorkey"), "linux", &dev).unwrap(),
            (PathBuf::from("/dev/node_modules/electron/dist/electron"), Some(PathBuf::from("/dev")))
        );
        // a bare binary with no folders above it
        assert_eq!(app_paths(Path::new("corridorkey"), "linux", &none), None);
    }

    #[test]
    fn asks_the_runner_to_stop_with_a_stop_file() {
        let f = std::env::temp_dir().join(format!("ck-stop-test-{}.stop", std::process::id()));
        let _ = std::fs::remove_file(&f);
        ask_to_stop(&f).unwrap();
        assert!(f.is_file());
        // again: still there, nothing else
        ask_to_stop(&f).unwrap();
        assert!(f.is_file());
        std::fs::remove_file(&f).unwrap();
    }

    #[test]
    fn a_runner_the_console_ended_after_a_stop_shows_as_a_stopped_run() {
        // the runner's own stop: its code (130), as it is
        assert_eq!(script_status(130, Some(2)), 130);
        // Ctrl+Break ended the runner first (STATUS_CONTROL_C_EXIT): stopped, 128 + the signal
        assert_eq!(script_status(0xC000_013Au32 as i32, Some(15)), 143);
        assert_eq!(script_status(0xC000_013Au32 as i32, Some(2)), 130);
        // no stop asked: the runner's code, whatever it is
        assert_eq!(script_status(0xC000_013Au32 as i32, None), 0xC000_013Au32 as i32);
        assert_eq!(script_status(1, None), 1);
    }
}
