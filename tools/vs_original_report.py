#!/usr/bin/env python3
"""The "vs CorridorKey 2.0" scorecard (BACKLOG row 36), written from what tools/vs_original.sh collected in its
report folder. Every number comes from those files; nothing is estimated, and what wasn't measured says so.

  python3 tools/vs_original_report.py build OUT_DIR             -> OUT_DIR/report.md (+ scorecard.json)
  python3 tools/vs_original_report.py formats OUTPUT_DIR        -> the output files' formats as JSON (stdout)
  python3 tools/vs_original_report.py sizes FILE                -> CorridorKey Desktop's download sizes from
                                                                    electron/main/install.ts (JSON, stdout)
  python3 tools/vs_original_report.py --self-test               -> the floor logic on synthetic numbers

The floor (axis 1). CorridorKey 2.0 doesn't give the same matte twice to the last bit in every setting, and its
shipping precision (bf16 autocast) differs from its full precision (fp32). Both are its own variation:
  - run to run: two identical runs of the original, compared like ours (tools/matte_compare.py);
  - precision: the original's model in fp32 against bf16 autocast (scripts/onnx_spike/run_parity.py in the
    CorridorKey2.0 checkout: Corridor's model code unchanged, the runtime's steps mirrored, because the original's
    own runtime has no fp32 switch).
For each measure the floor is the larger of the two (for PSNR, higher is better: the lower). Ours against the
original is then:
  - "identical" when the difference is exactly 0;
  - "within the original's own variation" when it is no larger than the floor (PSNR: no lower);
  - "outside: N x the original's variation" when larger (PSNR: "outside by N dB");
  - "outside (the original repeats exactly here)" when the floor is exactly 0 and ours isn't;
  - "no floor measured" when neither floor exists for that clip.
A clip is within when every measure is.
"""
import argparse
import glob
import json
import math
import os
import re
import statistics
import subprocess
import sys

# the measures the floor applies to: key in matte_compare's JSON -> (label, higher is better)
MEASURES = {
    "alpha_mae": ("alpha MAE", False),
    "alpha_max": ("alpha max", False),
    "alpha_pct_gt_1_255": ("% > 1/255", False),
    "alpha_pct_gt_4_255": ("% > 4/255", False),
    "edge_band_mae": ("hair-edge MAE", False),
    "edge_band_pct_gt_1_255": ("hair-edge % > 1/255", False),
    "fg_psnr_db": ("fg PSNR", True),
}


def load(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def first(x):
    """matte_compare's JSON is a list (one entry per clip): its first entry, or the dict itself."""
    if isinstance(x, list):
        return x[0] if x else None
    return x


# ---------------------------------------------------------------- the floor logic

def floor_of(rr, prec, key):
    """The original's own variation for one measure: the larger of run-to-run and precision (PSNR: the lower)."""
    hib = MEASURES[key][1]
    vals = [m.get(key) for m in (rr, prec) if m and m.get(key) is not None]  # loop: NOT-WORTH — a few repeats / measures, once per report
    if not vals:
        return None
    return min(vals) if hib else max(vals)


def verdict_one(ours, floor, higher_better):
    """(code, text) for one measure. Codes: identical, within, outside, outside-exact, no-floor, n/a."""
    if ours is None:
        return "n/a", "not measured"
    if higher_better:
        if math.isinf(ours):
            return "identical", "identical"
        if floor is None:
            return "no-floor", "no floor measured"
        if math.isinf(floor):
            return "outside-exact", "outside (the original repeats exactly here)"
        if ours >= floor:
            return "within", "within the original's own variation"
        return "outside", f"outside by {floor - ours:.1f} dB"
    if ours == 0:
        return "identical", "identical"
    if floor is None:
        return "no-floor", "no floor measured"
    if floor == 0:
        return "outside-exact", "outside (the original repeats exactly here)"
    if ours <= floor:
        return "within", "within the original's own variation"
    return "outside", f"outside: {ours / floor:.1f}x the original's variation"


def verdict_clip(ours, rr, prec):
    """Per measure: (ours, floor, code, text); and the clip's verdict."""
    rows = {}
    # loop: NOT-WORTH — seven measures
    for key, (_, hib) in MEASURES.items():
        f = floor_of(rr, prec, key)
        o = ours.get(key) if ours else None
        code, text = verdict_one(o, f, hib)
        rows[key] = {"ours": o, "floor": f, "code": code, "text": text}
    # loop: NOT-WORTH — seven measures
    codes = [r["code"] for r in rows.values() if r["code"] != "n/a"]
    if not codes:
        clip = ("n/a", "not measured")
    elif all(c == "identical" for c in codes):  # loop: NOT-WORTH — a few repeats / measures, once per report
        clip = ("identical", "identical")
    elif all(c in ("identical", "within") for c in codes):  # loop: NOT-WORTH — a few repeats / measures, once per report
        clip = ("within", "within the original's own variation")
    elif any(c == "no-floor" for c in codes) and not any(c.startswith("outside") for c in codes):  # loop: NOT-WORTH — a few repeats / measures, once per report
        clip = ("no-floor", "no floor measured")
    else:
        # loop: NOT-WORTH — seven measures
        out = [MEASURES[k][0] for k, r in rows.items() if r["code"].startswith("outside")]
        clip = ("outside", "outside the original's variation on " + ", ".join(out))
    return rows, clip


def self_test():
    fails = []

    def check(name, got, want):
        ok = got == want
        print(f"  {'ok ' if ok else 'FAIL'} {name}: {got!r}" + ("" if ok else f" (want {want!r})"))
        if not ok:
            fails.append(name)

    print("floor logic on synthetic numbers")
    check("inside the precision floor", verdict_one(3e-4, floor_of({"alpha_mae": 0.0}, {"alpha_mae": 5e-4}, "alpha_mae"), False)[0], "within")
    check("equal to the floor counts as within", verdict_one(5e-4, 5e-4, False)[0], "within")
    check("twice the floor", verdict_one(1e-3, 5e-4, False), ("outside", "outside: 2.0x the original's variation"))
    check("floor = larger of run-to-run and precision", floor_of({"alpha_mae": 7e-4}, {"alpha_mae": 5e-4}, "alpha_mae"), 7e-4)
    check("PSNR floor = the lower", floor_of({"fg_psnr_db": 60.0}, {"fg_psnr_db": 46.0}, "fg_psnr_db"), 46.0)
    check("PSNR above the floor", verdict_one(48.0, 46.0, True)[0], "within")
    check("PSNR below the floor", verdict_one(40.0, 46.0, True), ("outside", "outside by 6.0 dB"))
    check("PSNR identical (inf)", verdict_one(float("inf"), 46.0, True)[0], "identical")
    check("PSNR, original exactly repeatable", verdict_one(50.0, float("inf"), True)[0], "outside-exact")
    check("identical difference", verdict_one(0.0, 5e-4, False)[0], "identical")
    check("identical even without a floor", verdict_one(0.0, None, False)[0], "identical")
    check("original repeats exactly, ours differs", verdict_one(1e-5, 0.0, False)[0], "outside-exact")
    check("no floor measured", verdict_one(1e-5, None, False)[0], "no-floor")
    check("floor from run-to-run only", floor_of({"alpha_mae": 2e-4}, None, "alpha_mae"), 2e-4)
    full = {"alpha_mae": 3e-4, "alpha_max": 0.05, "alpha_pct_gt_1_255": 2.0, "alpha_pct_gt_4_255": 0.1,
            "edge_band_mae": 1e-3, "edge_band_pct_gt_1_255": 10.0, "fg_psnr_db": 48.0}
    prec = {"alpha_mae": 5e-4, "alpha_max": 0.2, "alpha_pct_gt_1_255": 3.5, "alpha_pct_gt_4_255": 0.3,
            "edge_band_mae": 2e-3, "edge_band_pct_gt_1_255": 12.0, "fg_psnr_db": 46.0}
    rr = dict.fromkeys(prec, 0.0)
    rr["fg_psnr_db"] = float("inf")
    check("clip within", verdict_clip(full, rr, prec)[1][0], "within")
    worse = dict(full, alpha_max=0.3)
    rows, clip = verdict_clip(worse, rr, prec)
    check("clip outside on one measure", clip, ("outside", "outside the original's variation on alpha max"))
    check("clip identical", verdict_clip(dict.fromkeys(full, 0.0) | {"fg_psnr_db": float("inf")}, rr, prec)[1][0], "identical")
    check("clip without floors", verdict_clip(full, None, None)[1][0], "no-floor")
    check("median of three", med([3.0, 1.0, 2.0]), 2.0)
    check("median ignores missing", med([None, 4.0, 2.0]), 3.0)
    if fails:
        print(f"self-test FAILED: {', '.join(fails)}")
        return 1
    print("self-test passed")
    return 0


# ---------------------------------------------------------------- formats and sizes

PIX_BITS = re.compile(r"(\d+)(le|be)$")


def pix_bits(pix):
    if not pix:
        return None
    m = PIX_BITS.search(pix)
    if m:
        return int(m.group(1)) if int(m.group(1)) <= 16 else None
    return 8 if pix in ("yuv420p", "yuv422p", "yuv444p", "gray", "rgb24", "bgr24", "yuva420p", "yuvj420p", "yuvj444p") else None


def formats(folder):
    """What an output folder holds: per output, the container/codec/pixel format and bits (video) or channels and
    pixel type (EXR, first frame)."""
    out = {}
    # loop: NOT-WORTH — a few output files
    for p in sorted(glob.glob(os.path.join(glob.escape(folder), "*"))):
        base = os.path.basename(p)
        m = re.match(r".*_(alpha|fg|cutout|checker\w*)(\.\w+|_exr)$", base)
        if not m:
            continue
        name = m.group(1)
        if os.path.isdir(p):
            files = sorted(glob.glob(os.path.join(glob.escape(p), "*.exr")))
            if not files:
                continue
            info = {"kind": "exr", "frames": len(files), "file": os.path.basename(files[0])}
            try:
                import OpenEXR

                with OpenEXR.File(files[0]) as x:
                    ch = x.channels()
                    info["channels"] = list(ch)
                    # loop: NOT-WORTH — a few channels
                    info["pixel_types"] = sorted({str(c.pixels.dtype) for c in ch.values()})
            except Exception as e:  # error: SHOWN — written into the facts as the reason
                info["error"] = f"{type(e).__name__}: {e}"
            out[name] = info
        else:
            # loop: NOT-WORTH — one ffprobe per output file [bounded: a local file, 30 s]
            r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                "stream=codec_name,pix_fmt,width,height,bits_per_raw_sample", "-of", "json", p],
                               capture_output=True, text=True, timeout=30)
            s = (json.loads(r.stdout or "{}").get("streams") or [{}])[0]
            out[name] = {"kind": "video", "file": base, "codec": s.get("codec_name"), "pix_fmt": s.get("pix_fmt"),
                         "bits": pix_bits(s.get("pix_fmt"))}
    return out


def sizes(install_ts):
    """CorridorKey Desktop's download: the Linux runtime wheels and the model files, summed from install.ts."""
    src = open(install_ts).read()

    def block(name):
        m = re.search(rf"^export const {name} = \{{(.*?)^\}};", src, re.S | re.M)
        if not m:
            raise SystemExit(f"{install_ts}: no `export const {name}` block")
        body = m.group(1).replace("_", "")
        # the runtime's wheels say `size: N`; the model files are `model("file", N, "sha256")`
        # loop: NOT-WORTH — a few dozen size entries
        return sum(int(v) for v in re.findall(r"size:\s*([0-9]+)", body)) + sum(int(v) for v in re.findall(r'model\("[^"]+",\s*([0-9]+),', body))

    rt, models = block("RUNTIME"), block("MODELS")
    return {"runtime_bytes": rt, "models_bytes": models, "total_bytes": rt + models, "source": install_ts}


# ---------------------------------------------------------------- the report

def med(vals):
    # loop: NOT-WORTH — three repeats
    v = [x for x in vals if x is not None]
    return statistics.median(v) if v else None


def spread(vals):
    # loop: NOT-WORTH — three repeats
    v = [x for x in vals if x is not None]
    return (min(v), max(v)) if len(v) > 1 else None


def f(v, spec=".1f", unit=""):
    if v is None:
        return "n/a"
    if isinstance(v, float) and math.isinf(v):
        return "∞ (identical)"
    return f"{v:{spec}}{unit}"


def gb(bytes_):
    return None if bytes_ is None else bytes_ / 1e9


def speed_rows(out, engine):
    """Per clip: the bench rows of every repeat."""
    by = {}
    # loop: NOT-WORTH — the repeats' bench files (≤ a few)
    for b in sorted(glob.glob(os.path.join(glob.escape(out), "speed", engine, "rep*", "bench.json"))):
        # loop: NOT-WORTH — the clips of one bench
        for r in (load(b) or {}).get("rows", []):
            by.setdefault(r["clip"], []).append(r)
    return by


def speed_summary(rows):
    ok = [r for r in rows if not r.get("error") and r.get("exit") == 0]  # loop: NOT-WORTH — a few repeats / measures, once per report
    w = [r.get("warm") or {} for r in ok]  # loop: NOT-WORTH — a few repeats / measures, once per report
    return {
        "n": len(rows), "ok": len(ok),
        "total": med([r.get("totalS") for r in ok]), "total_spread": spread([r.get("totalS") for r in ok]),  # loop: NOT-WORTH — a few repeats / measures, once per report
        "first": med([r.get("firstFrameAt") for r in ok]), "fps": med([r.get("steadyFps") for r in ok]),  # loop: NOT-WORTH — a few repeats / measures, once per report
        "warm_total": med([x.get("totalS") for x in w if not x.get("error")]),  # loop: NOT-WORTH — a few repeats / measures, once per report
        "warm_first": med([x.get("firstFrameS") for x in w if not x.get("error")]),  # loop: NOT-WORTH — a few repeats / measures, once per report
        "warm_fps": med([x.get("steadyFps") for x in w if not x.get("error")]),  # loop: NOT-WORTH — a few repeats / measures, once per report
        "vram_gb": med([r.get("peakVramMb", 0) / 1024 for r in ok]) if ok else None,  # loop: NOT-WORTH — a few repeats / measures, once per report
        "ram_gb": med([r.get("peakRssMb", 0) / 1024 for r in ok]) if ok else None,  # loop: NOT-WORTH — a few repeats / measures, once per report
        "cpu_s": med([r.get("cpuS") for r in ok]),  # loop: NOT-WORTH — a few repeats / measures, once per report
        "window": next((f"{r['memory']['hann_chunk']}/{r['memory']['hann_stride']}{' low' if r['memory'].get('low_vram') else ''}"
                        for r in ok if r.get("memory")), None),  # loop: NOT-WORTH — the first row with a window
        "errors": [r.get("error") for r in rows if r.get("error")],  # loop: NOT-WORTH — three repeats
        "frames": next((r.get("totalFrames") for r in ok), None),  # loop: NOT-WORTH — the first row
        "size": next((f"{r.get('width')}×{r.get('height')}" for r in ok if r.get("width")), None),  # loop: NOT-WORTH — the first row
    }


def build(out):
    meta = load(os.path.join(out, "meta.json"), {})
    L = []
    rehearse = meta.get("mode") == "rehearse"
    L.append("# CorridorKey Desktop vs CorridorKey 2.0")
    L.append("")
    if rehearse:
        L += ["> **REHEARSAL, NOT A MEASUREMENT.** Run on the processor with tiny inputs to prove the tool works: the",
              "> \"original\" columns are a second run of CorridorKey Desktop's engine standing in for CorridorKey 2.0",
              "> (the original needs an NVIDIA card). None of these numbers may be quoted.", ""]
    L.append(f"Measured {meta.get('date', '?')} on one machine, same clips, same settings ({meta.get('settings', '?')}), by "
             f"`tools/vs_original.sh` at commit {meta.get('commit', '?')[:10]} ({meta.get('mode', '?')} run, "
             f"{meta.get('repeats', '?')} repeat(s); medians).")
    mach = meta.get("machine") or {}
    if mach:
        L.append("")
        L.append("| Machine | |")
        L.append("|---|---|")
        # loop: NOT-WORTH — a handful of facts
        for k, v in mach.items():
            L.append(f"| {k} | {v} |")
    clips = meta.get("clips") or []
    card = {"axes": {}}

    # ---- summary placeholders filled below
    summary = []

    # ---- 1. quality
    L += ["", "## 1. Quality: our mattes against the original's, inside its own variation", "",
          "Reference: the original's run A. Floors: run to run (the original's run B against A) and precision (the "
          "original's model in fp32 against its shipping bf16, `scripts/onnx_spike/run_parity.py`, the first frames "
          "named). The verdict compares each measure with the larger floor; outputs are float EXR (no codec in between).", "",
          "| Clip | frames | alpha MAE (ours · run-to-run · precision) | alpha max | % > 1/255 | % > 4/255 | hair-edge MAE | hair-edge % > 1/255 | fg PSNR | Verdict |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    q_within = q_total = 0
    qcard = {}
    # loop: NOT-WORTH — the scorecard's clips (≤ 10)
    for c in clips:
        name = c["name"]
        qd = os.path.join(out, "quality", name)
        ours, rr = first(load(os.path.join(qd, "compare.json"))), first(load(os.path.join(qd, "rr.json")))
        prec = first(load(os.path.join(out, "floor", name, "precision.json")))
        nfr = (load(os.path.join(out, "floor", name, "meta.json")) or {}).get("frames")
        # with a precision floor on the first N frames only, the verdict uses ours and run-to-run on those N
        ours_v, rr_v = ours, rr
        if prec and nfr:
            ours_v = first(load(os.path.join(qd, "compare_n.json"))) or ours
            rr_v = first(load(os.path.join(qd, "rr_n.json"))) or rr
        if not ours:
            why = open(os.path.join(qd, "status.txt")).read().strip() if os.path.exists(os.path.join(qd, "status.txt")) else "not measured"
            L.append(f"| {name} | n/a | {why} |  |  |  |  |  |  | n/a |")
            continue
        rows, clip = verdict_clip(ours_v, rr_v, prec)
        q_total += 1
        q_within += clip[0] in ("within", "identical")

        def cell(key, spec):
            r = rows[key]
            fl = [(rr_v or {}).get(key), (prec or {}).get(key)]
            return f"{f(r['ours'], spec)} · {f(fl[0], spec)} · {f(fl[1], spec)}"

        fr = f"{ours.get('frames')}" + (f" (verdict: first {nfr})" if prec and nfr else "")
        L.append(f"| {name} | {fr} | {cell('alpha_mae', '.2e')} | {cell('alpha_max', '.3f')} | {cell('alpha_pct_gt_1_255', '.2f')} | "
                 f"{cell('alpha_pct_gt_4_255', '.3f')} | {cell('edge_band_mae', '.2e')} | {cell('edge_band_pct_gt_1_255', '.2f')} | "
                 f"{cell('fg_psnr_db', '.1f')} | {clip[1]} |")
        qcard[name] = {"verdict": clip, "measures": rows, "precision_frames": nfr,
                       "floor_status": None if prec else (open(os.path.join(out, "floor", name, "status.txt")).read().strip()
                                                          if os.path.exists(os.path.join(out, "floor", name, "status.txt")) else "not measured")}
    # loop: NOT-WORTH — the scorecard's clips
    missing_prec = [n for n, v in qcard.items() if v["floor_status"]]
    if missing_prec:
        L += ["", "Precision floor not measured for: " + "; ".join(f"{n} ({qcard[n]['floor_status']})" for n in missing_prec) +  # loop: NOT-WORTH — a few clips
              ". There the floor is run to run alone."]
    card["axes"]["quality"] = qcard
    summary.append(("Quality", f"{q_within} of {q_total} clips within the original's own variation" if q_total else "not measured"))

    # ---- 2. speed
    L += ["", "## 2. Speed", "",
          "Cold: a new engine process per clip, so the model load is included (**total** = engine start → the job's "
          "result; **first frames** = engine start → the first finished frames, i.e. load + the first window, never the "
          "total). Warm: the same clip again as a second job in the same process (models loaded), as the second clip "
          "of a queue; timed from its `run` line. **Steady** = frames per second after the first window. Medians of the "
          "repeats; the spread of the cold total in brackets.", "",
          "| Clip | Original cold: total · first frames · steady | Ours cold: total · first frames · steady | Faster (cold total) | Original warm: total · first · steady | Ours warm: total · first · steady | Faster (warm total) | window (orig / ours) |",
          "|---|---|---|---|---|---|---|---|"]
    so, su = speed_rows(out, "original"), speed_rows(out, "ours")
    scard = {}
    # loop: NOT-WORTH — the scorecard's clips
    for c in clips:
        name = c["name"]
        o, u = speed_summary(so.get(name, [])), speed_summary(su.get(name, []))

        def cold(s):
            if not s["ok"]:
                return "not run" if not s["n"] else f"failed: {s['errors'][0] if s['errors'] else '?'}"
            sp = f" [{s['total_spread'][0]:.1f}-{s['total_spread'][1]:.1f}]" if s["total_spread"] else ""
            return f"{f(s['total'], '.1f', ' s')}{sp} · {f(s['first'], '.1f', ' s')} · {f(s['fps'], '.2f', ' fps')}"

        def warm(s):
            return "n/a" if s["warm_total"] is None else f"{f(s['warm_total'], '.1f', ' s')} · {f(s['warm_first'], '.1f', ' s')} · {f(s['warm_fps'], '.2f', ' fps')}"

        ratio = (o["total"] / u["total"]) if o["total"] and u["total"] else None
        wratio = (o["warm_total"] / u["warm_total"]) if o["warm_total"] and u["warm_total"] else None
        label = f"{name} {u['size'] or o['size'] or ''}, {u['frames'] or o['frames'] or '?'} frames"
        L.append(f"| {label} | {cold(o)} | {cold(u)} | {f(ratio, '.2f', '×')} | {warm(o)} | {warm(u)} | {f(wratio, '.2f', '×')} | {o['window'] or 'n/a'} / {u['window'] or 'n/a'} |")
        scard[name] = {"original": o, "ours": u, "faster_cold": ratio, "faster_warm": wratio}
    card["axes"]["speed"] = scard
    # the shared memory slice throttles above 20 GB (CLAUDE.md): a run that came near it may have been slowed
    near = []
    try:
        # loop: NOT-WORTH — the run log's lines, once per report
        for line in open(os.path.join(out, "run.log"), errors="replace"):
            m = re.match(r"memrun: peak (\d+) MB", line)
            if m and int(m.group(1)) >= 19000:
                near.append(int(m.group(1)))
    except OSError:
        pass
    if near:
        L += ["", f"Caution: {len(near)} step(s) peaked at {max(near) / 1000:.1f} GB of RAM, near the 20 GB where the shared memory "
              "budget (claude-work.slice) throttles; their times may be slowed by it (run.log)."]
    # loop: NOT-WORTH — the scorecard's clips
    ratios = [v["faster_cold"] for v in scard.values() if v["faster_cold"]]
    summary.append(("Speed", f"{min(ratios):.2f}-{max(ratios):.2f}× the original's speed (cold total, median of repeats)" if ratios else "not measured"))

    # ---- 3. resources
    res = load(os.path.join(out, "resources.json"), {})
    L += ["", "## 3. Resources", "",
          "Peak graphics memory (nvidia-smi) and RAM (/proc) of the engine's processes, sampled every 250 ms; CPU time of "
          "the engine's process tree (/proc, user + system, ffmpeg writers included) for the cold job; medians of the repeats.", "",
          "| Clip | Graphics memory GiB (orig → ours) | RAM GiB (orig → ours) | CPU time s (orig → ours) |", "|---|---|---|---|"]
    # loop: NOT-WORTH — the scorecard's clips
    for name, v in scard.items():
        o, u = v["original"], v["ours"]
        L.append(f"| {name} | {f(o['vram_gb'], '.2f')} → {f(u['vram_gb'], '.2f')} | {f(o['ram_gb'], '.2f')} → {f(u['ram_gb'], '.2f')} | "
                 f"{f(o['cpu_s'], '.0f')} → {f(u['cpu_s'], '.0f')} |")
    if res:
        ins = res.get("install", {})
        L += ["", "Install size (`du --si` method of the README's Install size table: decimal GB, on disk):", "",
              "| Part | CorridorKey Desktop | Original CorridorKey 2.0 |", "|---|---|---|"]
        # loop: NOT-WORTH — four parts
        for part in ("app", "runtime", "models", "total"):
            a, b = ins.get("ours", {}).get(part), ins.get("original", {}).get(part)
            L.append(f"| {part} | {f(gb(a), '.2f', ' GB')} | {f(gb(b), '.2f', ' GB')} |")
        dl = res.get("download", {})
        L += ["", f"Download: CorridorKey Desktop {f(gb(dl.get('ours_bytes')), '.2f', ' GB')} (measured: the sizes pinned in "
              f"electron/main/install.ts, runtime {f(gb(dl.get('ours_runtime_bytes')), '.2f', ' GB')} + models "
              f"{f(gb(dl.get('ours_models_bytes')), '.2f', ' GB')}) plus the AppImage ({f(gb(ins.get('ours', {}).get('app')), '.2f', ' GB')}); "
              f"original: weights + foundation models {f(gb(dl.get('original_weights_bytes')), '.2f', ' GB')} (measured on disk: they are "
              "stored as downloaded) plus pip's wheels for the venv (not measured: pip keeps no record of the download size; the "
              "venv on disk is in the table)."]
        notes = res.get("notes") or []
        L += [f"- {n}" for n in notes]  # loop: NOT-WORTH — a few notes
    card["axes"]["resources"] = {"install": res}

    # ---- 4. capability
    cap = load(os.path.join(out, "capability.json"), {})
    L += ["", "## 4. Capability", "", "| | CorridorKey Desktop | Original CorridorKey 2.0 | how we know |", "|---|---|---|---|"]
    # loop: NOT-WORTH — a dozen capability rows
    for row in cap.get("rows", []):
        L.append(f"| {row['what']} | {row['ours']} | {row['original']} | {row['source']} |")
    card["axes"]["capability"] = cap

    # ---- 5. robustness
    rob = load(os.path.join(out, "robust", "robust.json"), {})
    L += ["", "## 5. Robustness", "",
          "Each case run once per engine; **ok** = the expected, clean outcome (a protocol error naming the cause and the "
          "engine still answering, or a clean stop), **partial** = handled but not cleanly (an error that doesn't name the cause, a "
          "Python traceback for the user), **fail** = crash, hang, wrong result, left running. "
          "Through the protocol (the app's way) for both; through the original's own CLI (`infer.py`) where it can be.", "",
          "| Case | CorridorKey Desktop | Original (protocol: engine/ck_engine.py) | Original (its CLI: infer.py) |", "|---|---|---|---|"]
    counts = {}
    # loop: NOT-WORTH — a handful of cases
    for case in rob.get("cases", []):
        cells = []
        # loop: NOT-WORTH — three ways to run
        for side in ("ours", "original", "original_cli"):
            r = case.get(side)
            if not r:
                cells.append("not run")
                continue
            if r.get("outcome") == "untestable":
                cells.append(f"can't be tested: {r.get('detail', '')}")
                continue
            c = counts.setdefault(side, [0, 0, 0])
            c[{"ok": 0, "partial": 1}.get(r.get("outcome"), 2)] += 1
            cells.append(f"**{r.get('outcome')}**: {r.get('detail', '')}")
        L.append(f"| {case.get('title', case.get('case'))} | " + " | ".join(cells) + " |")
    if counts:
        L += ["", "Counted: " + "; ".join(f"{s}: {v[0]} ok, {v[1]} partial, {v[2]} failed" for s, v in counts.items()) + "."]  # loop: NOT-WORTH — three sides
    card["axes"]["robustness"] = rob
    summary.append(("Robustness", "; ".join(f"{s}: {v[0]} ok / {v[1]} partial / {v[2]} failed" for s, v in counts.items()) if counts else "not measured"))  # loop: NOT-WORTH — three sides

    # ---- 6. getting started
    L += ["", "## 6. Getting started (documented steps, counted)", ""]
    gs = getting_started(res)
    # loop: NOT-WORTH — two products
    for who, steps in gs.items():
        L.append(f"**{who}** ({len(steps)} steps)")
        L.append("")
        L += [f"{i}. {s}" for i, s in enumerate(steps, 1)]  # loop: NOT-WORTH — a dozen steps
        L.append("")
    L.append("Minutes to the first key: not measured (they depend on the connection); the download sizes are in section 3.")
    card["axes"]["getting_started"] = {k: len(v) for k, v in gs.items()}  # loop: NOT-WORTH — two products
    summary.append(("Getting started", ", ".join(f"{k}: {len(v)} steps" for k, v in gs.items())))  # loop: NOT-WORTH — two products

    # ---- blind
    if os.path.isdir(os.path.join(out, "blind")):
        L += ["", "## Blind A/B", "", f"Pairs in `{os.path.join(out, 'blind')}` with the labels hidden (A / B, shuffled per pair). "
              "The key is kept outside the report folder (meta.json says where); open it only after judging."]

    head = ["", "## Summary", "", "| Axis | Result |", "|---|---|"] + [f"| {a} | {b} |" for a, b in summary]  # loop: NOT-WORTH — six axes
    L[3:3] = head
    text = "\n".join(L) + "\n"
    with open(os.path.join(out, "report.md"), "w") as fh:
        fh.write(text)
    card["summary"] = summary
    with open(os.path.join(out, "scorecard.json"), "w") as fh:
        json.dump(card, fh, indent=2, default=str)
    print(text)
    return 0


def getting_started(res):
    """The documented steps of each, from the README's Setup row and the original's README "Setup"."""
    ours = res.get("download", {}).get("ours_bytes")
    return {
        "CorridorKey Desktop (README: Requirements, Install size \"Setup\")": [
            "Download the AppImage (Linux) / installer (Windows) / disk image (macOS) from the releases page.",
            "Start it (Linux: make the AppImage executable first; Windows: SmartScreen \"More info\" → \"Run anyway\" once).",
            f"First start: the setup downloads the GPU runtime and the models itself ({f(gb(ours), '.1f', ' GB')}), and offers to install ffmpeg if it is missing.",
            "Add a clip and press Run.",
        ],
        "Original CorridorKey 2.0 (its README: Setup, Quick Start)": [
            "Have an NVIDIA card with CUDA drivers, Python, git and ffmpeg on the PATH (installed separately).",
            "Get the repository (git clone).",
            "python -m venv venv",
            "source venv/bin/activate",
            "pip install torch==2.9.1 torchvision==0.24.1 --index-url https://download.pytorch.org/whl/cu128",
            "pip install -r requirements.txt",
            "python scripts/download_weights.py (about 5 GB)",
            "Run a clip: the drag-and-drop launcher, run_interactive.py, or python infer.py --input … --output_dir …",
        ],
    }


def main():
    if "--self-test" in sys.argv:
        return self_test()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build").add_argument("out")
    sub.add_parser("formats").add_argument("folder")
    sub.add_parser("sizes").add_argument("install_ts")
    a = ap.parse_args()
    if a.cmd == "build":
        return build(a.out)
    if a.cmd == "formats":
        print(json.dumps(formats(a.folder), indent=2))
        return 0
    print(json.dumps(sizes(a.install_ts), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
