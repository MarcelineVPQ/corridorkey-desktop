//! Colour transforms of the upstream runtime (corridorkey/color_utils.py, runtime.py's render helpers), in
//! float32 as the runtime computes them (torch float32 on the GPU, numpy float32 on the host).
//!
//! The model's RGB contract: display-coded sRGB -> scene-linear (IEC 61966-2-1) -> signed asinh
//! (knee 0.008, ref 16). Its fg output goes back the other way.

pub(crate) const HDR_ASINH_KNEE: f32 = 0.008;
pub(crate) const HDR_ASINH_REF: f64 = 16.0;

/// asinh(ref / knee) as color_utils computes it (numpy float64), used as float32 (`x.new_tensor(denom)`).
pub fn asinh_denom() -> f32 {
    (HDR_ASINH_REF / HDR_ASINH_KNEE as f64).asinh() as f32
}

/// IEC 61966-2-1 linear -> sRGB, sign-mirrored for negatives (color_utils.linear_to_srgb).
#[inline]
pub fn linear_to_srgb(x: f32) -> f32 {
    #[inline]
    fn pos(v: f32) -> f32 {
        if v <= 0.0031308 {
            v * 12.92
        } else {
            1.055 * v.max(0.0031308).powf(1.0 / 2.4) - 0.055
        }
    }
    if x >= 0.0 {
        pos(x)
    } else {
        -pos(-x)
    }
}

/// IEC 61966-2-1 sRGB -> linear, sign-mirrored for negatives (color_utils.srgb_to_linear).
#[inline]
pub fn srgb_to_linear(x: f32) -> f32 {
    #[inline]
    fn pos(v: f32) -> f32 {
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    }
    if x >= 0.0 {
        pos(x)
    } else {
        -pos(-x)
    }
}

/// Signed asinh encoding (color_utils.linear_to_asinh): asinh(x / knee) / asinh(ref / knee).
#[inline]
pub fn linear_to_asinh(x: f32, denom: f32) -> f32 {
    (x / HDR_ASINH_KNEE).asinh() / denom
}

/// Inverse of `linear_to_asinh` (color_utils.asinh_to_linear): sinh(y * denom) * knee.
#[inline]
pub fn asinh_to_linear(y: f32, denom: f32) -> f32 {
    (y * denom).sinh() * HDR_ASINH_KNEE
}

/// The scene-linear brightness/contrast adjust (video_io.apply_linear_adjust) and its inverse
/// (runtime._linear_adjust_inverse_torch): `--linear_brightness` (gain), `--linear_contrast` and
/// `--linear_contrast_pivot` (backlog row 45). Identity, as upstream decides it, when gain and contrast are both within
/// 1e-6 of 1 (checked on the given doubles, as Python does); the math in float32, as numpy and torch run it on the
/// runtime's float32 frames (the Python scalars taken as float32).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LinearAdjust {
    pub(crate) gain: f32,
    pub(crate) contrast: f32,
    pub(crate) pivot: f32,
    identity: bool,
}

impl Default for LinearAdjust {
    fn default() -> Self {
        LinearAdjust::new(1.0, 1.0, 0.18)
    }
}

impl LinearAdjust {
    pub fn new(gain: f64, contrast: f64, pivot: f64) -> LinearAdjust {
        let identity = (gain - 1.0).abs() <= 1e-6 && (contrast - 1.0).abs() <= 1e-6;
        LinearAdjust { gain: gain as f32, contrast: contrast as f32, pivot: pivot as f32, identity }
    }
    /// video_io.has_linear_adjust
    pub fn is_identity(&self) -> bool {
        self.identity
    }
    /// video_io.apply_linear_adjust: gain * (pivot + contrast * (x - pivot)), on the model's linear input
    #[inline]
    pub fn apply(&self, x: f32) -> f32 {
        if self.identity {
            x
        } else {
            self.gain * (self.pivot + self.contrast * (x - self.pivot))
        }
    }
    /// runtime._linear_adjust_inverse_torch: (x / gain - pivot) / contrast + pivot, on the decoded foreground
    #[inline]
    pub fn invert(&self, x: f32) -> f32 {
        if self.identity {
            x
        } else {
            (x / self.gain - self.pivot) / self.contrast + self.pivot
        }
    }
}

/// CorridorKey's average despill on one RGB pixel (runtime._despill_average_srgb_torch): green above the
/// mean of red and blue is moved half to red, half to blue; `strength` blends with the original.
#[inline]
pub fn despill(rgb: [f32; 3], strength: f32) -> [f32; 3] {
    if strength <= 0.0 {
        return rgb;
    }
    let [r, g, b] = rgb;
    let spill = (g - (r + b) * 0.5).max(0.0);
    let full = [r + spill * 0.5, g - spill, b + spill * 0.5];
    if strength >= 1.0 {
        return full;
    }
    [r * (1.0 - strength) + full[0] * strength, g * (1.0 - strength) + full[1] * strength, b * (1.0 - strength) + full[2] * strength]
}

/// The largest input value kept as it is: `x / knee` (the asinh encoding) stays finite in float32 up to here.
pub(crate) const INPUT_MAX: f32 = 1e30;

/// A decoded input value the networks can take: NaN -> 0, +-infinity (and beyond +-INPUT_MAX) -> +-INPUT_MAX;
/// every other value unchanged. Measured: three non-finite pixels in a linear EXR plate (NaN, +inf, -inf) made
/// every pixel of every output frame NaN (the networks' attention spreads one NaN everywhere).
#[inline]
pub(crate) fn finite_input(v: f32) -> f32 {
    if v.is_nan() {
        0.0
    } else {
        v.clamp(-INPUT_MAX, INPUT_MAX)
    }
}

/// torch's float32 -> bfloat16 (round to nearest even), back to float32: the runtime keeps decoded frames,
/// hints and hint quality as bfloat16 tensors.
#[inline]
pub(crate) fn bf16_round(x: f32) -> f32 {
    half::bf16::from_f32(x).to_f32()
}

/// `(x.clamp(0, 1) * 65535).astype(uint16)`: the 16-bit samples the video writers get (truncated).
#[inline]
pub(crate) fn to_u16(x: f32) -> u16 {
    let v = x.clamp(0.0, 1.0) * 65535.0;
    v as u16
}

/// A stored value read as float32 (exact for float16).
pub trait ToF32: Copy + Send + Sync {
    fn to_f32(self) -> f32;
}

impl ToF32 for f32 {
    #[inline]
    fn to_f32(self) -> f32 {
        self
    }
}

impl ToF32 for half::f16 {
    #[inline]
    fn to_f32(self) -> f32 {
        half::f16::to_f32(self)
    }
}

#[cfg(test)]
mod finite_tests {
    use super::*;

    #[test]
    fn non_finite_inputs_become_finite_and_finite_ones_stay() {
        assert_eq!(finite_input(f32::NAN), 0.0);
        assert_eq!(finite_input(f32::INFINITY), INPUT_MAX);
        assert_eq!(finite_input(f32::NEG_INFINITY), -INPUT_MAX);
        for v in [0.0f32, -0.5, 1.0, 40.0, 70000.0, 1e20] {
            assert_eq!(finite_input(v), v);
        }
        assert!(linear_to_asinh(finite_input(f32::INFINITY), asinh_denom()).is_finite());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asinh_round_trip_and_odd() {
        let d = asinh_denom();
        // loop: NOT-WORTH — a handful of test values
        for x in [-3.0f32, -0.01, 0.0, 0.001, 0.18, 1.0, 16.0, 100.0] {
            let y = linear_to_asinh(x, d);
            assert!((asinh_to_linear(y, d) - x).abs() <= 1e-5 * x.abs().max(1.0), "{x}");
            assert_eq!(linear_to_asinh(-x, d), -y);
        }
        assert!((linear_to_asinh(16.0, d) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn srgb_round_trip() {
        // loop: NOT-WORTH — 101 test values
        for i in 0..=100 {
            let x = i as f32 / 100.0;
            assert!((linear_to_srgb(srgb_to_linear(x)) - x).abs() < 2e-6, "{x}");
        }
        assert_eq!(linear_to_srgb(-0.5), -linear_to_srgb(0.5));
    }

    #[test]
    fn despill_moves_green() {
        assert_eq!(despill([0.2, 0.8, 0.4], 1.0), [0.2 + 0.25, 0.8 - 0.5, 0.4 + 0.25]);
        assert_eq!(despill([0.5, 0.1, 0.5], 1.0), [0.5, 0.1, 0.5]);
        assert_eq!(despill([0.2, 0.8, 0.4], 0.0), [0.2, 0.8, 0.4]);
    }

    #[test]
    fn u16_truncates_like_numpy() {
        assert_eq!(to_u16(1.0), 65535);
        assert_eq!(to_u16(2.0), 65535);
        assert_eq!(to_u16(-1.0), 0);
        assert_eq!(to_u16(0.5), 32767); // 32767.5 truncated
    }
}
