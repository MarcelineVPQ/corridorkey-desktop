"""Procedural green-screen test clip (synthetic, reproducible, no rights issues).

A person-like subject in front of an unevenly lit, wrinkled green backdrop:
head + dark hair mass with a few hundred thin semi-transparent strands that
sway, a patterned shirt, a waving arm with motion blur (sub-frame
accumulation), a translucent blue scarf, green spill on edges, sensor noise.
Composited in linear light, written as 8-bit sRGB PNGs plus the ground-truth
alpha (16-bit PNG).

usage: python make_clip.py OUT_DIR WIDTH HEIGHT FRAMES [seed]
"""
import math
import sys
from pathlib import Path

import cv2
import numpy as np


def srgb_to_lin(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def smooth_noise(rng, h, w, scale):
    small = rng.standard_normal((max(2, h // scale), max(2, w // scale))).astype(np.float32)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)


def render(out, W, H, T, seed=0):
    out = Path(out)
    (out / "rgb").mkdir(parents=True, exist_ok=True)
    (out / "alpha").mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    S = 2  # supersampling for coverage
    Ws, Hs = W * S, H * S
    u = lambda v: int(round(v * Hs))  # units relative to height

    # Static backdrop (linear light).
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    light = 0.75 + 0.35 * (1 - yy / H) - 0.25 * ((xx / W - 0.4) ** 2)
    wrinkle = 0.06 * smooth_noise(rng, H, W, 40) + 0.03 * smooth_noise(rng, H, W, 9)
    green = srgb_to_lin(np.array([0.22, 0.68, 0.28], np.float32))
    bg = (light + wrinkle)[..., None] * green[None, None, :]

    # Hair strands: fixed roots around the head top, random lengths/curls.
    n_strands = 260
    roots = rng.uniform(-1, 1, n_strands)
    lens = rng.uniform(0.05, 0.16, n_strands)
    curls = rng.uniform(-0.6, 0.6, n_strands)
    s_alpha = rng.uniform(0.25, 0.9, n_strands)
    shirt_tex = (smooth_noise(rng, Hs, Ws, 24) > 0).astype(np.float32)

    # loop: SERIAL-REQUIRED — one synthetic frame at a time (each written before the next is drawn; a test-clip generator)
    for t in range(T):
        ph = 2 * math.pi * t / max(T, 1)
        cx = 0.5 * Ws + 0.04 * Ws * math.sin(ph)           # subject drifts
        head_c = (cx, 0.36 * Hs + 0.01 * Hs * math.sin(2 * ph))
        # loop: NOT-WORTH — four coverage layers per frame
        cov = {k: np.zeros((Hs, Ws), np.float32) for k in ("body", "skin", "hair", "scarf")}

        # Body / shirt.
        cv2.ellipse(cov["body"], (int(cx), u(1.0)), (u(0.24), u(0.42)), 0, 0, 360, 1, -1, cv2.LINE_AA)
        # Neck + head.
        cv2.rectangle(cov["skin"], (int(cx - u(0.035)), u(0.42)), (int(cx + u(0.035)), u(0.6)), 1, -1)
        cv2.ellipse(cov["skin"], (int(head_c[0]), int(head_c[1])), (u(0.085), u(0.115)), 0, 0, 360, 1, -1, cv2.LINE_AA)
        # Hair mass.
        cv2.ellipse(cov["hair"], (int(head_c[0]), int(head_c[1] - u(0.03))), (u(0.095), u(0.1)), 0, 180, 360, 1, -1, cv2.LINE_AA)
        # Strands (drawn into their own buffer with per-strand opacity).
        strands = np.zeros((Hs, Ws), np.float32)
        sway = 0.04 * math.sin(ph + 0.5)
        # loop: NOT-WORTH — 260 strands per frame, each one cv2 polyline (a test-clip generator, run once)
        for i in range(n_strands):
            a0 = math.pi * (1.0 + 0.5 * (roots[i] + 1))  # top half arc
            x0 = head_c[0] + math.cos(a0) * u(0.095)
            y0 = head_c[1] - u(0.03) + math.sin(a0) * u(0.1)
            pts = []
            # loop: NOT-WORTH — 12 points per strand
            for k in range(12):
                f = k / 11
                dx = (math.cos(a0) * 0.6 + curls[i] * math.sin(3 * f + i) + sway * f * 3) * lens[i] * f
                dy = (math.sin(a0) * 0.4 + 1.2 * f) * lens[i] * f
                pts.append((x0 + dx * Hs, y0 + dy * Hs))
            pts = np.array(pts, np.int32).reshape(-1, 1, 2)
            layer = np.zeros_like(strands)
            cv2.polylines(layer, [pts], False, 1.0, 1, cv2.LINE_AA)
            strands = 1 - (1 - strands) * (1 - s_alpha[i] * layer)
        cov["hair"] = 1 - (1 - cov["hair"]) * (1 - strands)
        # Waving arm with motion blur: accumulate 8 sub-frames.
        arm = np.zeros((Hs, Ws), np.float32)
        # loop: NOT-WORTH — eight motion-blur sub-frames per frame
        for sub in range(8):
            ang = 0.9 * math.sin(ph * 2 + sub * 0.06) - 0.4
            sx, sy = cx + u(0.2), u(0.68)
            ex = sx + math.cos(ang) * u(0.3)
            ey = sy - math.sin(ang) * u(0.3)
            layer = np.zeros_like(arm)
            cv2.line(layer, (int(sx), int(sy)), (int(ex), int(ey)), 1.0, u(0.05), cv2.LINE_AA)
            cv2.circle(layer, (int(ex), int(ey)), u(0.035), 1.0, -1, cv2.LINE_AA)
            arm += layer / 8
        cov["skin"] = np.maximum(cov["skin"], arm)
        # Translucent scarf.
        sc = np.zeros((Hs, Ws), np.float32)
        poly = np.array([(cx - u(0.12), u(0.56)), (cx + u(0.12), u(0.56)),
                         (cx + u(0.06 + 0.02 * math.sin(ph)), u(0.85)), (cx - u(0.16), u(0.8))], np.int32)
        cv2.fillPoly(sc, [poly], 1.0, cv2.LINE_AA)
        cov["scarf"] = sc * 0.45

        # Down-sample coverage to output res (box filter = area coverage).
        # loop: NOT-WORTH — four layers resized per frame
        cov = {k: cv2.resize(v, (W, H), interpolation=cv2.INTER_AREA) for k, v in cov.items()}
        tex = cv2.resize(shirt_tex, (W, H), interpolation=cv2.INTER_AREA)

        cols = {
            "body": srgb_to_lin(np.array([0.55, 0.12, 0.10], np.float32)),
            "skin": srgb_to_lin(np.array([0.85, 0.62, 0.50], np.float32)),
            "hair": srgb_to_lin(np.array([0.18, 0.11, 0.06], np.float32)),
            "scarf": srgb_to_lin(np.array([0.25, 0.35, 0.9], np.float32)),
        }
        # Layer order back→front: body, skin(neck/head/arm), hair, scarf.
        fg = np.zeros((H, W, 3), np.float32)
        a = np.zeros((H, W), np.float32)
        # loop: NOT-WORTH — four layers composited per frame
        for k in ("body", "skin", "hair", "scarf"):
            c = np.broadcast_to(cols[k], (H, W, 3)).copy()
            if k == "body":
                c = c * (0.7 + 0.3 * tex[..., None])
            ak = cov[k]
            fg = c * ak[..., None] + fg * (1 - ak[..., None])
            a = ak + a * (1 - ak)
        fg_pm = fg  # premultiplied-by-construction over black
        # Green spill near edges: edge = a*(1-a) region + 6-px band.
        edge = cv2.GaussianBlur((a > 0.02).astype(np.float32) - (a > 0.98).astype(np.float32), (0, 0), 3)
        spill = np.clip(edge, 0, 1)[..., None] * 0.15 * green[None, None, :]
        comp = fg_pm + (1 - a[..., None]) * bg + spill * a[..., None]
        comp = comp * (1 + 0.02 * math.sin(ph * 3))  # slight exposure flicker
        img = lin_to_srgb(comp) + rng.normal(0, 0.008, comp.shape).astype(np.float32)
        img8 = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)
        cv2.imwrite(str(out / "rgb" / f"{t:05d}.png"), cv2.cvtColor(img8, cv2.COLOR_RGB2BGR))
        cv2.imwrite(str(out / "alpha" / f"{t:05d}.png"), (a * 65535 + 0.5).astype(np.uint16))
    print(f"wrote {T} frames {W}x{H} to {out}")


if __name__ == "__main__":
    render(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]),
           int(sys.argv[5]) if len(sys.argv) > 5 else 0)
