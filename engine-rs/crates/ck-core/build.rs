//! The app's version (package.json, the one source of truth) as `CK_APP_VERSION`: what `corridorkey --version`, its
//! reports and the engine's pong name, so farm logs show the release, never the Rust workspace's own number.
fn main() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../package.json");
    println!("cargo:rerun-if-changed={path}");
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("ck-core: can't read {path}: {e}"));
    let pkg: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("ck-core: {path}: {e}"));
    let v = pkg["version"].as_str().unwrap_or_else(|| panic!("ck-core: {path} has no \"version\""));
    println!("cargo:rustc-env=CK_APP_VERSION={v}");
}
