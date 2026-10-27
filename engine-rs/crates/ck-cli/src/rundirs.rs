//! A run's own folders (docs/CLI.md "Output safety"): the staging folder beside the output (`.corridorkey-<run>`) and
//! the temporary folder (`corridorkey-<run>`). A run id is `<host>-<pid>-<64 random bits>`, so the machines of a farm
//! writing to one share never pick the same name, containers whose PIDs repeat included (farm review S5). Each folder
//! is made with create_dir (a name already taken is never shared: a new id then) and holds `.corridorkey.lock`,
//! locked while the run lives. `sweep` removes the folders of runs that are certainly over (farm review S8).
use std::fs::{File, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The lock file in each run folder: locked by its run while it lives (the OS drops the lock when the process ends).
pub const LOCK: &str = ".corridorkey.lock";

/// A run folder in which nothing changed this long, with no live lock, is abandoned whichever machine made it: no real
/// run goes a week without writing a frame or a temporary file.
pub const STALE_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);

/// This machine's name, as run ids carry it (letters, digits, `.`, `_`, `-`; at most 64 characters).
pub fn host() -> String {
    // loop: NOT-WORTH — a host name's few characters
    let h: String = raw_host().unwrap_or_default().chars().map(|c| if c.is_ascii_alphanumeric() || ".-_".contains(c) { c } else { '_' }).take(64).collect();
    if h.is_empty() {
        "host".into()
    } else {
        h
    }
}

#[cfg(unix)]
fn raw_host() -> Option<String> {
    use std::os::raw::{c_char, c_int};
    extern "C" {
        fn gethostname(name: *mut c_char, len: usize) -> c_int;
    }
    let mut buf = [0u8; 256];
    // SAFETY: gethostname(2) writes at most `len` bytes into the buffer it is given
    if unsafe { gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return None;
    }
    // loop: NOT-WORTH — ≤ 256 bytes, once per run
    let n = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..n]).into_owned())
}

#[cfg(windows)]
fn raw_host() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

/// A new run id: `<host>-<pid>-<16 hex digits>`, the last 64 bits from the standard library's random hasher keys.
pub fn run_id() -> String {
    use std::hash::BuildHasher;
    let t = SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let r = std::collections::hash_map::RandomState::new().hash_one((t, std::process::id()));
    format!("{}-{}-{r:016x}", host(), std::process::id())
}

/// The host and PID a run id names: `<host>-<pid>-<16 hex>`, or the older `<pid>-<11 hex>` (milliseconds; no host).
fn parse_id(id: &str) -> Option<(Option<&str>, u32)> {
    let mut parts = id.rsplitn(3, '-');
    let (r, pid, host) = (parts.next()?, parts.next()?, parts.next());
    if !r.chars().all(|c| c.is_ascii_hexdigit()) || pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let pid = pid.parse().ok()?;
    match host {
        Some(h) if r.len() == 16 && !h.is_empty() => Some((Some(h), pid)),
        None if r.len() == 11 => Some((None, pid)),
        _ => None,
    }
}

/// Whether process `pid` runs on this machine (true when unsure: an ID that can't be asked about is never called dead).
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    use std::os::raw::c_int;
    extern "C" {
        fn kill(pid: c_int, sig: c_int) -> c_int;
    }
    let Ok(p) = c_int::try_from(pid) else { return true };
    if p <= 0 {
        return true;
    }
    // SAFETY: kill(2) with signal 0 sends nothing; it only checks that the process exists
    if unsafe { kill(p, 0) } == 0 {
        return true;
    }
    // ESRCH (3 on Linux and macOS): no such process; EPERM: it exists, someone else's
    std::io::Error::last_os_error().raw_os_error() != Some(3)
}

/// Whether process `pid` runs on this machine (true when unsure).
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetExitCodeProcess(process: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    const ERROR_INVALID_PARAMETER: i32 = 87;
    // SAFETY: documented kernel32 calls; the handle is closed before returning
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            // no such process; any other failure (access denied) means it exists
            return std::io::Error::last_os_error().raw_os_error() != Some(ERROR_INVALID_PARAMETER);
        }
        let mut code = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok == 0 || code == STILL_ACTIVE
    }
}

/// The run's folders, removed with everything in them when the run ends, however it ends (a SIGKILL leaves them, and
/// the next run beside them sweeps them: `sweep`).
pub struct RunDirs {
    pub dirs: Vec<PathBuf>,
    locks: Vec<File>,
}

impl RunDirs {
    /// Makes the run's folders: `.corridorkey-<run>` in `staging_in` and `corridorkey-<run>` in `temp_in` (made if
    /// missing), each with its lock held. Ok: the folders and their paths (staging, temp). Err: why not.
    pub fn create(staging_in: &Path, temp_in: &Path) -> Result<(RunDirs, PathBuf, PathBuf), String> {
        std::fs::create_dir_all(temp_in).map_err(|e| format!("can't make the temporary folder {}: {e}", temp_in.display()))?;
        let taken = |e: &std::io::Error| e.kind() == std::io::ErrorKind::AlreadyExists;
        // loop: SERIAL-REQUIRED — a new id while a name is taken (64 random bits: never in practice) [bounded: 3 tries]
        for _ in 0..3 {
            let id = run_id();
            let (staging, temp) = (staging_in.join(format!(".corridorkey-{id}")), temp_in.join(format!("corridorkey-{id}")));
            match std::fs::create_dir(&staging) {
                Err(e) if taken(&e) => continue,
                Err(e) => return Err(format!("can't make the run's folder {}: {e}", staging.display())),
                Ok(()) => {}
            }
            // from here the folders are removed if anything fails
            let mut dirs = RunDirs { dirs: vec![staging.clone()], locks: Vec::new() };
            match std::fs::create_dir(&temp) {
                Err(e) if taken(&e) => continue,
                Err(e) => return Err(format!("can't make the temporary folder {}: {e}", temp.display())),
                Ok(()) => dirs.dirs.push(temp.clone()),
            }
            // loop: NOT-WORTH — two folders
            for d in [&staging, &temp] {
                let f = File::create(d.join(LOCK)).map_err(|e| format!("can't make {}: {e}", d.join(LOCK).display()))?;
                // a filesystem without locks: the sweep then goes by the PID and the age alone
                let _ = f.try_lock();
                dirs.locks.push(f);
            }
            return Ok((dirs, staging, temp));
        }
        Err(format!("can't find a free name for the run's folder in {}", staging_in.display()))
    }
}

impl Drop for RunDirs {
    fn drop(&mut self) {
        // the lock files first: Windows doesn't delete a file that is open
        self.locks.clear();
        // loop: NOT-WORTH — two folders
        for d in &self.dirs {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

/// Whether a live run holds the lock in run folder `dir` (false without a lock file: an older run, or one killed
/// before it made it; false on a filesystem without locks).
fn locked(dir: &Path) -> bool {
    match File::options().read(true).write(true).open(dir.join(LOCK)) {
        Err(_) => false,
        Ok(f) => matches!(f.try_lock(), Err(TryLockError::WouldBlock)),
    }
}

/// Whether nothing in run folder `dir` (it or its direct entries: the results' folders get every frame) changed for
/// STALE_AFTER before `now`.
fn stale(dir: &Path, now: SystemTime) -> bool {
    let own = dir.metadata().and_then(|m| m.modified()).ok();
    // loop: NOT-WORTH — a run folder's few entries (the outputs' folders, the lock), once per abandoned folder
    let newest = std::fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| e.metadata().and_then(|m| m.modified()).ok()).chain(own).max();
    newest.is_some_and(|t| now.duration_since(t).is_ok_and(|age| age > STALE_AFTER))
}

/// Removes the run folders (`<prefix><run id>`) in `dir` whose runs are certainly over: no live run holds the folder's
/// lock, and either this machine (`host`) made it in a process that is gone (`alive`), or nothing in it changed for
/// STALE_AFTER. A folder whose lock is held is never touched (a run in another container with the same host name and
/// PIDs). Returns the folders removed.
pub fn sweep(dir: &Path, prefix: &str, host: &str, alive: impl Fn(u32) -> bool, now: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut gone = Vec::new();
    // loop: NOT-WORTH — the output (or temporary) folder's entries, once per run
    for e in entries.flatten() {
        let name = e.file_name();
        let Some((made_on, pid)) = name.to_str().and_then(|n| n.strip_prefix(prefix)).and_then(parse_id) else { continue };
        let path = e.path();
        if !e.file_type().is_ok_and(|t| t.is_dir()) || pid == std::process::id() && made_on == Some(host) {
            continue;
        }
        let dead = made_on == Some(host) && !alive(pid);
        if (dead || stale(&path, now)) && !locked(&path) && std::fs::remove_dir_all(&path).is_ok() {
            gone.push(path);
        }
    }
    gone
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ck-cli-rundirs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn a_run_id_names_its_host_and_pid_and_never_repeats() {
        // farm review 2026-10-26 S5: `<pid>-<ms>` repeated across containers starting in the same millisecond
        let (a, b) = (run_id(), run_id());
        assert_ne!(a, b);
        assert_eq!(parse_id(&a), Some((Some(host().as_str()), std::process::id())));
        assert_eq!(parse_id("render-node-07-4242-0123456789abcdef"), Some((Some("render-node-07"), 4242)));
        assert_eq!(parse_id("4242-19a1b2c3d4e"), Some((None, 4242)), "the older ids");
        // loop: NOT-WORTH — a test's few names
        for not_ours in ["2-0", "v1-2-3", "x-4242-0123", "-4242-0123456789abcdef", "a-b-0123456789abcdef", "4242"] {
            assert_eq!(parse_id(not_ours), None, "{not_ours}");
        }
    }

    #[test]
    fn the_sweep_removes_only_runs_that_are_certainly_over() {
        // farm review 2026-10-26 S8: killed runs' folders (GBs each) piled up beside the outputs
        let d = scratch("sweep");
        let me = host();
        let dir = |id: &str| {
            let p = d.join(format!(".corridorkey-{id}"));
            std::fs::create_dir_all(p.join("sh010_alpha_exr")).unwrap();
            p
        };
        let dead = dir(&format!("{me}-1001-0123456789abcdef"));
        let live = dir(&format!("{me}-1002-0123456789abcdef"));
        // same host name and a PID gone here, but its lock held: a live run in another container
        let held = dir(&format!("{me}-1003-0123456789abcdef"));
        let lock = File::create(held.join(LOCK)).unwrap();
        lock.try_lock().unwrap();
        let other = dir("render-node-07-1001-0123456789abcdef");
        let older = dir("1001-19a1b2c3d4e");
        let not_ours = d.join(".corridorkey-settings");
        std::fs::create_dir_all(&not_ours).unwrap();
        let alive = |pid: u32| pid == 1002;
        let now = SystemTime::now();
        assert_eq!(sweep(&d, ".corridorkey-", &me, alive, now), vec![dead.clone()]);
        // a week later: another machine's and the older format's folders are abandoned too; a held lock never is
        let mut later = sweep(&d, ".corridorkey-", &me, alive, now + STALE_AFTER + Duration::from_secs(60));
        later.sort();
        let mut want = vec![live.clone(), other.clone(), older.clone()];
        want.sort();
        assert_eq!(later, want);
        assert!(held.exists() && not_ours.exists());
        drop(lock);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_live_runs_folders_are_never_swept_and_go_when_it_ends() {
        let d = scratch("live");
        let (dirs, staging, temp) = RunDirs::create(&d, &d.join("tmp")).unwrap();
        assert!(staging.file_name().unwrap().to_str().unwrap().starts_with(&format!(".corridorkey-{}-{}-", host(), std::process::id())));
        // even when its PID reads as gone (another PID namespace), its lock keeps it
        let a_week_on = SystemTime::now() + STALE_AFTER * 2;
        assert!(sweep(&d, ".corridorkey-", "another-host", |_| false, a_week_on).is_empty());
        assert!(sweep(&d.join("tmp"), "corridorkey-", "another-host", |_| false, a_week_on).is_empty());
        assert!(staging.is_dir() && temp.is_dir());
        drop(dirs);
        assert!(!staging.exists() && !temp.exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
