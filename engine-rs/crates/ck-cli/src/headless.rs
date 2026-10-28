//! `corridorkey run FILE.ckcmd` (SME review 2026-10-27 N12, backlog row 151): a Console script without the app's
//! window, from cron or as a farm's pre-job. The Console's parser and rules are the app's own code (TypeScript), so
//! this starts the app's executable as Node (`ELECTRON_RUN_AS_NODE=1`) on its `out/main/headless.js`, passing itself
//! (`CK_HEADLESS_CLI`) for the script's render, verify, prepare and info. On Unix it execs the app (same process: a
//! farm's SIGTERM reaches the runner itself, and a death by signal shows as one); on Windows it waits and exits as the
//! script ended: Ctrl+C / Ctrl+Break reach the app on the shared console while this process keeps waiting
//! (signals.rs), and the app ends with it (ck_core::proc::children_end_with_me). It needs the app installed next to
//! it (this binary in `resources/engine/`); a bare copy on a worker says so (exit 7).
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
        // the first Ctrl+C / Ctrl+Break is the app's to stop on (it gets the same console event); a second ends both
        crate::signals::install();
        // loop: NOT-WORTH — one wait for the script [bounded: the script's own end; Ctrl+C / Ctrl+Break reach it, it stops cleanly]
        match c.status() {
            // Windows always has an exit code
            Ok(s) => s.code().unwrap_or(exit::ENGINE),
            Err(e) => {
                eprintln!("corridorkey run: the app ({}) didn't start: {e}", app.display());
                exit::ASSETS
            }
        }
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
}
