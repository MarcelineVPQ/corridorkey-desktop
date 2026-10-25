#!/usr/bin/env python3
"""Temporal stability of one engine output (BACKLOG row 37: flicker and "sizzle" in the hair): how much the matte
changes from frame to frame where it shouldn't.

  python3 tools/temporal_stability.py OUTPUT_DIR --input CLIP [--frames N] [--json OUT.json] [--md OUT.md]
      [--csv OUT.csv] [--static-thresh 0.008] [--guard 4] [--flow-width 960]
  python3 tools/temporal_stability.py --self-test

OUTPUT_DIR: an engine output folder (<clip>_alpha.mp4|.mov or <clip>_alpha_exr/, optionally <clip>_fg...), read
exactly as tools/matte_compare.py reads it (EXR as float by OpenCV / OpenEXR, video as 16-bit RGB by ffmpeg).
CLIP: the input the engine keyed (a video, or a frame folder of EXR / PNG / TIFF / JPEG): it says where the plate
itself stands still and how the subject moves. Frames are streamed (three in memory); memory stays at a few frames.

What is measured, per frame t (t ≥ 1) and pooled over the clip (sum over all frames / pixel count):

1. Static regions. The plate's luma Y (Rec. 709 weights on the display-encoded frame: video as decoded, EXR through
   the sRGB curve of clip(max(x, 0)), as matte_compare does for the foreground) is box-blurred (5 px, against sensor
   noise); a pixel moves when |Y_t - Y_t-1| >= --static-thresh (default 0.008, about 2/255), and the moving mask is
   grown by --guard px (default 4) so the edges of moving things don't count as still. Everything else is static:
   the plate didn't change there, so a perfect matte doesn't either. Reported: mean |alpha_t - alpha_t-1| over the
   static pixels, and over the static pixels in the hair-edge band (alpha 0.02-0.98 in either frame, where flicker
   shows), with the % of those pixels changing by more than 1/255.
2. Moving regions, flow-compensated. DIS optical flow (OpenCV, preset MEDIUM, deterministic) on the plate's 8-bit
   luma, computed at --flow-width px wide (default 960; the flow is scaled back up): alpha_t-1 is warped to frame t
   along the backward flow (bilinear) and compared with alpha_t, over the moving pixels whose flow passes a
   forward-backward check (|f_b(x) + f_f(x + f_b(x))| < max(1, 0.1 |f_b|) px at the flow's scale) and lands inside
   the frame. Reported with the raw (unwarped) change of the same pixels, and the share of moving pixels kept.
   Limits: flow is measured on the plate, not on the matte. Green screen has little texture; hair over the screen
   is two motions in one pixel (flow follows one); motion blur, occlusions and fast motion break the flow; the
   check removes what it can see is wrong, not everything. The residual therefore holds flow error as well as
   flicker: an upper bound, meant to compare engines or windows on the SAME plate, never as an absolute number.
3. Sizzle: high-frequency temporal energy on edges. The second temporal difference
   |alpha_t - 2 alpha_t-1 + alpha_t-2| over pixels static in both steps and in the edge band at t-1. A steady drift
   or fade (alpha changing at a constant rate) gives 0; an alternating flicker of +-a gives 4a (and a static change
   of 2a), so sizzle separates shimmer from slow change.
4. With a foreground output: mean |fg_t - fg_t-1| (display-encoded, all channels) over static subject pixels
   (alpha > 0.5 in both frames).

Units: alpha 0-1 (x 255 for 8-bit levels). Self-test (--self-test): identical frames give exactly 0 everywhere; an
alternating flicker of a = 2^-7 gives exactly 2a static change and 4a sizzle; a fade gives 0 sizzle; a moving
textured subject gives a large raw change and a small flow-compensated one. Needs numpy, OpenCV, ffmpeg.
"""
import argparse
import csv
import glob
import json
import math
import os
import re
import sys
import tempfile

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
import cv2  # noqa: E402
import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import matte_compare as mc  # noqa: E402  (the same exact readers)

BAND_LO, BAND_HI = 0.02, 0.98
LUMA = np.array([0.2126, 0.7152, 0.0722])
IMAGE_EXT = (".exr", ".png", ".tif", ".tiff", ".jpg", ".jpeg")


def plate_frames(path, limit):
    """The input's frames as display-encoded float RGB (h, w, 3), 0-1."""
    if os.path.isdir(path):
        files = [f for f in glob.glob(os.path.join(glob.escape(path), "*")) if f.lower().endswith(IMAGE_EXT)]  # loop: NOT-WORTH — a few items (names, measures, tiny self-test frames), once
        # frame order by the trailing number of the name
        files.sort(key=lambda p: (int(m.group(1)) if (m := re.search(r"(\d+)\.\w+$", p)) else -1, p))
        if not files:
            raise SystemExit(f"{path}: no image frames")
        # loop: SERIAL-REQUIRED — one frame at a time, in order (a frame in memory) [bounded: the folder's files]
        for f in files[: limit or None]:
            img = cv2.imread(f, cv2.IMREAD_UNCHANGED)
            if img is None:
                raise SystemExit(f"{f}: OpenCV couldn't read it")
            if img.ndim == 2:
                img = np.repeat(img[..., None], 3, axis=2)
            img = img[..., :3][..., ::-1]  # BGR(A) -> RGB
            if img.dtype == np.uint8:
                yield img.astype(np.float64) / 255.0
            elif img.dtype == np.uint16:
                yield img.astype(np.float64) / 65535.0
            else:  # EXR: scene-linear float, display-encoded like matte_compare's foreground
                yield mc.linear_to_srgb(img.astype(np.float32)).astype(np.float64)
        return
    h, w = mc.probe_size(path)
    # loop: SERIAL-REQUIRED — frames stream in order from one ffmpeg (a few frames in memory)
    for f in mc.ffmpeg_frames(["-i", path], h, w, limit):
        yield f.astype(np.float64) / 65535.0


def luma(rgb, shape):
    y = rgb @ LUMA
    if y.shape != shape:
        y = cv2.resize(y, (shape[1], shape[0]), interpolation=cv2.INTER_AREA)
    return y


class Flow:
    """DIS optical flow on 8-bit luma at a reduced width, scaled back to full size."""

    def __init__(self, width):
        self.width = width
        self.dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)

    def backward(self, y_prev, y_cur):
        """(flow from frame t to t-1 at full size, mask of pixels whose flow passes the forward-backward check)."""
        h, w = y_cur.shape
        s = min(1.0, self.width / w)
        size = (max(8, round(w * s)), max(8, round(h * s)))
        p8 = (np.clip(cv2.resize(y_prev, size, interpolation=cv2.INTER_AREA), 0, 1) * 255 + 0.5).astype(np.uint8)
        c8 = (np.clip(cv2.resize(y_cur, size, interpolation=cv2.INTER_AREA), 0, 1) * 255 + 0.5).astype(np.uint8)
        fb = self.dis.calc(c8, p8, None)  # current -> previous
        ff = self.dis.calc(p8, c8, None)  # previous -> current
        hs, ws = fb.shape[:2]
        gx, gy = np.meshgrid(np.arange(ws, dtype=np.float32), np.arange(hs, dtype=np.float32))
        ffw = cv2.remap(ff, gx + fb[..., 0], gy + fb[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        err = np.hypot(fb[..., 0] + ffw[..., 0], fb[..., 1] + ffw[..., 1])
        ok = err < np.maximum(1.0, 0.1 * np.hypot(fb[..., 0], fb[..., 1]))
        flow = cv2.resize(fb, (w, h), interpolation=cv2.INTER_LINEAR) * np.array([w / ws, h / hs], dtype=np.float32)
        ok = cv2.resize(ok.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)
        return flow, ok


def warp(img, flow):
    h, w = img.shape
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    mx, my = gx + flow[..., 0], gy + flow[..., 1]
    inside = (mx >= 0) & (mx <= w - 1) & (my >= 0) & (my <= h - 1)
    return cv2.remap(img.astype(np.float32), mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float64), inside


def band(a):
    return (a > BAND_LO) & (a < BAND_HI)


class Acc:
    """Pooled sums of one measure: mean |d| and % of pixels over a threshold, plus the per-frame means."""

    def __init__(self, over=1 / 255):
        self.s = self.n = self.gt = 0.0
        self.over = over
        self.frames = []

    def add(self, d, t):
        n = int(d.size)
        m = float(d.mean()) if n else None
        if n:
            self.s += float(d.sum())
            self.gt += float((d > self.over).sum())
            self.n += n
        self.frames.append((t, m))
        return m, n

    def summary(self):
        vals = [v for _, v in self.frames if v is not None]  # loop: NOT-WORTH — a few items (names, measures, tiny self-test frames), once
        return {
            "mean": self.s / self.n if self.n else None,
            "pct_gt": 100.0 * self.gt / self.n if self.n else None,
            "over": self.over,
            "px_per_frame": self.n / max(1, len(self.frames)),
            "frame_median": float(np.median(vals)) if vals else None,
            "frame_p95": float(np.percentile(vals, 95)) if vals else None,
            "frame_max": max(vals) if vals else None,
            "worst_frame": max((v, t) for t, v in self.frames if v is not None)[1] if vals else None,  # loop: NOT-WORTH — the clip's per-frame means, once
        }


MEASURES = {
    "static": "static regions: mean abs(a_t - a_t-1)",
    "static_edge": "static regions, hair-edge band 0.02-0.98",
    "moving_raw": "moving regions (flow kept): raw abs(a_t - a_t-1)",
    "moving_flow": "moving regions: abs(a_t - warp(a_t-1)) (flow-compensated)",
    "moving_flow_edge": "moving regions, flow-compensated, edge band",
    "sizzle_edge": "sizzle: abs(a_t - 2a_t-1 + a_t-2), static edge band",
    "fg_static_subject": "fg: mean abs(fg_t - fg_t-1), static subject (alpha > 0.5)",
}


def analyse(alpha_iter, plate_iter, fg_iter=None, static_thresh=0.008, guard=4, flow_width=960, blur=5):
    acc = {k: Acc(2 / 255 if k == "sizzle_edge" else 1 / 255) for k in MEASURES}  # loop: NOT-WORTH — a few items (names, measures, tiny self-test frames), once
    kept = []
    rows = []
    flow = Flow(flow_width)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * guard + 1, 2 * guard + 1)) if guard > 0 else None
    prev = prev2 = None  # (alpha, luma, blurred luma, static mask, fg)
    n = 0
    fgs = fg_iter if fg_iter is not None else iter(())
    # loop: SERIAL-REQUIRED — frames stream in order; three frames in memory
    for t, (a, rgb) in enumerate(zip(alpha_iter, plate_iter)):
        a = a.astype(np.float64)
        f = next(fgs, None) if fg_iter is not None else None
        y = luma(rgb, a.shape)
        yb = cv2.blur(y, (blur, blur)) if blur > 1 else y
        n = t + 1
        if prev is None:
            prev = (a, y, yb, None, f)
            continue
        pa, py, pyb, pstatic, pf = prev
        moving = np.abs(yb - pyb) >= static_thresh
        if kernel is not None:
            moving = cv2.dilate(moving.astype(np.uint8), kernel).astype(bool)
        static = ~moving
        d1 = np.abs(a - pa)
        edge = band(a) | band(pa)
        row = {"frame": t}
        row["static"], row["static_px"] = acc["static"].add(d1[static], t)
        row["static_edge"], row["static_edge_px"] = acc["static_edge"].add(d1[static & edge], t)
        if moving.any():
            fl, ok = flow.backward(py, y)
            wa, inside = warp(pa, fl)
            keep = moving & ok & inside
            dw = np.abs(a - wa)
            row["moving_raw"], _ = acc["moving_raw"].add(d1[keep], t)
            row["moving_flow"], row["moving_flow_px"] = acc["moving_flow"].add(dw[keep], t)
            row["moving_flow_edge"], _ = acc["moving_flow_edge"].add(dw[keep & (band(a) | band(wa))], t)
            row["moving_kept_pct"] = 100.0 * keep.sum() / moving.sum()
            kept.append(row["moving_kept_pct"])
        else:
            # loop: NOT-WORTH — three measures
            for k in ("moving_raw", "moving_flow", "moving_flow_edge"):
                row[k], _ = acc[k].add(np.empty(0), t)
            row["moving_flow_px"] = 0
        if prev2 is not None and pstatic is not None:
            p2a = prev2[0]
            sm = static & pstatic & band(pa)
            row["sizzle_edge"], row["sizzle_px"] = acc["sizzle_edge"].add(np.abs(a - 2 * pa + p2a)[sm], t)
        if f is not None and pf is not None:
            subj = static & (a > 0.5) & (pa > 0.5)
            row["fg_static_subject"], _ = acc["fg_static_subject"].add(np.abs(f.astype(np.float64) - pf.astype(np.float64))[:, subj], t)
        rows.append(row)
        prev2 = prev
        prev = (a, y, yb, static, f)
    if n < 2:
        raise SystemExit("need at least two frames")
    out = {k: acc[k].summary() for k in MEASURES if acc[k].frames}  # loop: NOT-WORTH — a few items (names, measures, tiny self-test frames), once
    out["frames"] = n
    out["moving_kept_pct_mean"] = float(np.mean(kept)) if kept else None
    out["settings"] = {"static_thresh": static_thresh, "guard_px": guard, "flow_width": flow_width, "blur_px": blur,
                       "band": [BAND_LO, BAND_HI], "flow": "OpenCV DIS, preset MEDIUM, forward-backward checked"}
    return out, rows


def fmt(v, d=2):
    return "n/a" if v is None else (f"{v:.{d}e}" if abs(v) < 0.01 and v != 0 else f"{v:.{d + 2}f}")


def markdown(name, s):
    lines = [f"## Temporal stability: {name} ({s['frames']} frames)", "",
             "| measure | pooled mean | % > threshold | frame median | frame p95 | worst frame |", "|---|---|---|---|---|---|"]
    # loop: NOT-WORTH — the seven measures
    for k, label in MEASURES.items():
        m = s.get(k)
        if not m:
            continue
        thr = f"{m['pct_gt']:.3f} % > {round(m['over'] * 255)}/255" if m["pct_gt"] is not None else "n/a"
        lines.append(f"| {label} | {fmt(m['mean'])} | {thr} | {fmt(m['frame_median'])} | {fmt(m['frame_p95'])} | "
                     f"{m['worst_frame'] if m['worst_frame'] is not None else 'n/a'} |")
    if s.get("moving_kept_pct_mean") is not None:
        lines += ["", f"Moving pixels kept by the flow check: {s['moving_kept_pct_mean']:.1f} % on average."]
    st = s["settings"]
    lines += ["", f"Static: blurred luma change < {st['static_thresh']} (guard {st['guard_px']} px); flow: {st['flow']} at "
              f"{st['flow_width']} px wide. Flow-compensated numbers hold flow error too: compare on the same plate only."]
    return "\n".join(lines) + "\n"


def run(output_dir, plate, frames=0, **kw):
    src = mc.Source(output_dir, frames)
    mc.self_check(src)  # a broken decode can't pass as stable
    return analyse(src.alpha(), plate_frames(plate, frames), src.fg(), **kw)


# ---------------------------------------------------------------- self-test

def _texture(h, w, seed=1):
    rng = np.random.default_rng(seed)
    t = cv2.GaussianBlur(rng.random((h, w)), (0, 0), 2.0)
    t = (t - t.min()) / (t.max() - t.min())
    return np.repeat(t[..., None], 3, axis=2)


def self_test(work=None):
    h, w, T = 96, 128, 8
    fails = []

    def check(name, got, want, tol=0.0):
        ok = got is not None and abs(got - want) <= tol
        print(f"  {'ok ' if ok else 'FAIL'} {name}: {got!r} (want {want!r}{f' ± {tol}' if tol else ''})")
        if not ok:
            fails.append(name)

    plate = _texture(h, w)
    base = np.zeros((h, w), np.float32)
    base[:, 40:56] = 0.5  # an edge band
    base[:, 56:] = 1.0
    print("1. identical frames (in memory): every change exactly 0")
    s, _ = analyse(iter([base] * T), iter([plate] * T), iter([np.stack([plate[..., 0]] * 3)] * T))
    # loop: NOT-WORTH — four measures
    for k in ("static", "static_edge", "sizzle_edge", "fg_static_subject"):
        check(f"{k} mean", s[k]["mean"], 0.0)
    check("moving pixels", s["moving_flow"]["px_per_frame"], 0.0)

    print("2. identical frames written to disk (EXR alpha + fg, 16-bit PNG plate), read back: exactly 0")
    work = work or tempfile.mkdtemp(prefix="ck-stability-")
    out = os.path.join(work, "out")
    os.makedirs(os.path.join(out, "c_alpha_exr"), exist_ok=True)
    os.makedirs(os.path.join(out, "c_fg_exr"), exist_ok=True)
    os.makedirs(os.path.join(work, "plate"), exist_ok=True)
    # loop: NOT-WORTH — eight tiny frames
    for t in range(T):
        cv2.imwrite(os.path.join(out, "c_alpha_exr", f"c_alpha.{1001 + t}.exr"), base)
        cv2.imwrite(os.path.join(out, "c_fg_exr", f"c_fg.{1001 + t}.exr"), plate.astype(np.float32))
        cv2.imwrite(os.path.join(work, "plate", f"p.{1001 + t}.png"), (plate * 65535 + 0.5).astype(np.uint16))
    s, _ = run(out, os.path.join(work, "plate"))
    # loop: NOT-WORTH — four measures
    for k in ("static", "static_edge", "sizzle_edge", "fg_static_subject"):
        check(f"{k} mean (files)", s[k]["mean"], 0.0)

    print("3. alternating flicker of a = 2^-7 on a still plate: static edge change 2a, sizzle 4a, exactly")
    a = 2.0 ** -7
    flick = [base + np.where((base > 0) & (base < 1), (a if t % 2 else -a), 0).astype(np.float32) for t in range(T)]  # loop: NOT-WORTH — a few items (names, measures, tiny self-test frames), once
    s, _ = analyse(iter(flick), iter([plate] * T))
    check("static_edge mean", s["static_edge"]["mean"], 2 * a)
    check("sizzle_edge mean", s["sizzle_edge"]["mean"], 4 * a)
    check("static mean (band is 16 of 128 columns)", s["static"]["mean"], 2 * a * 16 / 128)

    print("4. a fade (alpha rising 2^-7 per frame in the band): sizzle exactly 0, static edge change 2^-7")
    fade = [base + np.where((base > 0) & (base < 1), t * a, 0).astype(np.float32) for t in range(T)]  # loop: NOT-WORTH — a few items (names, measures, tiny self-test frames), once
    s, _ = analyse(iter(fade), iter([plate] * T))
    check("sizzle_edge mean", s["sizzle_edge"]["mean"], 0.0)
    check("static_edge mean", s["static_edge"]["mean"], a)

    print("5. a textured subject moving 3 px right, 2 px down per frame: flow-compensated change << raw change")
    yy, xx = np.mgrid[0:h, 0:w]
    disc = (np.clip(20 - np.hypot(xx - 50, yy - 40), 0, 4) / 4).astype(np.float32)  # soft edge = band
    tex = _texture(h, w, seed=2)
    plates, alphas = [], []
    # loop: NOT-WORTH — eight tiny frames
    for t in range(T):
        sub = np.roll(np.roll(disc, 2 * t, axis=0), 3 * t, axis=1)
        p = plate * 0.3 + np.roll(np.roll(tex, 2 * t, axis=0), 3 * t, axis=1) * sub[..., None] * 0.7
        plates.append(p)
        alphas.append(sub)
    s, _ = analyse(iter(alphas), iter(plates), flow_width=w)
    raw, comp = s["moving_raw"]["mean"], s["moving_flow"]["mean"]
    print(f"  raw {raw:.4f}, flow-compensated {comp:.4f}, kept {s['moving_kept_pct_mean']:.1f} %")
    check("flow-compensated / raw below 0.25", (comp / raw) if raw else None, 0.0, 0.25)
    check("static mean (the plate outside the subject is still)", s["static"]["mean"], 0.0)

    if fails:
        print(f"self-test FAILED: {', '.join(fails)}")
        return 1
    print("self-test passed")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("output", nargs="?", help="the engine output folder")
    ap.add_argument("--input", help="the clip the engine keyed (video or frame folder)")
    ap.add_argument("--frames", type=int, default=0, help="only the first N frames")
    ap.add_argument("--static-thresh", type=float, default=0.008)
    ap.add_argument("--guard", type=int, default=4)
    ap.add_argument("--flow-width", type=int, default=960)
    ap.add_argument("--name", help="the name in the report (default: the output folder's name)")
    ap.add_argument("--json")
    ap.add_argument("--md")
    ap.add_argument("--csv", help="per-frame numbers")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--self-test-dir", help="where the self-test writes its tiny files (default: a temp folder)")
    a = ap.parse_args()
    if a.self_test:
        return self_test(a.self_test_dir)
    if not a.output or not a.input:
        ap.error("give OUTPUT_DIR and --input CLIP (or --self-test)")
    s, rows = run(a.output, a.input, a.frames, static_thresh=a.static_thresh, guard=a.guard, flow_width=a.flow_width)
    name = a.name or os.path.basename(os.path.normpath(a.output))
    s.update({"name": name, "output": a.output, "input": a.input})
    md = markdown(name, s)
    print("STABILITY " + json.dumps(s, allow_nan=False, default=lambda v: None if isinstance(v, float) and math.isnan(v) else v))
    print(md)
    if a.json:
        with open(a.json, "w") as f:
            json.dump(s, f, indent=2)
    if a.md:
        with open(a.md, "w") as f:
            f.write(md)
    if a.csv:
        keys = sorted({k for r in rows for k in r}, key=lambda k: (k != "frame", k))  # loop: NOT-WORTH — a few items (names, measures, tiny self-test frames), once
        with open(a.csv, "w", newline="") as f:
            wr = csv.DictWriter(f, fieldnames=keys)
            wr.writeheader()
            wr.writerows(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
