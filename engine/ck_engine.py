#!/usr/bin/env python3
"""CorridorKey desktop engine: JSON lines over stdio (desktop/docs/ENGINE_PROTOCOL.md).

Same pattern as Sonata's alignment helper: stdout carries ONLY protocol replies;
logs, tracebacks and library warnings go to stderr. The model's own prints are
turned into `log` replies (and read for stage progress).

It runs the upstream runtime unchanged (corridorkey/runtime.py). Progress comes
from wrapping the runtime's own functions and writers in its module namespace,
so nothing here re-implements inference and an upstream update needs no merge.

Run with the CorridorKey checkout's own venv:
  <CorridorKey2.0>/venv/bin/python engine/ck_engine.py --package-root <CorridorKey2.0>
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import sys
import threading
import time
import traceback
from pathlib import Path

# stdout is the protocol channel: keep a private handle; everything else that
# prints goes through ModelLog (protocol `log` replies + a copy on stderr).
_proto = sys.stdout
_lock = threading.Lock()

ENGINE_VERSION = "0.1.0"
PROTOCOL = 1
FRAMES_EVERY_S = 0.25  # at most 4 `frames` replies per second


def send(msg: dict) -> None:
    with _lock:
        _proto.write(json.dumps(msg, ensure_ascii=False) + "\n")
        _proto.flush()


WINDOW_RE = re.compile(r"window (\d+)/(\d+)")


class ModelLog:
    """sys.stdout while the engine runs: each printed line becomes a `log` reply."""

    def __init__(self):
        self.job: str | None = None
        self._buf = ""

    def write(self, text: str) -> int:
        self._buf += text
        # loop: HOT-PATH-OK — one pass per printed line; the model prints a few lines per window
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self._line(line)
        return len(text)

    def flush(self) -> None:
        sys.stderr.flush()

    def _line(self, line: str) -> None:
        sys.stderr.write(line + "\n")
        if not line.strip():
            return
        msg = {"type": "log", "text": line.rstrip()}
        if self.job:
            msg["id"] = self.job
        send(msg)
        m = WINDOW_RE.search(line)
        if m and self.job:
            i, n = int(m.group(1)), int(m.group(2))
            send({"type": "progress", "id": self.job, "stage": "keying",
                  "p": round(i / n, 4), "detail": f"window {i}/{n} done"})


class JobState:
    """What the wrapped runtime reports for the running job."""

    def __init__(self, job: str):
        self.job = job
        self.total = 0
        self.writers: list = []
        self.last_sent = 0.0
        self.last_done = -1

    def frames_done(self) -> int:
        # loop: HOT-PATH-OK — ≤ four writers, per frames reply (≤ 4/s)
        return min((w.ck_frames for w in self.writers), default=0)

    def report_frames(self, force: bool = False) -> None:
        done = self.frames_done()
        now = time.monotonic()
        if done == self.last_done:
            return
        if not force and done < self.total and now - self.last_sent < FRAMES_EVERY_S:
            return
        self.last_sent, self.last_done = now, done
        send({"type": "frames", "id": self.job, "done": done, "total": self.total})


class Engine:
    def __init__(self, package_root: Path):
        self.root = package_root
        sys.path.insert(0, str(package_root))
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        import torch  # noqa: E402  (after the env above)
        from corridorkey import runtime, video_io  # noqa: E402

        self.torch = torch
        self.rt = runtime
        self.vio = video_io
        self.paths = runtime.RuntimePaths.from_package(package_root)
        self.model = None
        self.vram_budget_gb: float | None = None
        self.state: JobState | None = None
        self.log = ModelLog()
        sys.stdout = self.log
        self._wrap_runtime()

    # ---- the runtime, wrapped in its own namespace ----

    def _wrap_runtime(self) -> None:
        rt, engine = self.rt, self

        def stage(fn, name):
            def wrapped(*a, **kw):
                if engine.state:
                    send({"type": "progress", "id": engine.state.job, "stage": name})
                return fn(*a, **kw)
            return wrapped

        def probed(fn):
            def wrapped(*a, **kw):
                meta = fn(*a, **kw)
                if engine.state:
                    h, w = meta["output_hw"]
                    engine.state.total = int(meta["num_frames"])
                    send({"type": "clip", "id": engine.state.job, "width": int(w), "height": int(h),
                          "fps": float(meta["native_fps"]), "frames": int(meta["num_frames"])})
                return meta
            return wrapped

        orig_auto = rt.apply_auto_vram

        def auto_vram(cfg, shape_hw, num_frames):
            # The same budget apply_auto_vram computes (nothing allocates in between),
            # capped by the job's vram_budget_gb (Marcy keeps the rest of the card).
            free_bytes, _ = engine.torch.cuda.mem_get_info()
            budget_gb = (free_bytes + engine.torch.cuda.memory_reserved()) / 2**30
            cap = engine.vram_budget_gb
            if cap is not None and cap < budget_gb:
                budget_gb = cap
                chunk, stride, low_vram, _ = rt.select_vram_profile(shape_hw, num_frames, budget_gb)
                cfg.hann_chunk, cfg.hann_stride, cfg.low_vram = chunk, stride, low_vram
                print(f"  Auto VRAM: budget capped at {cap:.1f} GB -> hann_chunk={chunk}, "
                      f"hann_stride={stride}, low_vram={low_vram}")
            else:
                orig_auto(cfg, shape_hw, num_frames)
            mp = shape_hw[0] * shape_hw[1] / 1e6
            estimate = rt.estimate_peak_vram_gb(mp, min(cfg.hann_chunk, num_frames), cfg.low_vram)
            if engine.state:
                send({"type": "memory", "id": engine.state.job, "hann_chunk": cfg.hann_chunk,
                      "hann_stride": cfg.hann_stride, "low_vram": cfg.low_vram, "auto": True,
                      "budget_gb": round(budget_gb, 2), "estimate_gb": round(estimate, 2)})

        def counting(cls):
            class Counting(cls):
                def __init__(self, *a, **kw):
                    super().__init__(*a, **kw)
                    self.ck_frames = 0
                    if engine.state:
                        engine.state.writers.append(self)

                def write_many(self, frames):
                    super().write_many(frames)
                    self.ck_frames += len(frames)
                    if engine.state:
                        engine.state.report_frames()
            Counting.__name__ = cls.__name__
            return Counting

        rt.probe_video_meta = probed(rt.probe_video_meta)
        rt.probe_frame_dir_meta = probed(rt.probe_frame_dir_meta)
        rt.apply_auto_vram = auto_vram
        rt.precompute_rvm_to_memmap = stage(rt.precompute_rvm_to_memmap, "rvm")
        rt.precompute_foundations_to_memmap = stage(rt.precompute_foundations_to_memmap, "foundations")
        rt.hann_stage1_stream = stage(rt.hann_stage1_stream, "keying")
        rt.ThreadedVideoWriter = counting(rt.ThreadedVideoWriter)
        rt.ExrSequenceWriter = counting(rt.ExrSequenceWriter)

    # ---- requests ----

    def pong(self) -> dict:
        torch = self.torch
        cuda = torch.cuda.is_available()
        p = self.paths
        return {
            "type": "pong", "version": ENGINE_VERSION, "protocol": PROTOCOL, "engine": "pytorch",
            "device": "cuda" if cuda else "cpu",
            "gpu": torch.cuda.get_device_name(0) if cuda else None,
            "vram_total_mb": (torch.cuda.get_device_properties(0).total_memory // 2**20) if cuda else None,
            "python": platform.python_version(), "torch": torch.__version__,
            "assets": {
                "weights": p.weights.exists(), "foundation_stats": p.foundation_stats.exists(),
                "rvm": p.rvm_ckpt.exists(), "moge": p.moge_checkpoint.exists(),
                "cradio": p.cradio_dir.exists(),
            },
        }

    def configs(self, req: dict):
        rt = self.rt
        o = req.get("options") or {}
        outputs = set(o.get("outputs") or ["alpha", "fg"])
        bad = sorted(outputs - {"alpha", "fg", "checker", "cutout"})
        if bad:
            raise ValueError(f"unsupported outputs: {bad}")
        manual = "hann_chunk" in o or "hann_stride" in o or bool(o.get("low_vram"))
        chunk = int(o.get("hann_chunk") or 80)
        stride = int(o.get("hann_stride") or max(1, chunk // 2))
        writer = rt.WriterConfig(
            ffmpeg_bin="ffmpeg", codec="libx264", crf=int(o.get("crf", 12)),
            preset=str(o.get("preset", "medium")), pix_fmt=str(o.get("pix_fmt", "yuv444p10le")),
            bitrate=None, threads=2)
        cfg = rt.InferenceConfig(
            hann_chunk=chunk, hann_stride=stride, auto_vram=not manual,
            carry_hint=bool(o.get("carry_hint", True)),
            hint_quality=float(o.get("hint_quality", 0.95)),
            carry_hint_quality=float(o.get("carry_hint_quality", 0.95)),
            num_frames=int(o.get("num_frames", -1)),
            low_vram=bool(o.get("low_vram", False)),
            outputs=outputs, temp_dir=Path(req["temp_dir"]),
            frame_dir_fps=float(o.get("frame_dir_fps", 24.0)),
            frame_dir_linear=bool(o.get("frame_dir_linear", False)),
            cutout_linear=bool(o.get("cutout_linear", False)),
            despill_strength=float(o.get("despill_strength", 0.5)),
            output_format=str(o.get("output_format", "video")),
            exr_dtype=str(o.get("exr_dtype", "half")))
        return cfg, writer, manual

    def run(self, req: dict) -> None:
        job = str(req["id"])
        torch, rt = self.torch, self.rt
        started = time.monotonic()
        self.state, self.log.job = JobState(job), job
        try:
            if not torch.cuda.is_available():
                send({"type": "error", "id": job, "code": "no-gpu",
                      "message": "CorridorKey needs an NVIDIA graphics card with CUDA."})
                return
            try:
                self.paths.validate()
                self.vio.require_ffmpeg("ffmpeg")
            except FileNotFoundError as e:
                send({"type": "error", "id": job, "code": "assets", "message": str(e)})
                return
            try:
                cfg, writer, manual = self.configs(req)
            except (KeyError, TypeError, ValueError) as e:
                send({"type": "error", "id": job, "code": "input", "message": str(e)})
                return
            if not os.path.exists(req["input"]):
                send({"type": "error", "id": job, "code": "input",
                      "message": f"input not found: {req['input']}"})
                return
            budget = (req.get("options") or {}).get("vram_budget_gb")
            self.vram_budget_gb = float(budget) if budget else None
            if self.vram_budget_gb:
                # A hard cap for this process: PyTorch raises OOM instead of going past it.
                total = torch.cuda.get_device_properties(0).total_memory / 2**30
                torch.cuda.set_per_process_memory_fraction(min(1.0, self.vram_budget_gb / total))
            if self.model is None:
                send({"type": "progress", "id": job, "stage": "load"})
                self.model = rt.load_model(self.paths, device="cuda")
            send({"type": "progress", "id": job, "stage": "probe"})
            if manual:
                send({"type": "memory", "id": job, "hann_chunk": cfg.hann_chunk,
                      "hann_stride": cfg.hann_stride, "low_vram": cfg.low_vram, "auto": False})
            o = req.get("options") or {}
            rt.run_inference(self.model, req["input"], req["output_dir"], cfg, writer,
                             initial_hint_path=o.get("hint_first_frame"),
                             hint_video_path=o.get("hint_video"))
            self.state.report_frames(force=True)
            # loop: NOT-WORTH — ≤ four writers, once per job
            outputs = [w.path for w in self.state.writers if hasattr(w, "path")]
            clip = self.vio.raw_clip_name(req["input"])
            send({"type": "result", "id": job, "outputs": outputs,
                  "settings_file": os.path.join(req["output_dir"], f"{clip}_settings.txt"),
                  "seconds": round(time.monotonic() - started, 2)})
        except torch.cuda.OutOfMemoryError as e:
            traceback.print_exc(file=sys.stderr)
            torch.cuda.empty_cache()
            send({"type": "error", "id": job, "code": "oom",
                  "message": f"The graphics card ran out of memory: {e}".split("\n")[0]})
        except Exception as e:  # error: SHOWN — every job failure is a protocol error the app displays
            traceback.print_exc(file=sys.stderr)
            send({"type": "error", "id": job, "code": "engine", "message": f"{type(e).__name__}: {e}"})
        finally:
            self.state, self.log.job = None, None


def serve(engine: Engine, stdin) -> None:
    pending_cancel: set[str] = set()
    # loop: SERIAL-REQUIRED — one job at a time on one GPU; the app queues
    for raw in stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
            if not isinstance(req, dict) or not isinstance(req.get("cmd"), str):
                raise ValueError("not a request object")
        except ValueError as e:
            send({"type": "error", "code": "bad-request", "message": f"bad json: {e}"})
            continue
        cmd = req["cmd"]
        if cmd == "ping":
            send(engine.pong())
        elif cmd == "quit":
            return
        elif cmd == "cancel":
            pending_cancel.add(str(req.get("id")))
        elif cmd == "run":
            if not req.get("id") or not req.get("input") or not req.get("output_dir") or not req.get("temp_dir"):
                send({"type": "error", "id": req.get("id"), "code": "bad-request",
                      "message": "run needs id, input, output_dir and temp_dir"})
            elif str(req["id"]) in pending_cancel:
                pending_cancel.discard(str(req["id"]))
                send({"type": "error", "id": req["id"], "code": "cancelled", "message": "cancelled"})
            else:
                engine.run(req)
        else:
            send({"type": "error", "id": req.get("id"), "code": "bad-request",
                  "message": f"unknown cmd: {cmd}"})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--package-root", default=os.environ.get("CK_PACKAGE_ROOT"),
                    help="The CorridorKey2.0 checkout (corridorkey/, weights/, vfms/). Env: CK_PACKAGE_ROOT.")
    args = ap.parse_args()
    if not args.package_root:
        ap.error("--package-root (or CK_PACKAGE_ROOT) is required")
    try:
        engine = Engine(Path(args.package_root).resolve())
    except Exception as e:  # error: SHOWN — the app reports an engine that can't start
        traceback.print_exc(file=sys.stderr)
        send({"type": "error", "code": "engine", "message": f"engine failed to start: {type(e).__name__}: {e}"})
        sys.exit(1)
    serve(engine, sys.stdin)


if __name__ == "__main__":
    main()
