"""CorridorKey v2 inference with a pluggable backend (PyTorch or ONNX Runtime).

Mirrors corridorkey/runtime.py (non-low-VRAM path) step by step:
  1. RVM continuous prepass (bilinear H/4 input, recurrent over the clip,
     normalized features stored as fp16 like the runtime memmap).
  2. Stage 1 on Hann windows (area-resized C-RADIO/MoGe inputs per window,
     carry-hint from the aux alpha, taper-weighted baton blend, fp16 baton).
  3. Stage 2 per frame at native padded resolution.
  4. Render: crop padding, alpha clamp, fg asinh -> linear -> sRGB.

Returns final alpha (T,h,w) and fg sRGB (T,3,h,w) as float32 numpy, plus
timings and non-finite counts of the raw stage outputs.
"""
import time

import numpy as np
import torch
import torch.nn.functional as F

from common import REPO  # noqa: F401  (sets sys.path)
from corridorkey import color_utils as cu
from corridorkey.video_io import (SequentialFrameDirWindowReader, probe_frame_dir_meta,
                                  taper_weights, window_starts)


def _sync(dev):
    if dev.startswith("cuda"):
        torch.cuda.synchronize()


class TorchBackend:
    """Upstream (unpatched) PyTorch modules. amp: None (fp32) or torch.bfloat16."""

    def __init__(self, model, device="cpu", amp=None):
        self.m, self.dev, self.amp = model, device, amp
        self.name = f"torch-{device}-{'fp32' if amp is None else str(amp).split('.')[-1]}"

    def _ac(self):
        if self.amp is None:
            return torch.autocast("cpu", enabled=False)
        return torch.autocast(self.dev.split(":")[0], dtype=self.amp)

    @torch.no_grad()
    def rvm(self, frames, state):  # frames (Tc,3,h4,w4) float
        f = self.m.foundations
        x = frames.to(self.dev).unsqueeze(0)
        st = None if state is None else state.to(self.dev)
        with self._ac():
            feats, st = f.rvm(x, state=st)
        mean = f.rvm_mean.view(1, 1, -1, 1, 1).float()
        std = f.rvm_std.view(1, 1, -1, 1, 1).float().clamp(min=1e-6)
        return ((feats.float() - mean) / std)[0].cpu(), st

    @torch.no_grad()
    def foundations(self, rgb_radio, rgb_moge):
        with self._ac():
            ff = self.m.foundations(rgb_cradio=rgb_radio.to(self.dev), rgb_moge=rgb_moge.to(self.dev))
        return ff["cradio"].float().cpu(), ff["moge"].float().cpu()

    @torch.no_grad()
    def stage1(self, rgb, hint, hq, moge, cradio, rvm):
        d = self.dev
        with self._ac():
            s1 = self.m.stage1(rgb.to(d), hint.to(d), moge.to(d), cradio_feat=cradio.to(d),
                               rvm_feat=rvm.to(d), t_stride=1.0, hint_quality=hq.to(d))
        return s1["baton"].float().cpu(), s1["aux"].float().cpu()

    @torch.no_grad()
    def stage2(self, rgb, baton):
        with self._ac():
            out = self.m.stage2(rgb.to(self.dev), baton.to(self.dev))
        if isinstance(out, tuple):
            out = out[0]
        return out.float().cpu()


class OrtBackend:
    def __init__(self, paths: dict, providers, name="ort", mem_reuse=True):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        # ORT's reuse planner keeps buffers far past their last use on these
        # dynamic-shape graphs (measured 4x the graph's live set on CPU).
        so.enable_mem_reuse = mem_reuse
        # providers: a list, or a function piece -> list (per-session options such as gpu_mem_limit)
        self.s = {k: ort.InferenceSession(str(v), so, providers=providers(k) if callable(providers) else providers)
                  for k, v in paths.items()}
        self.name = name
        self.in_dt = {k: {i.name: (np.float16 if i.type == "tensor(float16)" else np.float32)
                          for i in s.get_inputs()} for k, s in self.s.items()}

    def _run(self, k, feeds):
        dt = self.in_dt[k]
        outs = self.s[k].run(None, {n: np.asarray(v).astype(dt[n]) for n, v in feeds.items()})
        return [o.astype(np.float32) for o in outs]

    def rvm(self, frames, state):
        n_tok = 1 + (frames.shape[-2] // 16) * (frames.shape[-1] // 16)
        st = np.zeros((1, n_tok, 384), np.float32) if state is None else state
        outs = []
        for t in range(frames.shape[0]):
            feat, st = self._run("rvm", {"frame": frames[t:t + 1].numpy(), "state": st})
            outs.append(feat[0])
        return torch.from_numpy(np.stack(outs)), st

    def foundations(self, rgb_radio, rgb_moge):
        c = self._run("cradio", {"rgb": rgb_radio})[0]
        m = self._run("moge", {"rgb": rgb_moge})[0]
        return torch.from_numpy(c), torch.from_numpy(m)

    def stage1(self, rgb, hint, hq, moge, cradio, rvm):
        b, a = self._run("stage1", {"rgb": rgb, "hint": hint, "hint_quality": hq,
                                    "moge": moge, "cradio": cradio, "rvm": rvm})
        return torch.from_numpy(b), torch.from_numpy(a)

    def stage2(self, rgb, baton):
        return torch.from_numpy(self._run("stage2", {"rgb": rgb, "baton": baton})[0])


def _nonfinite(x):
    return int((~torch.isfinite(x)).sum().item())


def run_clip(backend, frame_dir, *, chunk=8, stride=4, num_frames=-1, quantum=128,
             carry_hint=True, carry_q=0.95, sync_dev="cpu", log=print):
    meta = probe_frame_dir_meta(str(frame_dir), num_frames=num_frames, shape_quantum=quantum,
                                fps=24.0, exr_linear=False, model_scale=1.0)
    T_all = meta["num_frames"]
    H, W = meta["shape_hw"]
    h, w = meta["model_native_hw"]
    pl, _, pt, _ = meta["pad"]
    tm = {"rvm": 0.0, "foundations": 0.0, "stage1": 0.0, "stage2": 0.0}
    nonfin = {"rvm": 0, "foundations": 0, "stage1": 0, "stage2": 0}

    # 1. RVM prepass (chunks of min(chunk, 8) like the runtime).
    reader = SequentialFrameDirWindowReader(str(frame_dir), meta)
    rvm_all = torch.empty(T_all, 384, H // 64, W // 64, dtype=torch.float16)
    state = None
    rc = max(1, min(chunk, 8))
    for t0 in range(0, T_all, rc):
        t1 = min(T_all, t0 + rc)
        _, disp, _ = reader.window(t0, t1)
        x = F.interpolate(disp.float(), size=(H // 4, W // 4), mode="bilinear",
                          align_corners=False).clamp(0, 1)
        _sync(sync_dev); t = time.perf_counter()
        feats, state = backend.rvm(x, state)
        _sync(sync_dev); tm["rvm"] += time.perf_counter() - t
        nonfin["rvm"] += _nonfinite(feats)
        rvm_all[t0:t1] = feats.to(torch.float16)

    # 2. Stage 1 Hann windows.
    starts = window_starts(T_all, chunk, stride)
    overlap = max(0, chunk - stride)
    reader = SequentialFrameDirWindowReader(str(frame_dir), meta)
    acc, wsum = {}, {}
    baton_all = torch.empty(T_all, 512, H // 16, W // 16, dtype=torch.float16)
    model_frames = {}
    carry = {}
    for i, t0 in enumerate(starts):
        t1 = min(t0 + chunk, T_all)
        Tc = t1 - t0
        model_chunk, disp, _ = reader.window(t0, t1)
        for j in range(Tc):
            model_frames[t0 + j] = model_chunk[j]
        hint = torch.zeros(1, Tc, 1, H, W, dtype=torch.bfloat16)
        hq = torch.zeros(1, Tc, dtype=torch.bfloat16)
        present = torch.zeros(1, Tc, dtype=torch.bool)
        for j, ta in enumerate(range(t0, t1)):
            if ta in carry:
                hint[0, j] = carry[ta]
                hq[0, j] = carry_q
                present[0, j] = True
        if not bool(present.any()):
            hq.fill_(-1.0)
        flat = disp.float()
        radio = F.interpolate(flat, size=(H // 4, W // 4), mode="area")
        moge_in = F.interpolate(flat, size=(H * 7 // 32, W * 7 // 32), mode="area")
        _sync(sync_dev); t = time.perf_counter()
        cradio_f, moge_f = backend.foundations(radio, moge_in)
        _sync(sync_dev); tm["foundations"] += time.perf_counter() - t
        nonfin["foundations"] += _nonfinite(cradio_f) + _nonfinite(moge_f)
        cradio_f = cradio_f.reshape(1, Tc, -1, H // 64, W // 64)
        moge_f = moge_f.reshape(1, Tc, -1, H // 64, W // 64)
        rvm_f = rvm_all[t0:t1].unsqueeze(0).float()
        _sync(sync_dev); t = time.perf_counter()
        baton, aux = backend.stage1(model_chunk.unsqueeze(0).float(), hint.float(), hq.float(),
                                    moge_f, cradio_f, rvm_f)
        _sync(sync_dev); tm["stage1"] += time.perf_counter() - t
        nonfin["stage1"] += _nonfinite(baton) + _nonfinite(aux)
        if carry_hint:
            a = F.interpolate(aux[0, :, 0:1], size=(H, W), mode="bilinear",
                              align_corners=False).clamp(0, 1).to(torch.bfloat16)
            for j, ta in enumerate(range(t0, t1)):
                carry[ta] = a[j].clone()
            nxt = starts[i + 1] if i + 1 < len(starts) else T_all
            for k in [k for k in carry if k < nxt]:
                del carry[k]
        wts = taper_weights(Tc, overlap, is_first=(i == 0), is_last=(i == len(starts) - 1))
        weighted = baton[0] * wts.view(Tc, 1, 1, 1)
        for j, ta in enumerate(range(t0, t1)):
            if ta not in acc:
                acc[ta], wsum[ta] = weighted[j].clone(), float(wts[j])
            else:
                acc[ta] += weighted[j]
                wsum[ta] += float(wts[j])
        nxt = starts[i + 1] if i + 1 < len(starts) else T_all
        for k in sorted(k for k in list(acc) if k < nxt):
            baton_all[k] = (acc.pop(k) / max(wsum.pop(k), 1e-6)).to(torch.float16)
        log(f"    [{backend.name}] window {i + 1}/{len(starts)} [{t0}:{t1}]")
    for k in sorted(acc):
        baton_all[k] = (acc[k] / max(wsum[k], 1e-6)).to(torch.float16)

    # 3. Stage 2 per frame + 4. render.
    alpha = np.empty((T_all, h, w), np.float32)
    fg = np.empty((T_all, 3, h, w), np.float32)
    raw_absmax = 0.0
    for ta in range(T_all):
        rgb = model_frames[ta].unsqueeze(0).unsqueeze(0).float()
        b = baton_all[ta].unsqueeze(0).unsqueeze(0).float()
        _sync(sync_dev); t = time.perf_counter()
        logits = backend.stage2(rgb, b)[0, 0]
        _sync(sync_dev); tm["stage2"] += time.perf_counter() - t
        nonfin["stage2"] += _nonfinite(logits)
        raw_absmax = max(raw_absmax, float(logits.nan_to_num(0).abs().max()))
        lg = logits[:, pt:pt + h, pl:pl + w]
        alpha[ta] = lg[0].clamp(0, 1).numpy()
        lin = cu.asinh_to_linear(lg[1:4]).clamp(min=0)
        fg[ta] = cu.linear_to_srgb(lin).clamp(0, 1).numpy()
    return {"alpha": alpha, "fg": fg, "time": tm, "nonfinite": nonfin,
            "stage2_raw_absmax": raw_absmax, "T": T_all, "shape_hw": (H, W), "native_hw": (h, w)}


def metrics(ref, test):
    a, b = ref["alpha"], test["alpha"]
    d = np.abs(a - b)
    out = {
        "alpha_mae": float(d.mean()),
        "alpha_max": float(d.max()),
        "alpha_sad_per_frame": float(d.sum() / a.shape[0]),
        "alpha_pct_gt_1_255": float((d > 1 / 255).mean() * 100),
        "alpha_pct_gt_4_255": float((d > 4 / 255).mean() * 100),
    }
    mse = float(((ref["fg"] - test["fg"]) ** 2).mean())
    out["fg_psnr_db"] = float("inf") if mse == 0 else float(10 * np.log10(1.0 / mse))
    # fg error only where the subject is (alpha > 0.5 in the reference).
    m = (a > 0.5)[:, None].repeat(3, axis=1)
    if m.any():
        mse_s = float(((ref["fg"] - test["fg"])[m] ** 2).mean())
        out["fg_psnr_subject_db"] = float("inf") if mse_s == 0 else float(10 * np.log10(1.0 / mse_s))
    return out
