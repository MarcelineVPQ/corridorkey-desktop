#!/usr/bin/env python3
"""Parity fixtures for the Rust port: small inputs and the upstream Python functions' outputs as .npy.

Run with a CorridorKey2.0 checkout's venv (torch, cv2, numpy); the checkout is only imported, never changed:
  <CorridorKey2.0>/venv/bin/python engine-rs/tools/gen_fixtures.py <CorridorKey2.0> engine-rs/crates/ck-core/tests/fixtures
"""
import json
import sys
from pathlib import Path

root, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
sys.path.insert(0, str(root))
out.mkdir(parents=True, exist_ok=True)

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402

from corridorkey import color_utils as cu  # noqa: E402
from corridorkey import runtime as rt  # noqa: E402
from corridorkey import video_io as vio  # noqa: E402

rng = np.random.default_rng(1234)


def save(name, arr):
    np.save(out / f"{name}.npy", np.ascontiguousarray(arr))


def bf(t):
    return t.float().numpy()


# --- colour transforms on a value sweep (float32)
x = np.concatenate([np.linspace(-2, 2, 161), np.linspace(2, 40, 39), [0.0, 0.0031308, 0.04045, 1e-6, -1e-6, 16.0]]).astype(np.float32)
save("color_x", x)
save("srgb_to_linear", cu.srgb_to_linear(x))
save("linear_to_srgb", cu.linear_to_srgb(x))
save("linear_to_asinh", cu.linear_to_asinh(x).astype(np.float32))
save("asinh_to_linear", cu.asinh_to_linear(torch.from_numpy(x)).numpy())
rgb = rng.uniform(-0.2, 1.4, size=(1, 3, 1, 64)).astype(np.float32)
save("despill_in", rgb[0, :, 0, :])
# loop: NOT-WORTH — three strengths (fixture generation, by hand)
for s in (0.3, 0.5, 1.0):
    save(f"despill_{int(s * 100):03d}", rt._despill_average_srgb_torch(torch.from_numpy(rgb), s)[0, :, 0, :].numpy())

# --- video frame preprocessing: padding (reflect 101), sRGB -> linear -> asinh, bfloat16 tensors
frame_rgb = rng.integers(0, 256, size=(37, 53, 3), dtype=np.uint8)
save("prep_frame_rgb", frame_rgb)
meta = {"shape_hw": (128, 128), "model_native_hw": (37, 53), "linear_brightness": 1.0, "linear_contrast": 1.0}
model_t, found_t, review_t = vio.preprocess_video_frame_views(frame_rgb[:, :, ::-1].copy(), meta, need_model=True)
save("prep_model", bf(model_t))
save("prep_review", bf(review_t))

# --- resamplers
img = rng.uniform(0, 1, size=(3, 128, 192)).astype(np.float32)
save("resize_in", img)
t = torch.from_numpy(img)[None]
save("area_32x48", F.interpolate(t, size=(32, 48), mode="area")[0].numpy())
save("area_28x42", F.interpolate(t, size=(128 * 7 // 32, 192 * 7 // 32), mode="area")[0].numpy())
save("bilinear_32x48", F.interpolate(t, size=(32, 48), mode="bilinear", align_corners=False)[0].numpy())
small = rng.uniform(0, 1, size=(1, 64, 96)).astype(np.float32)
save("bilinear_up_in", small)
save("bilinear_up_128x192", F.interpolate(torch.from_numpy(small)[None], size=(128, 192), mode="bilinear", align_corners=False)[0].numpy())
lz = rng.uniform(0, 1, size=(50, 70)).astype(np.float32)
save("lanczos_in", lz)
save("lanczos_64x96", cv2.resize(lz, (96, 64), interpolation=cv2.INTER_LANCZOS4))
save("lanczos_37x53", cv2.resize(lz, (53, 37), interpolation=cv2.INTER_LANCZOS4))

# --- hint frame (video path): BGR -> gray, Lanczos to the model size, clip, pad, bfloat16
hint_rgb = rng.integers(0, 256, size=(30, 40, 3), dtype=np.uint8)
save("hint_rgb", hint_rgb)
save("hint_prep", bf(vio.preprocess_hint_frame(hint_rgb[:, :, ::-1].copy(), meta))[0])

# --- Hann windows
cases = []
for tc, ov, first, last in [(4, 2, True, False), (4, 2, False, True), (4, 2, False, False), (24, 12, False, False),
                            (80, 40, True, False), (5, 9, False, False), (1, 3, False, False), (8, 0, False, False)]:
    w = vio.taper_weights(tc, ov, is_first=first, is_last=last, device="cpu", dtype=torch.float32).numpy()
    # loop: NOT-WORTH — a window's weights (fixture generation)
    cases.append({"tc": tc, "overlap": ov, "first": first, "last": last, "w": [float(v) for v in w]})
starts = [{"t": T, "chunk": c, "stride": s, "starts": vio.window_starts(T, c, s)}
          for T, c, s in [(8, 4, 2), (9, 4, 2), (3, 8, 4), (240, 80, 40), (349, 24, 12), (100, 48, 24), (7, 1, 1)]]

# --- auto VRAM table
vram = []
# loop: NOT-WORTH — five sizes × the cases below: the 360-case VRAM table (fixture generation, seconds)
for hw in [(256, 384), (768, 1280), (1152, 1920), (2176, 3840), (4352, 7680)]:
    # loop: NOT-WORTH — four clip lengths (fixture generation)
    for frames in [1, 7, 30, 240]:
        # loop: NOT-WORTH — eight budgets (fixture generation)
        for budget in [1.0, 3.0, 6.0, 8.0, 12.0, 15.5, 24.0, 80.0]:
            c, s, low, est = rt.select_vram_profile(hw, frames, budget)
            vram.append({"hw": hw, "frames": frames, "budget": budget, "chunk": c, "stride": s, "low_vram": low, "estimate": est})
        # loop: NOT-WORTH — two modes (fixture generation)
        for low in (False, True):
            # loop: NOT-WORTH — five frame counts (fixture generation)
            for f in (1, 4, 13, 50, 100):
                vram.append({"hw": hw, "frames": f, "low_vram": low, "peak": rt.estimate_peak_vram_gb(hw[0] * hw[1] / 1e6, f, low)})
(out / "windows_vram.json").write_text(json.dumps({"taper": cases, "starts": starts, "vram": vram}))

# --- render paths: logits (4, 40, 56), native 30x44 at pad (6, 6, 5, 5)
logits = np.concatenate([rng.uniform(-0.3, 1.3, size=(1, 40, 56)), rng.uniform(-0.4, 1.1, size=(3, 40, 56))]).astype(np.float32)
save("render_logits", logits)
rmeta = {"model_native_hw": (30, 44), "output_hw": (30, 44), "pad": (6, 6, 5, 5), "despill_strength": 0.5}
checker = torch.from_numpy(vio.make_checker(30, 44))
outs = {"alpha", "fg", "checker", "cutout"}
# loop: NOT-WORTH — two render modes (fixture generation)
for lin in (False, True):
    rmeta["cutout_linear"] = lin
    r = rt._render_predictions_torch(rmeta, outs, checker, torch.from_numpy(logits)[None])
    # loop: NOT-WORTH — four outputs (fixture generation)
    for k, v in r.items():
        if k == "cutout" or not lin:
            save(f"render_video_{k}{'_lin' if lin and k == 'cutout' else ''}", v[0])
r = rt._render_predictions_exr_torch(rmeta, outs, checker, torch.from_numpy(logits)[None])
# loop: NOT-WORTH — four outputs (fixture generation)
for k, v in r.items():
    save(f"render_exr_{k}", v[0])

# --- stills as cv2 reads them
stills = out / "stills"
stills.mkdir(exist_ok=True)
smooth = cv2.GaussianBlur(rng.integers(0, 65536, size=(24, 32, 3)).astype(np.uint16), (5, 5), 2)
cv2.imwrite(str(stills / "rgb16.png"), smooth)
cv2.imwrite(str(stills / "rgb8.png"), (smooth >> 8).astype(np.uint8))
cv2.imwrite(str(stills / "q90.jpg"), (smooth >> 8).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 90])
# loop: NOT-WORTH — three test images (fixture generation)
for name in ("rgb16.png", "rgb8.png", "q90.jpg"):
    save("still_" + name.replace(".", "_"), vio.read_image_rgb(stills / name).transpose(2, 0, 1))
gray16 = rng.integers(0, 65536, size=(24, 32), dtype=np.uint16)
cv2.imwrite(str(stills / "hint16.png"), gray16)
save("still_hint16", vio.read_hint_image(stills / "hint16.png"))
print("fixtures written to", out)
