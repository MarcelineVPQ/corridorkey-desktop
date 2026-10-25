#!/usr/bin/env python3
"""Side-by-side comparisons you can look at: two engine output folders (any two engines or versions, video or
EXR), frame by frame, with the exact numbers next to the pictures (Marcy 2026-10-24: comparisons in tests should
produce results she can view, not only numbers).

  python3 tools/side_by_side.py REF TEST --out DIR [--labels "Original" "Ours"] [--frames 72 ...]
      [--crop NAME:X,Y,W,H ...] [--video] [--open] [--blind]

REF / TEST: an engine output folder (<clip>_alpha.mp4|.mov or <clip>_alpha_exr/, <clip>_fg.mp4|.mov or <clip>_fg_exr/).
Per frame: full-frame foreground and matte side by side (REF left), a difference image amplified 20x, and each
crop at 100 %. --video: the whole clip's foreground side by side (1920 px each) for scrubbing. numbers.md: alpha
and fg differences per frame (MAE, max, % over 1/255 and 4/255, the hair-edge band 0.02-0.98 separately).

Decoding is exact, never through an integer conversion of EXR (2026-10-24: ffmpeg's EXR-to-gray16 path bent the
linear values and produced a false finding): EXR is read as float by OpenCV; video is decoded by ffmpeg to 16-bit
RGB (alpha = first channel), as tools/matte_compare.py does. EXR foregrounds are scene-linear and are compared after
the video path's display encoding (clip(srgb(max(x, 0)), 0, 1)). Before anything is written, REF is compared with
itself: anything but zero stops the run (a broken decode can't pass as a result).
--blind (for a blind A/B, tools/vs_original.sh --blind): numbers.md leaves out the two folders' paths, so only the
labels (e.g. "A" / "B") name the sides; the caller keeps the key.
Needs numpy, OpenCV (with OPENCV_IO_ENABLE_OPENEXR, set here) and ffmpeg; alpha-only EXRs (channel A) also the
OpenEXR package (pip install OpenEXR), as OpenCV can't read them.
"""
import argparse
import glob
import os
import re
import subprocess
import sys

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
import cv2  # noqa: E402
import numpy as np  # noqa: E402


def linear_to_srgb(x):
    x = np.clip(np.maximum(x, 0.0), 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def find(folder, name):
    # loop: NOT-WORTH — three name patterns
    for pat in (f"*_{name}.mp4", f"*_{name}.mov", f"*_{name}_exr"):
        hits = sorted(glob.glob(os.path.join(glob.escape(folder), pat)))
        if hits:
            return hits[0]
    return None


def video_frame(path, n):
    """Frame n of a video as float RGB 0-1 (16-bit decode, as matte_compare.py)."""
    # loop: SERIAL-REQUIRED — one ffprobe of a local file per frame asked for [bounded: a local file]
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    # loop: NOT-WORTH — two numbers
    w, h = (int(v) for v in probe.stdout.strip().split(",")[:2])
    # loop: SERIAL-REQUIRED — one ffmpeg decode of one frame [bounded: a local file, one frame]
    raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-vf", f"select=eq(n\\,{n})", "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgb48le", "pipe:1"], capture_output=True, check=True).stdout
    if len(raw) != w * h * 6:
        raise SystemExit(f"{path}: frame {n} not found")
    return np.frombuffer(raw, np.uint16).reshape(h, w, 3).astype(np.float64) / 65535.0


def frame_key(path):
    """Frame order: the trailing number of the name (clip_alpha.0065.exr, alpha_000000.exr), compared as a number,
    so names with different zero padding still sort in frame order."""
    m = re.search(r"(\d+)\D*$", os.path.basename(path))
    return (int(m.group(1)) if m else -1, path)


def exr_frame(folder, n):
    # loop: NOT-WORTH — sorts one folder's names once per frame asked for
    files = sorted(glob.glob(os.path.join(glob.escape(folder), "*.exr")), key=frame_key)
    if n >= len(files):
        raise SystemExit(f"{folder}: frame {n} not found ({len(files)} frames)")
    img = cv2.imread(files[n], cv2.IMREAD_UNCHANGED)
    if img is None:
        img = exr_matte(files[n])
    img = img.astype(np.float64)
    return img if img.ndim == 3 else img[..., None]


def exr_matte(path):
    """A matte stored alone as channel A (the studio convention, our alpha EXR since backlog row 30 b): OpenCV 4.11
    returns nothing for it (measured), so it is read with OpenEXR's own Python package (pip install OpenEXR)."""
    try:
        import OpenEXR
    except ImportError:
        raise SystemExit(f"{path}: OpenCV couldn't read it; an alpha-only (channel A) EXR needs `pip install OpenEXR`")
    with OpenEXR.File(path) as f:
        ch = f.channels()
        if list(ch) != ["A"]:
            raise SystemExit(f"{path}: OpenCV couldn't read it (channels {list(ch)})")
        return np.asarray(ch["A"].pixels, dtype=np.float32)


class Out:
    def __init__(self, folder):
        self.alpha_p, self.fg_p = find(folder, "alpha"), find(folder, "fg")
        if not self.alpha_p and not self.fg_p:
            raise SystemExit(f"{folder}: no *_alpha / *_fg output")

    def alpha(self, n):
        if not self.alpha_p:
            return None
        if os.path.isdir(self.alpha_p):
            return exr_frame(self.alpha_p, n)[..., 0]
        return video_frame(self.alpha_p, n)[..., 0]

    def fg(self, n):
        if not self.fg_p:
            return None
        if os.path.isdir(self.fg_p):
            bgr = exr_frame(self.fg_p, n)
            return linear_to_srgb(bgr[..., ::-1])  # OpenCV reads BGR; display-encode like the video path
        return video_frame(self.fg_p, n)


def stats(a, b, band=None):
    d = np.abs(a - b)
    if band is not None:
        d = d[band]
    if d.size == 0:
        return "n/a"
    return f"MAE {d.mean():.2e} · max {d.max():.4f} · >1/255 {100 * (d > 1 / 255).mean():.2f} % · >4/255 {100 * (d > 4 / 255).mean():.2f} %"


def to8(x):
    return (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)


def label(img, text):
    img = img.copy()
    cv2.rectangle(img, (0, 0), (min(img.shape[1], 16 * len(text) + 24), 46), (0, 0, 0), -1)
    cv2.putText(img, text, (10, 33), cv2.FONT_HERSHEY_SIMPLEX, 0.95, (255, 255, 255), 2, cv2.LINE_AA)
    return img


def pair(a, b, la, lb):
    """Two frames side by side (8-bit BGR for writing), REF left."""
    def bgr(x):
        x = to8(x)
        return cv2.cvtColor(x, cv2.COLOR_GRAY2BGR) if x.ndim == 2 else x[..., ::-1].copy()
    return np.hstack([label(bgr(a), la), label(bgr(b), lb)])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ref")
    ap.add_argument("test")
    ap.add_argument("--out", required=True)
    ap.add_argument("--labels", nargs=2, default=["Reference", "Test"])
    ap.add_argument("--frames", nargs="+", type=int, default=[0])
    ap.add_argument("--crop", action="append", default=[], help="NAME:X,Y,W,H in output pixels")
    ap.add_argument("--video", action="store_true", help="also a side-by-side video of the foreground")
    ap.add_argument("--open", action="store_true", help="open the result folder in the file manager")
    ap.add_argument("--blind", action="store_true", help="numbers.md without the folders' paths (a blind A/B)")
    a = ap.parse_args()
    ref, test = Out(a.ref), Out(a.test)
    os.makedirs(a.out, exist_ok=True)
    la, lb = a.labels
    crops = []
    # loop: NOT-WORTH — a few crops from the command line
    for c in a.crop:
        name, box = c.split(":", 1)
        # loop: NOT-WORTH — four numbers of one --crop
        x, y, w, h = (int(v) for v in box.split(","))
        crops.append((name, x, y, w, h))

    # sanity: the reference against itself must be exactly zero (a broken decode stops here)
    f0 = a.frames[0]
    # loop: NOT-WORTH — alpha and fg
    for kind in ("alpha", "fg"):
        x = getattr(ref, kind)(f0)
        if x is not None and np.abs(x - getattr(ref, kind)(f0)).max() != 0:
            raise SystemExit(f"self-check failed: {kind} of REF differs from itself")

    where = ["- sources: hidden (blind test)"] if a.blind else [f"- reference: `{a.ref}`", f"- test: `{a.test}`"]
    lines = [f"# {la} vs {lb}", "", *where, "- decode: EXR as float (OpenCV), video 16-bit (ffmpeg); self-check passed", ""]
    # loop: NOT-WORTH — the frames asked for (a few), each a few image writes
    for n in a.frames:
        lines.append(f"## Frame {n}")
        # loop: NOT-WORTH — alpha and fg
        for kind in ("alpha", "fg"):
            x, y = getattr(ref, kind)(n), getattr(test, kind)(n)
            if x is None or y is None:
                continue
            if x.shape != y.shape:
                raise SystemExit(f"frame {n} {kind}: sizes differ {x.shape} vs {y.shape}")
            band = ((x > 0.02) & (x < 0.98)) if kind == "alpha" else None
            lines.append(f"- {kind}: {stats(x, y)}")
            if band is not None:
                lines.append(f"- {kind}, semi-transparent edges (0.02-0.98, {int(band.sum())} px): {stats(x, y, band)}")
            cv2.imwrite(os.path.join(a.out, f"f{n:05d}_{kind}_side_by_side.png"), pair(x, y, la, lb))
            diff = np.abs(x - y)
            diff = diff.max(axis=2) if diff.ndim == 3 else diff
            cv2.imwrite(os.path.join(a.out, f"f{n:05d}_{kind}_difference_x20.png"), to8(diff * 20))
            # loop: NOT-WORTH — the crops asked for
            for name, cx, cy, cw, ch in crops:
                cv2.imwrite(os.path.join(a.out, f"f{n:05d}_{kind}_crop_{name}.png"), pair(x[cy : cy + ch, cx : cx + cw], y[cy : cy + ch, cx : cx + cw], la, lb))
        lines.append("")
    with open(os.path.join(a.out, "numbers.md"), "w") as fh:
        fh.write("\n".join(lines) + "\n")

    if a.video and ref.fg_p and test.fg_p and not os.path.isdir(ref.fg_p) and not os.path.isdir(test.fg_p):
        font = "drawtext=text='{t}':x=16:y=16:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.6"
        # loop: SERIAL-REQUIRED — one ffmpeg encode of the whole clip, asked for with --video [bounded: the clip's length; local files]
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", ref.fg_p, "-i", test.fg_p, "-filter_complex",
             f"[0]scale=1920:-2,{font.format(t=la)}[a];[1]scale=1920:-2,{font.format(t=lb)}[b];[a][b]hstack",
             "-c:v", "libx264", "-crf", "14", "-preset", "medium", "-pix_fmt", "yuv420p", os.path.join(a.out, "side_by_side_fg.mp4")],
            check=True,
        )
    print("\n".join(lines))
    if a.open:
        # loop: NOT-WORTH — starts the file manager and doesn't wait for it
        subprocess.Popen(["xdg-open", a.out], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    sys.exit(main())
