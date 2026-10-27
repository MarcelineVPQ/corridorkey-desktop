//! `corridorkey`: CorridorKey on the command line for render farms and power users (docs/CLI.md). It links ck-core
//! directly: no JSON protocol, and no parent-death watch (a farm's launcher may be PID 1, or exit before its task).
pub mod args;
pub mod exit;
pub mod frames;
pub mod progress;
pub mod report;
pub mod run;
pub mod rundirs;
pub mod signals;

/// The command line's version: the app's (package.json, via ck-core), the engine's too: one number for all.
pub const VERSION: &str = ck_core::APP_VERSION;

/// The CUDA_VISIBLE_DEVICES to set before the runtime starts, or None to leave it: `--gpu` (an index in CUDA's order
/// or a GPU-/MIG- UUID, as Nuke's `--gpu` names a card) wins; without it, a CUDA_VISIBLE_DEVICES already set is the
/// farm's choice; without both, OpenCue's booking (`CUE_GPU_CORES`, a list of card indices) gives its first card.
pub fn cuda_visible(gpu_flag: Option<&str>, cuda_visible_devices: Option<&str>, cue_gpu_cores: Option<&str>) -> Option<String> {
    if let Some(g) = gpu_flag.map(str::trim).filter(|g| !g.is_empty()) {
        return Some(g.to_string());
    }
    if cuda_visible_devices.is_some() {
        return None;
    }
    // loop: NOT-WORTH — a short list of card indices
    cue_gpu_cores?.split([',', ' ']).map(str::trim).find(|c| !c.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_card_comes_from_gpu_then_the_farm() {
        assert_eq!(cuda_visible(Some("1"), None, None).as_deref(), Some("1"));
        assert_eq!(cuda_visible(Some("GPU-8f2a"), Some("0"), Some("3")).as_deref(), Some("GPU-8f2a"));
        // the farm (or the user) set CUDA_VISIBLE_DEVICES: left as it is, even empty (no card)
        assert_eq!(cuda_visible(None, Some("2"), Some("3")), None);
        assert_eq!(cuda_visible(None, Some(""), None), None);
        // OpenCue books cards in CUE_GPU_CORES: its first
        assert_eq!(cuda_visible(None, None, Some("2,3")).as_deref(), Some("2"));
        assert_eq!(cuda_visible(None, None, Some(" 1 ")).as_deref(), Some("1"));
        assert_eq!(cuda_visible(None, None, Some("")), None);
        assert_eq!(cuda_visible(None, None, None), None);
    }
}
