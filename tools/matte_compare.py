#!/usr/bin/env python3
"""Compare two engines' mattes (alpha) and foregrounds (fg), frame by frame.

  python3 tools/matte_compare.py REF TEST [--json OUT.json] [--md OUT.md] [--frames N]
  python3 tools/matte_compare.py --roots REF_ROOT TEST_ROOT [--json ...] [--md ...]

REF / TEST: an engine output folder (<clip>_alpha.mp4 / <clip>_alpha_exr, <clip>_fg.mp4 / <clip>_fg_exr), or
the ONNX spike's .npz (alpha (T,h,w), fg (T,3,h,w) in sRGB). --roots compares every clip folder present in
both roots (the engine bench's out/<clip>/).

Videos are decoded by ffmpeg to 16-bit RGB (alpha = its first channel). EXR sequences are decoded by ffmpeg
as float; EXR fg is scene-linear and is compared after the video path's display encoding
(clip(srgb(max(x, 0)), 0, 1)), so EXR and video outputs land on the same scale. Needs numpy and ffmpeg only.

Per clip: alpha MAE, max |diff|, SAD per frame, % of pixels off by more than 1/255 and 4/255, alpha PSNR;
fg PSNR over all pixels and over the subject (reference alpha > 0.5); the worst frame by alpha MAE.
Frames are streamed: memory stays at a few frames whatever the clip length.
"""
import argparse
import glob
import json
import math
import os
import subprocess
import sys

import numpy as np


def linear_to_srgb(x):
    x = np.maximum(x, 0.0).astype(np.float32)
    lo = x * 12.92
    hi = 1.055 * np.power(np.maximum(x, 0.0031308), 1.0 / 2.4) - 0.055
    return np.clip(np.where(x <= 0.0031308, lo, hi), 0.0, 1.0)


def probe_size(path):
    # loop: SERIAL-REQUIRED — one ffprobe per compared file [bounded: a local file; the caller runs under timeout]
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
                       capture_output=True, text=True, check=True)
    w, h = r.stdout.strip().split("\n")[0].split(",")[:2]
    return int(h), int(w)


def ffmpeg_frames(args, h, w, channels, dtype, limit):
    """Raw frames from an ffmpeg command line (input args), as (h, w, channels) arrays."""
    pix = {(1, np.float32): "grayf32le", (3, np.float32): "gbrpf32le", (3, np.uint16): "rgb48le"}[(channels, dtype)]
    cmd = ["ffmpeg", "-v", "error", "-nostdin", *args, "-map", "0:v:0", "-fps_mode", "passthrough"]
    if limit:
        cmd += ["-frames:v", str(limit)]
    cmd += ["-f", "rawvideo", "-pix_fmt", pix, "pipe:1"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = h * w * channels * np.dtype(dtype).itemsize
    try:
        # loop: SERIAL-REQUIRED — frames arrive in order from one pipe
        while True:
            buf = p.stdout.read(n)
            if len(buf) < n:
                break
            a = np.frombuffer(buf, dtype=dtype)
            if pix == "gbrpf32le":  # planar G, B, R
                g, b, r = a.reshape(3, h, w)
                yield np.stack([r, g, b], axis=-1)
            else:
                yield a.reshape(h, w, channels)
    finally:
        p.kill()
        # loop: SERIAL-REQUIRED — reaps ffmpeg after its frames were read [bounded: its pipe was read to the end]
        p.wait()


def video_alpha(path, limit):
    h, w = probe_size(path)
    # loop: SERIAL-REQUIRED — frames stream in order from one ffmpeg (a few frames in memory)
    for f in ffmpeg_frames(["-i", path], h, w, 3, np.uint16, limit):
        yield f[:, :, 0].astype(np.float32) / 65535.0


def video_fg(path, limit):
    h, w = probe_size(path)
    # loop: SERIAL-REQUIRED — frames stream in order from one ffmpeg
    for f in ffmpeg_frames(["-i", path], h, w, 3, np.uint16, limit):
        yield f.astype(np.float32).transpose(2, 0, 1) / 65535.0


def exr_seq(folder, channels, limit):
    files = sorted(glob.glob(os.path.join(folder, "*.exr")))
    if not files:
        raise SystemExit(f"no EXR frames in {folder}")
    h, w = probe_size(files[0])
    args = ["-pattern_type", "glob", "-i", os.path.join(glob.escape(folder), "*.exr")]
    # loop: SERIAL-REQUIRED — frames stream in order from one ffmpeg
    for f in ffmpeg_frames(args, h, w, channels, np.float32, limit):
        yield f


def exr_alpha(folder, limit):
    # loop: SERIAL-REQUIRED — EXR frames in order
    for f in exr_seq(folder, 1, limit):
        yield np.clip(f[:, :, 0], 0.0, 1.0)


def exr_fg(folder, limit):
    # loop: SERIAL-REQUIRED — EXR frames in order
    for f in exr_seq(folder, 3, limit):
        yield linear_to_srgb(f).transpose(2, 0, 1)


class Source:
    """One side of a comparison: alpha and (optionally) fg frame iterators."""

    def __init__(self, path, limit=0):
        self.path, self.limit = path, limit
        if path.endswith(".npz"):
            z = np.load(path)
            self.kind = "npz"
            self._alpha = z["alpha"].astype(np.float32)
            self._fg = z["fg"].astype(np.float32) if "fg" in z else None
            return
        self.kind = "folder"
        self.a = self._find(path, "alpha")
        self.f = self._find(path, "fg")
        if self.a is None:
            raise SystemExit(f"{path}: no *_alpha.mp4/.mov or *_alpha_exr")

    @staticmethod
    def _find(folder, name):
        # loop: NOT-WORTH — three name patterns
        for pat in (f"*_{name}.mp4", f"*_{name}.mov", f"*_{name}_exr"):
            hits = sorted(glob.glob(os.path.join(glob.escape(folder), pat)))
            if hits:
                return hits[0]
        return None

    def alpha(self):
        if self.kind == "npz":
            return iter(self._alpha[: self.limit or None])
        return exr_alpha(self.a, self.limit) if os.path.isdir(self.a) else video_alpha(self.a, self.limit)

    def fg(self):
        if self.kind == "npz":
            return iter(self._fg[: self.limit or None]) if self._fg is not None else None
        if self.f is None:
            return None
        return exr_fg(self.f, self.limit) if os.path.isdir(self.f) else video_fg(self.f, self.limit)


def psnr(mse):
    return float("inf") if mse == 0 else 10.0 * math.log10(1.0 / mse)


def compare(ref, test):
    n = 0
    s_abs = s_gt1 = s_gt4 = s_sq = 0.0
    px = 0
    worst = 0.0
    worst_frame = (None, -1.0)
    ref_alpha = []
    # loop: SERIAL-REQUIRED — streamed frame pairs
    for a, b in zip(ref.alpha(), test.alpha()):
        if a.shape != b.shape:
            raise SystemExit(f"frame size differs: {a.shape} vs {b.shape}")
        d = np.abs(a.astype(np.float64) - b.astype(np.float64))
        s_abs += d.sum()
        s_sq += (d * d).sum()
        s_gt1 += (d > 1 / 255).sum()
        s_gt4 += (d > 4 / 255).sum()
        worst = max(worst, float(d.max()))
        mae = float(d.mean())
        if mae > worst_frame[1]:
            worst_frame = (n, mae)
        px += d.size
        ref_alpha.append(a > 0.5)
        n += 1
    if n == 0:
        raise SystemExit("no frames to compare")
    out = {
        "frames": n,
        "alpha_mae": s_abs / px,
        "alpha_max": worst,
        "alpha_sad_per_frame": s_abs / n,
        "alpha_pct_gt_1_255": 100.0 * s_gt1 / px,
        "alpha_pct_gt_4_255": 100.0 * s_gt4 / px,
        "alpha_psnr_db": psnr(s_sq / px),
        "worst_frame": worst_frame[0],
        "worst_frame_alpha_mae": worst_frame[1],
    }
    rf, tf = ref.fg(), test.fg()
    # the spike's .npz keeps fg as float16: round the other side the same way, or its storage dominates
    f16 = ref.kind == "npz" or test.kind == "npz"
    if f16:
        out["fg_rounded_to_f16"] = True
    if rf is not None and tf is not None:
        sq = sq_s = 0.0
        cnt = cnt_s = 0
        # loop: SERIAL-REQUIRED — streamed frame pairs
        for i, (a, b) in enumerate(zip(rf, tf)):
            if f16:
                a, b = a.astype(np.float16), b.astype(np.float16)
            d2 = (a.astype(np.float64) - b.astype(np.float64)) ** 2
            sq += d2.sum()
            cnt += d2.size
            m = np.broadcast_to(ref_alpha[i][None], d2.shape) if i < len(ref_alpha) else None
            if m is not None and m.any():
                sq_s += d2[m].sum()
                cnt_s += int(m.sum())
        out["fg_psnr_db"] = psnr(sq / cnt) if cnt else None
        out["fg_psnr_subject_db"] = psnr(sq_s / cnt_s) if cnt_s else None
    return out


def table(rows):
    head = "| clip | frames | alpha MAE | alpha max | SAD/frame | % > 1/255 | % > 4/255 | alpha PSNR | fg PSNR (all / subject) |"
    lines = [head, "|" + "---|" * 9]
    # loop: NOT-WORTH — the compared clips, once per report
    for name, m in rows:
        fg = f"{m.get('fg_psnr_db', float('nan')):.1f} / {m.get('fg_psnr_subject_db') or float('nan'):.1f} dB" if m.get("fg_psnr_db") is not None else "n/a"
        lines.append(f"| {name} | {m['frames']} | {m['alpha_mae']:.2e} | {m['alpha_max']:.2e} | {m['alpha_sad_per_frame']:.1f} | "
                     f"{m['alpha_pct_gt_1_255']:.3f} | {m['alpha_pct_gt_4_255']:.3f} | {m['alpha_psnr_db']:.1f} dB | {fg} |")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ref", nargs="?")
    ap.add_argument("test", nargs="?")
    ap.add_argument("--roots", nargs=2, metavar=("REF_ROOT", "TEST_ROOT"))
    ap.add_argument("--frames", type=int, default=0, help="compare only the first N frames")
    ap.add_argument("--json")
    ap.add_argument("--md")
    a = ap.parse_args()
    pairs = []
    if a.roots:
        r_root, t_root = a.roots
        # loop: NOT-WORTH — a handful of clip folders
        for name in sorted(os.listdir(r_root)):
            if os.path.isdir(os.path.join(r_root, name)) and os.path.isdir(os.path.join(t_root, name)):
                pairs.append((name, os.path.join(r_root, name), os.path.join(t_root, name)))
    elif a.ref and a.test:
        pairs.append((os.path.basename(os.path.normpath(a.test)), a.ref, a.test))
    else:
        ap.error("give REF TEST or --roots REF_ROOT TEST_ROOT")
    rows = []
    # loop: SERIAL-REQUIRED — one clip at a time keeps memory to a few frames
    for name, r, t in pairs:
        m = compare(Source(r, a.frames), Source(t, a.frames))
        m.update({"clip": name, "ref": r, "test": t})
        rows.append((name, m))
        print("COMPARE " + json.dumps(m), flush=True)
    md = table(rows)
    print(md)
    if a.json:
        with open(a.json, "w") as f:
            # loop: NOT-WORTH — the compared clips, once per report
            json.dump([m for _, m in rows], f, indent=2)
    if a.md:
        with open(a.md, "w") as f:
            f.write(md)


if __name__ == "__main__":
    sys.exit(main())
