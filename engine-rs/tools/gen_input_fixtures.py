#!/usr/bin/env python3
"""Input-reading fixtures: small deep inputs and the bytes CorridorKey 2.0's own reader makes of them.

The engine's default reading must be byte-identical to CorridorKey 2.0's (corridorkey/video_io.py):
  video:  cv2.VideoCapture(path).read() -> 8-bit BGR -> cv2.cvtColor(BGR2RGB)        (then / 255)
  stills: cv2.imread(path, cv2.IMREAD_COLOR) -> 8-bit BGR -> cv2.cvtColor(BGR2RGB)   (then / 255)
so each reference is that uint8 RGB, written raw (frames x h x w x 3, C order) as <name>.cv2.rgb.
The test is decode.rs `default_reading_is_corridorkey_byte_identical`.

Inputs: a 12-bit ProRes 4444 clip (yuv444p12le when decoded, as the test plates) and a 10-bit ProRes 422 HQ clip
(yuv422p10le: the chroma upsampling path), both untagged; 16-bit PNGs (RGB, RGBA, gray) with full-range noise.

Run with a CorridorKey2.0 checkout's venv (cv2, numpy) and ffmpeg on PATH; the checkout is only imported:
  <CorridorKey2.0>/venv/bin/python engine-rs/tools/gen_input_fixtures.py <CorridorKey2.0> engine-rs/crates/ck-core/tests/fixtures/input
"""
import subprocess
import sys
from pathlib import Path

root, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
sys.path.insert(0, str(root))
out.mkdir(parents=True, exist_ok=True)

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from corridorkey import video_io as vio  # noqa: E402

rng = np.random.default_rng(2710)
H, W, N = 48, 64, 3


def deep_frames():
    """N frames of 16-bit RGB: smooth gradients, a hard edge and fine full-range noise (values an 8-bit read can't hold)."""
    y, x = np.mgrid[0:H, 0:W].astype(np.float64)
    frames = []
    # loop: NOT-WORTH — three fixture frames
    for t in range(N):
        base = np.stack([x / (W - 1), y / (H - 1), (x + y + 7 * t) % W / W], axis=-1) * 60000
        base[:, W // 2 + t:] = 65535 - base[:, W // 2 + t:]
        noise = rng.normal(0, 900, size=(H, W, 3))
        frames.append(np.clip(base + noise, 0, 65535).astype(np.uint16))
    return np.stack(frames)


def encode(name, profile, pix_fmt):
    path = out / name
    src = deep_frames()
    # loop: NOT-WORTH — one ffmpeg encode of a 64x48, 3-frame fixture [bounded: ffmpeg ends at the end of its input]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb48le", "-s", f"{W}x{H}", "-r", "24",
                    "-i", "pipe:0", "-c:v", "prores_ks", "-profile:v", profile, "-pix_fmt", pix_fmt, str(path)],
                   input=src.astype("<u2").tobytes(), check=True)
    return path


def cv2_video(path):
    """CorridorKey 2.0's video read (video_io.SequentialVideoWindowReader + preprocess_video_frame_views), before / 255."""
    cap = cv2.VideoCapture(str(path))
    frames = []
    # loop: NOT-WORTH — three fixture frames
    for _ in range(N):
        ret, frame = cap.read()
        assert ret, path
        frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    cap.release()
    return np.stack(frames)


# loop: NOT-WORTH — two clips
for name, profile, pix_fmt in [("prores4444_12bit.mov", "4444", "yuv444p10le"), ("prores422hq_10bit.mov", "3", "yuv422p10le")]:
    p = encode(name, profile, pix_fmt)
    np.ascontiguousarray(cv2_video(p)).tofile(out / f"{name}.cv2.rgb")

# 16-bit PNGs, read as video_io.read_image_rgb reads them (cv2.imread IMREAD_COLOR), checked against its float
deep = deep_frames()[0]
alpha = rng.integers(0, 65536, size=(H, W, 1), dtype=np.uint16)
pngs = {"rgb16.png": deep[:, :, ::-1], "rgba16.png": np.concatenate([deep[:, :, ::-1], alpha], axis=-1), "gray16.png": deep[:, :, 1]}
# loop: NOT-WORTH — three stills
for name, img in pngs.items():
    cv2.imwrite(str(out / name), np.ascontiguousarray(img))
    rgb = cv2.cvtColor(cv2.imread(str(out / name), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    assert np.array_equal(rgb.astype(np.float32) / 255.0, vio.read_image_rgb(out / name)), name
    np.ascontiguousarray(rgb).tofile(out / f"{name}.cv2.rgb")
print("input fixtures written to", out)
