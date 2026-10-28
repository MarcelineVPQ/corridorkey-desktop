//! `corridorkey run FILE.ckcmd` (SME review 2026-10-27 N12, backlog row 151): a Console script without the app's
//! window, from cron or as a farm's pre-job. The Console's parser and rules are the app's own code (TypeScript), so
//! this starts the app's executable as Node (`ELECTRON_RUN_AS_NODE=1`) on its `out/main/headless.js`, passing itself
//! (`CK_HEADLESS_CLI`) for the script's render, verify, prepare and info. On Unix it execs the app (same process: a
//! farm's SIGTERM reaches the runner itself, and a death by signal shows as one); on Windows it waits and exits as the
//! script ended. Windows: Electron's run-as-node never calls the runner's `process.on("SIGINT" | "SIGBREAK")` (measured
//! on Electron 45.1.0, VM run 2026-10-27), so this process takes the console's events (signals.rs) and asks the runner
//! to stop with a `stop` line on its stdin (CK_HEADLESS_STOP=stdin): the runner's own cancel, its "cancelled" report,
//! exit 130. The runner starts in a process group of its own, which ignores Ctrl+C; Ctrl+Break still reaches every
//! process on the console, so when it ends the runner first (0xC000013A) this process says the script stopped and exits
//! 128 + the signal. A second Ctrl+C / Ctrl+Break ends this process, and the app with it (its job object,
//! ck_core::proc::children_end_with_me). It needs the app installed next to it (this binary in `resources/engine/`); a
//! bare copy on a worker says so (exit 7).
use crate::exit;
use clap::ArgMatches;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The app's executable and the script runner inside it, from this binary's path (`<app>/resources/engine/corridorkey`):
/// Linux `<app>/corridorkey-desktop`, Windows `<app>\CorridorKey.exe`, macOS `CorridorKey.app/Contents/MacOS/CorridorKey`;
/// the runner `resources/app.asar/out/main/headless.js`. `CK_APP` and `CK_APP_ENTRY` name others (a development build).
pub fn app_paths(exe: &Path, os: &str, var: &dyn Fn(&str) -> Option<String>) -> Option<(PathBuf, PathBuf)> {
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
    let entry = var("CK_APP_ENTRY").map(PathBuf::from).unwrap_or_else(|| resources.join("app.asar").join("out").join("main").join("headless.js"));
    Some((app, entry))
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
    let found = app_paths(&exe, std::env::consts::OS, &var)
        .filter(|(app, entry)| app.is_file() && (entry.is_file() || entry.components().any(|c| c.as_os_str() == "app.asar")));
    let Some((app, entry)) = found else {
        eprintln!(
            "corridorkey run: the app isn't next to this program ({}): run needs the app installed (it runs the app's own Console code); render, verify, prepare and info work without it",
            exe.display()
        );
        return exit::ASSETS;
    };
    let mut c = Command::new(&app);
    c.arg(&entry).arg("run");
    if m.get_flag("keep-going") {
        c.arg("--keep-going");
    }
    c.arg(file).env("ELECTRON_RUN_AS_NODE", "1").env("CK_HEADLESS_CLI", &exe);
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
        use std::sync::Mutex;
        // CREATE_NEW_PROCESS_GROUP: the console's Ctrl+C doesn't reach the runner (it ignores it); this process asks
        c.creation_flags(CREATE_NEW_PROCESS_GROUP).env("CK_HEADLESS_STOP", "stdin").stdin(std::process::Stdio::piped());
        let mut child = match c.spawn() {
            Ok(ch) => ch,
            Err(e) => {
                eprintln!("corridorkey run: the app ({}) didn't start: {e}", app.display());
                return exit::ASSETS;
            }
        };
        let stdin = Mutex::new(child.stdin.take());
        // the first Ctrl+C / Ctrl+Break: a `stop` line to the runner; a second ends this process and the runner with it
        crate::signals::install_with(Box::new(move || {
            if let Some(w) = stdin.lock().ok().as_deref_mut().and_then(Option::as_mut) {
                // error: NOT-WORTH — a runner that already ended can't read it; the wait below reports its end
                let _ = ask_to_stop(w);
            }
        }));
        // loop: NOT-WORTH — one wait for the script [bounded: the script's own end; a `stop` line stops it, a second Ctrl+C ends it]
        match child.wait() {
            // Windows always has an exit code
            Ok(s) => script_status(s.code().unwrap_or(exit::ENGINE), crate::signals::stopped_by()),
            Err(e) => {
                eprintln!("corridorkey run: lost the app's script runner ({e})");
                exit::ENGINE
            }
        }
    }
}

/// The line the runner reads on its stdin as Ctrl+C (electron/main/console/headless.ts STOP_LINE).
pub const STOP_LINE: &[u8] = b"stop\n";

/// Windows: a new process group (CreateProcess's CREATE_NEW_PROCESS_GROUP).
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Windows: the exit code of a process the console's Ctrl+C / Ctrl+Break ended (STATUS_CONTROL_C_EXIT).
const STATUS_CONTROL_C_EXIT: i32 = 0xC000_013Au32 as i32;

/// Ask the runner to stop: its own cancel, as the Console's Ctrl+C.
pub fn ask_to_stop(w: &mut impl std::io::Write) -> std::io::Result<()> {
    w.write_all(STOP_LINE)?;
    w.flush()
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
        assert_eq!((app, entry), (PathBuf::from("/opt/CK/corridorkey-desktop"), PathBuf::from("/opt/CK/resources/app.asar/out/main/headless.js")));
        let (app, _) = app_paths(Path::new("/Applications/CorridorKey.app/Contents/Resources/engine/corridorkey"), "macos", &none).unwrap();
        assert_eq!(app, PathBuf::from("/Applications/CorridorKey.app/Contents/MacOS/CorridorKey"));
        let (app, _) = app_paths(&PathBuf::from("C:/CK/resources/engine/corridorkey.exe"), "windows", &none).unwrap();
        assert_eq!(app, PathBuf::from("C:/CK/CorridorKey.exe"));
        // a development build names its own
        let dev = |k: &str| match k {
            "CK_APP" => Some("/dev/node_modules/electron/dist/electron".to_string()),
            "CK_APP_ENTRY" => Some("/dev/out/main/headless.js".to_string()),
            _ => None,
        };
        assert_eq!(
            app_paths(Path::new("/dev/engine-rs/target/release/corridorkey"), "linux", &dev).unwrap(),
            (PathBuf::from("/dev/node_modules/electron/dist/electron"), PathBuf::from("/dev/out/main/headless.js"))
        );
        // a bare binary with no folders above it
        assert_eq!(app_paths(Path::new("corridorkey"), "linux", &none), None);
    }

    #[test]
    fn asks_the_runner_to_stop_with_one_stop_line() {
        let mut pipe = Vec::new();
        ask_to_stop(&mut pipe).unwrap();
        assert_eq!(pipe, b"stop\n");
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
