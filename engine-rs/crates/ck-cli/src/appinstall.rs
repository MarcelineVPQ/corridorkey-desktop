//! The app's own install, for a `corridorkey` line pasted into a terminal (the Queue's Copy as command; P4 SME review
//! 2026-10-27 S2): without `--models` / `CK_ENGINE_MODELS` (or `--ort` / `CK_ENGINE_ORT` / `ORT_DYLIB_PATH`), the
//! model set and ONNX Runtime the app installed are used, by the app's own "Automatic" rule (electron/main/engineFind.ts:
//! the newest model set, the newest runtime), and the CLI says which. The app's data folder: Linux
//! `$XDG_DATA_HOME/corridorkey-desktop` (else `~/.local/share/…`), Windows `%LOCALAPPDATA%\corridorkey-desktop`, macOS
//! `~/Library/Application Support/corridorkey-desktop` (electron/main/platform.ts appDirs).
use std::path::{Path, PathBuf};

const APP_DIR: &str = "corridorkey-desktop";

/// The app's data folder on `os` (std::env::consts::OS), from the environment `var`.
pub fn data_dir(var: &dyn Fn(&str) -> Option<String>, os: &str) -> Option<PathBuf> {
    let set = |k: &str| var(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let root = match os {
        "windows" => set("LOCALAPPDATA").or_else(|| set("USERPROFILE").map(|h| h.join("AppData").join("Local")))?,
        "macos" => set("HOME")?.join("Library").join("Application Support"),
        _ => set("XDG_DATA_HOME").or_else(|| set("HOME").map(|h| h.join(".local").join("share")))?,
    };
    Some(root.join(APP_DIR))
}

/// A folder's entries that are folders, not starting with "." (an install in progress), sorted by name.
fn folders(p: &Path) -> Vec<(String, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(p) else { return Vec::new() };
    // loop: NOT-WORTH — the models or runtime folder's few entries, once per run
    let mut out: Vec<(String, PathBuf)> =
        rd.flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), e.path())).filter(|(n, p)| !n.starts_with('.') && p.is_dir()).collect();
    out.sort();
    out
}

/// The newest model set in `<data>/models`: a folder with models.json; newest by its manifest's `created`, then its
/// version (or folder name), as the Engine page's list is ordered.
pub fn newest_models(data: &Path) -> Option<PathBuf> {
    // loop: NOT-WORTH — one or two model sets, one small manifest each
    let mut sets: Vec<(String, String, PathBuf)> = folders(&data.join("models"))
        .into_iter()
        .filter(|(_, p)| p.join("models.json").is_file())
        .map(|(name, p)| {
            let m: serde_json::Value = std::fs::read_to_string(p.join("manifest.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
            let s = |k: &str| m.get(k).and_then(|v| v.as_str()).map(str::to_string);
            (s("created").unwrap_or_default(), s("version").unwrap_or(name), p)
        })
        .collect();
    sets.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    sets.into_iter().next().map(|(_, _, p)| p)
}

/// "1.31.0" as numbers, compared part by part.
fn version_key(v: &str) -> Vec<u64> {
    // loop: NOT-WORTH — a few version parts
    v.split('.').map(|n| n.parse().unwrap_or(0)).collect()
}

/// The newest ONNX Runtime in `<data>/runtime`: `<name>/onnxruntime/capi/<library>` (the pip wheel's layout), its
/// version from the library's name (Linux, macOS) or the wheel's dist-info folder (Windows).
pub fn newest_ort(data: &Path, os: &str) -> Option<PathBuf> {
    let mut found: Vec<(Vec<u64>, PathBuf)> = Vec::new();
    // loop: NOT-WORTH — one or two installed runtimes
    for (_, dir) in folders(&data.join("runtime")) {
        let capi = dir.join("onnxruntime").join("capi");
        let Ok(rd) = std::fs::read_dir(&capi) else { continue };
        // loop: NOT-WORTH — a dozen files in ONNX Runtime's capi folder
        let names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        let lib = match os {
            // loop: NOT-WORTH — as above
            "windows" => names.iter().find(|n| *n == "onnxruntime.dll").map(|n| {
                // loop: NOT-WORTH — the runtime folder's few entries
                let v = folders(&dir).into_iter().find_map(|(f, _)| {
                    f.strip_prefix("onnxruntime_gpu-").or(f.strip_prefix("onnxruntime-")).and_then(|r| r.strip_suffix(".dist-info")).map(str::to_string)
                });
                (n.clone(), v)
            }),
            // loop: NOT-WORTH — as above
            "macos" => names.iter().find_map(|n| {
                n.strip_prefix("libonnxruntime.")
                    .and_then(|r| r.strip_suffix(".dylib"))
                    .filter(|v| v.starts_with(|c: char| c.is_ascii_digit()))
                    .map(|v| (n.clone(), Some(v.to_string())))
            }),
            // loop: NOT-WORTH — as above
            _ => names.iter().find_map(|n| {
                n.strip_prefix("libonnxruntime.so.").filter(|v| v.starts_with(|c: char| c.is_ascii_digit())).map(|v| (n.clone(), Some(v.to_string())))
            }),
        };
        if let Some((name, Some(version))) = lib {
            found.push((version_key(&version), capi.join(name)));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().next().map(|(_, p)| p)
}

/// The folders ONNX Runtime's GPU providers load their libraries from (electron/main/engine.ts rustEngineEnv): the
/// library's own, the wheel's nvidia/<x>/lib (Windows: bin, bin/x86_64), tensorrt_libs, and on Windows the Visual C++
/// runtime wheel's Scripts.
pub fn library_dirs(ort: &Path, os: &str) -> Vec<PathBuf> {
    let Some(capi) = ort.parent() else { return Vec::new() };
    let mut dirs = vec![capi.to_path_buf()];
    let Some(site) = capi.parent().and_then(Path::parent) else { return dirs };
    let win = os == "windows";
    // loop: NOT-WORTH — a handful of CUDA library folders
    for (_, d) in folders(&site.join("nvidia")) {
        let subs: &[&str] = if win { &["bin/x86_64", "bin"] } else { &["lib"] };
        // loop: NOT-WORTH — two candidate folders per CUDA package
        dirs.extend(subs.iter().map(|s| d.join(s)).filter(|p| p.is_dir()));
    }
    if site.join("tensorrt_libs").is_dir() {
        dirs.push(site.join("tensorrt_libs"));
    }
    if win {
        // loop: NOT-WORTH — the runtime folder's few entries
        dirs.extend(
            folders(site)
                .into_iter()
                .filter(|(n, _)| n.starts_with("msvc_runtime-") && n.ends_with(".data"))
                .map(|(_, p)| p.join("data").join("Scripts"))
                .filter(|p| p.is_dir()),
        );
    }
    dirs
}

/// What the run falls back to: the app's model set and runtime where none was given, and the lines that say so.
#[derive(Debug, Default, PartialEq)]
pub struct Fallback {
    pub models: Option<PathBuf>,
    pub ort: Option<PathBuf>,
    pub notes: Vec<String>,
}

/// The fallback for a run given `--models` / `--ort` (or not) and the environment `var`.
pub fn fallback(models_flag: bool, ort_flag: bool, var: &dyn Fn(&str) -> Option<String>, os: &str) -> Fallback {
    let given = |k: &str| var(k).is_some_and(|v| !v.is_empty());
    let need_models = !models_flag && !given("CK_ENGINE_MODELS");
    let need_ort = !ort_flag && !given("CK_ENGINE_ORT") && !given("ORT_DYLIB_PATH");
    let mut f = Fallback::default();
    if !need_models && !need_ort {
        return f;
    }
    let Some(data) = data_dir(var, os) else { return f };
    if need_models {
        f.models = newest_models(&data);
        if let Some(m) = &f.models {
            f.notes.push(format!("no --models given: using the app's model set {} (--models DIR or CK_ENGINE_MODELS for another)", m.display()));
        }
    }
    if need_ort {
        f.ort = newest_ort(&data, os);
        if let Some(o) = &f.ort {
            f.notes.push(format!("no --ort given: using the app's ONNX Runtime {} (--ort LIB or CK_ENGINE_ORT for another)", o.display()));
        }
    }
    f
}

/// Applies the fallback to this process before the runtime starts: CK_ENGINE_MODELS / CK_ENGINE_ORT, and the runtime's
/// library folders. Linux reads LD_LIBRARY_PATH only when a program starts, so there the CLI starts itself again once
/// with it (CK_ENGINE_ORT then set: no second fallback); Windows searches PATH when a DLL loads. Called with no other
/// thread running.
pub fn apply(f: &Fallback, quiet: bool) {
    if !quiet {
        // loop: NOT-WORTH — one or two lines
        for n in &f.notes {
            eprintln!("corridorkey: {n}");
        }
    }
    if let Some(m) = &f.models {
        std::env::set_var("CK_ENGINE_MODELS", m);
    }
    let Some(ort) = &f.ort else { return };
    std::env::set_var("CK_ENGINE_ORT", ort);
    let os = std::env::consts::OS;
    let dirs = library_dirs(ort, os);
    let (key, sep) = if os == "windows" { ("PATH", ";") } else { ("LD_LIBRARY_PATH", ":") };
    if os == "macos" {
        return; // Core ML is inside the library: no other folders
    }
    let old = std::env::var(key).unwrap_or_default();
    // loop: NOT-WORTH — a few folders joined, once per run
    let joined = dirs.iter().map(|d| d.to_string_lossy().into_owned()).chain(std::iter::once(old).filter(|o| !o.is_empty())).collect::<Vec<_>>().join(sep);
    std::env::set_var(key, joined);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let Ok(exe) = std::env::current_exe() else { return };
        // exec only returns on a failure: then the run goes on without the folders (and says so if a provider fails)
        let e = std::process::Command::new(exe).args(std::env::args_os().skip(1)).exec();
        eprintln!("corridorkey: couldn't restart with the runtime's library folders ({e}); the graphics card's provider may not load");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ck-appinstall-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn file(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn vars(pairs: Vec<(&'static str, String)>) -> impl Fn(&str) -> Option<String> {
        // loop: NOT-WORTH — a test's few variables
        move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone())
    }

    #[test]
    fn the_apps_data_folder_per_system() {
        let v = vars(vec![("HOME", "/h".into()), ("LOCALAPPDATA", "C:\\Users\\m\\AppData\\Local".into())]);
        assert_eq!(data_dir(&v, "linux"), Some(PathBuf::from("/h/.local/share/corridorkey-desktop")));
        assert_eq!(data_dir(&vars(vec![("HOME", "/h".into()), ("XDG_DATA_HOME", "/x".into())]), "linux"), Some(PathBuf::from("/x/corridorkey-desktop")));
        assert_eq!(data_dir(&v, "macos"), Some(PathBuf::from("/h/Library/Application Support/corridorkey-desktop")));
        assert_eq!(data_dir(&v, "windows"), Some(PathBuf::from("C:\\Users\\m\\AppData\\Local").join("corridorkey-desktop")));
        assert_eq!(data_dir(&vars(vec![]), "linux"), None);
    }

    #[test]
    fn newest_model_set_and_runtime_as_the_app_picks_them() {
        let d = scratch("newest");
        // two model sets: the newer by its manifest's created; one without models.json and one in progress never count
        file(&d.join("models/2.0.0-onnx.3/models.json"), "{}");
        file(&d.join("models/2.0.0-onnx.3/manifest.json"), r#"{"version":"2.0.0-onnx.3","created":"2026-10-01"}"#);
        file(&d.join("models/2.0.0-onnx.4/models.json"), "{}");
        file(&d.join("models/2.0.0-onnx.4/manifest.json"), r#"{"version":"2.0.0-onnx.4","created":"2026-10-20"}"#);
        file(&d.join("models/zz-broken/manifest.json"), r#"{"created":"2027-01-01"}"#);
        file(&d.join("models/.partial-x/models.json"), "{}");
        assert_eq!(newest_models(&d), Some(d.join("models/2.0.0-onnx.4")));
        // runtimes: newest by version, numerically (1.31.0 after 1.9.0)
        file(&d.join("runtime/ort-1.9.0/onnxruntime/capi/libonnxruntime.so.1.9.0"), "");
        file(&d.join("runtime/ort-1.31.0/onnxruntime/capi/libonnxruntime.so.1.31.0"), "");
        file(&d.join("runtime/ort-1.31.0/nvidia/cublas/lib/libcublas.so.13"), "");
        file(&d.join("runtime/ort-1.31.0/tensorrt_libs/x.so"), "");
        let ort = newest_ort(&d, "linux").unwrap();
        assert_eq!(ort, d.join("runtime/ort-1.31.0/onnxruntime/capi/libonnxruntime.so.1.31.0"));
        assert_eq!(
            library_dirs(&ort, "linux"),
            vec![d.join("runtime/ort-1.31.0/onnxruntime/capi"), d.join("runtime/ort-1.31.0/nvidia/cublas/lib"), d.join("runtime/ort-1.31.0/tensorrt_libs")]
        );
        // Windows: the version from the wheel's dist-info
        file(&d.join("runtime/w/onnxruntime/capi/onnxruntime.dll"), "");
        std::fs::create_dir_all(d.join("runtime/w/onnxruntime_gpu-1.40.0.dist-info")).unwrap();
        assert_eq!(newest_ort(&d, "windows"), Some(d.join("runtime/w/onnxruntime/capi/onnxruntime.dll")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn falls_back_only_where_nothing_was_given_and_says_what_it_found() {
        let d = scratch("fallback");
        file(&d.join("corridorkey-desktop/models/s/models.json"), "{}");
        file(&d.join("corridorkey-desktop/runtime/r/onnxruntime/capi/libonnxruntime.so.1.31.0"), "");
        let home = d.to_string_lossy().into_owned();
        let none = vars(vec![("XDG_DATA_HOME", home.clone())]);
        let f = fallback(false, false, &none, "linux");
        assert_eq!(f.models, Some(d.join("corridorkey-desktop/models/s")));
        assert_eq!(f.ort, Some(d.join("corridorkey-desktop/runtime/r/onnxruntime/capi/libonnxruntime.so.1.31.0")));
        assert!(
            f.notes[0].starts_with("no --models given: using the app's model set ") && f.notes[0].replace('\\', "/").contains("corridorkey-desktop/models/s"),
            "{:?}",
            f.notes
        );
        assert!(f.notes[1].starts_with("no --ort given: using the app's ONNX Runtime "), "{:?}", f.notes);
        // a flag or the environment wins, each on its own
        assert_eq!(fallback(true, true, &none, "linux"), Fallback::default());
        let env = vars(vec![("XDG_DATA_HOME", home.clone()), ("CK_ENGINE_MODELS", "/m".into()), ("ORT_DYLIB_PATH", "/o.so".into())]);
        assert_eq!(fallback(false, false, &env, "linux"), Fallback::default());
        let f = fallback(true, false, &none, "linux");
        assert_eq!((f.models, f.ort.is_some(), f.notes.len()), (None, true, 1));
        // no app install: nothing found, nothing said (the run says what is missing, as before)
        assert_eq!(fallback(false, false, &vars(vec![("XDG_DATA_HOME", "/nonexistent-ck".into())]), "linux"), Fallback::default());
        let _ = std::fs::remove_dir_all(&d);
    }
}
