#!/usr/bin/env python3
"""The macOS gate's report (BACKLOG row 24), from what tools/mac_gate.sh collected: the matte comparison
(tools/matte_compare.py --json), both engine benches (tools/engine_bench.mjs bench.json: the Mac's and the CUDA
reference's), the Mac's facts from the preflight, and the side-by-side folders (tools/side_by_side.py).

  python3 tools/mac_gate_report.py --compare compare.json --mac-bench mac/bench.json --ref-bench ref/bench.json
      --facts facts.txt --commit SHA --settings TEXT [--sbs CLIP=DIR ...] --out report.md

Prints the verdict line last. Every number comes from those files; nothing is estimated.

The bar ("mattes within fp16 rounding of CUDA") is the fp16-vs-fp32 difference we measured and published for the
Rust engine on a real plate (docs/ENGINE_RUST.md, "Mattes" and the end-to-end table): locked_backdrop, 1280x1080,
80 frames, window 4/2 low-VRAM, Rust CUDA fp16 against Rust CUDA fp32: alpha MAE 3.41e-4, max 6.25e-2,
3.08 % of pixels off by more than 1/255. A clip passes when its alpha MAE and its % > 1/255 against the CUDA
fp16 run are no larger than that. The max is reported, not gated (one pixel decides it).
"""
import argparse
import json
import sys

BAR = {"alpha_mae": 3.41e-4, "alpha_pct_gt_1_255": 3.08, "alpha_max_published": 6.25e-2}
BAR_SOURCE = (
    "docs/ENGINE_RUST.md (\"Mattes\"; README \"Quality\"): Rust engine CUDA fp16 vs CUDA fp32, locked_backdrop "
    "1280x1080, 80 frames, window 4/2 low-VRAM: alpha MAE 3.41e-4, max 6.25e-2, 3.08 % > 1/255"
)
BAR_CAVEATS = [
    "That measurement compared x264 CRF 12 encodes; this gate compares float EXR (no codec in between), so the "
    "published number includes some codec noise and is a slightly generous bar.",
    "It was measured on one HD clip at window 4/2; here every clip is held to it at the gate's window.",
    "For scale, the same tiny clip without any codec (docs/ENGINE_RUST.md end-to-end table): CUDA fp16 vs "
    "PyTorch fp32 alpha MAE 4.13e-5, max 1.03e-2, 0.044 % > 1/255.",
]


def load(path):
    with open(path) as f:
        return json.load(f)


def facts(path):
    out = {}
    with open(path) as f:
        # loop: NOT-WORTH — a dozen preflight lines
        for line in f:
            if "=" in line:
                k, v = line.rstrip("\n").split("=", 1)
                out[k] = v
    return out


def fmt(v, spec, unit=""):
    if v is None:
        return "n/a"
    return f"{v:{spec}}{unit}"


def provider(row):
    p = row.get("provider") or {}
    return p.get("provider") or row.get("pongProvider") or "?"


def precision(row):
    p = row.get("provider") or {}
    return p.get("precision") or row.get("precision") or "?"


def window(row):
    m = row.get("memory") or {}
    if "hann_chunk" not in m:
        return None
    return f"{m['hann_chunk']}/{m['hann_stride']}{' low' if m.get('low_vram') else ''}"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--compare", required=True)
    ap.add_argument("--mac-bench", required=True)
    ap.add_argument("--ref-bench", required=True)
    ap.add_argument("--facts", required=True)
    ap.add_argument("--commit", required=True)
    ap.add_argument("--settings", default="")
    ap.add_argument("--sbs", action="append", default=[], help="CLIP=DIR (relative to the report)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    # loop: NOT-WORTH — one entry per clip
    cmp_rows = {m["clip"]: m for m in load(a.compare)}
    # loop: NOT-WORTH — one row per clip
    mac = {r["clip"]: r for r in load(a.mac_bench)["rows"]}
    # loop: NOT-WORTH — one row per clip
    ref = {r["clip"]: r for r in load(a.ref_bench)["rows"]}
    fx = facts(a.facts)
    # loop: NOT-WORTH — one entry per clip
    sbs = dict(s.split("=", 1) for s in a.sbs)
    clips = sorted(set(mac) | set(ref))

    problems = []
    passed = []
    failed = []
    # loop: NOT-WORTH — the gate's few clips
    for c in clips:
        m, r, k = mac.get(c), ref.get(c), cmp_rows.get(c)
        if m is None or r is None:
            problems.append(f"{c}: {'no Mac run' if m is None else 'no CUDA reference'}")
            continue
        # loop: NOT-WORTH — the two runs of one clip
        for side, row in (("Mac", m), ("CUDA", r)):
            if row.get("error") or row.get("exit") != 0:
                problems.append(f"{c}: the {side} run ended with {row.get('error') or 'exit ' + str(row.get('exit'))}")
        if window(m) != window(r):
            problems.append(f"{c}: the windows differ (Mac {window(m)}, CUDA {window(r)}): the mattes are not comparable")
        if precision(m) != precision(r):
            problems.append(f"{c}: the precisions differ (Mac {precision(m)}, CUDA {precision(r)})")
        if provider(r) != "cuda":
            problems.append(f"{c}: the reference ran on {provider(r)}, not CUDA")
        if k is None:
            problems.append(f"{c}: no matte comparison")
            continue
        if k["frames"] != m.get("framesDone") or k["frames"] != r.get("framesDone"):
            problems.append(f"{c}: compared {k['frames']} frames, the runs wrote {m.get('framesDone')} (Mac) / {r.get('framesDone')} (CUDA)")
        ok = k["alpha_mae"] <= BAR["alpha_mae"] and k["alpha_pct_gt_1_255"] <= BAR["alpha_pct_gt_1_255"]
        (passed if ok else failed).append(c)

    # loop: NOT-WORTH — the gate's few clips
    mac_providers = sorted({provider(mac[c]) for c in clips if c in mac})
    # loop: NOT-WORTH — the gate's few clips
    speed_measured = all(mac[c].get("totalS") is not None for c in clips if c in mac) and bool(mac)
    within = not failed and not problems and len(passed) == len(clips)
    if mac_providers != ["coreml"]:
        verdict = (f"VERDICT: NOT A GATE RUN: the Mac ran {', '.join(mac_providers) or 'nothing'}, the gate needs Core ML. "
                   f"Mattes vs the reference: {len(passed)}/{len(clips)} clips within the fp16 bar"
                   f"{'; ' + str(len(problems)) + ' problem(s) below' if problems else ''}.")
    elif within and speed_measured:
        verdict = f"VERDICT: PASS: Core ML mattes within fp16 rounding of CUDA on all {len(clips)} clips, speed measured."
    else:
        verdict = (f"VERDICT: FAIL: {len(failed)} clip(s) outside the bar ({', '.join(failed) or 'none'})"
                   f"{'; ' + str(len(problems)) + ' problem(s) below' if problems else ''}{'' if speed_measured else '; speed not measured'}.")

    L = [f"# macOS gate run, commit {a.commit[:12]}", "", f"**{verdict}**", ""]
    L += ["## The bar", "",
          f"A clip passes when, against the CUDA fp16 run of the same clip and settings, alpha MAE ≤ {BAR['alpha_mae']:.2e} "
          f"and pixels off by more than 1/255 ≤ {BAR['alpha_pct_gt_1_255']:.2f} %. Source: {BAR_SOURCE}.", ""]
    # loop: NOT-WORTH — three caveats
    L += [f"- {c}" for c in BAR_CAVEATS]
    L += ["", "## The run", "", f"- commit: `{a.commit}`", f"- settings (both sides): {a.settings}",
          f"- provider that ran on the Mac (engine replies): {', '.join(mac_providers) or 'none'}",
          # loop: NOT-WORTH — the gate's few clips
          f"- reference provider (engine replies): {', '.join(sorted({provider(ref[c]) for c in clips if c in ref})) or 'none'}", ""]
    L += ["## The Mac", ""]
    # loop: NOT-WORTH — a dozen preflight facts
    L += [f"- {k}: {v}" for k, v in fx.items()]
    L += ["", "## Mattes (Mac vs CUDA, float EXR, every frame)", "",
          "| clip | frames | alpha MAE | alpha max | % > 1/255 | % > 4/255 | hair-edge band (0.02-0.98) MAE / % > 1/255 | fg PSNR (all / subject) | bar |",
          "|---|---|---|---|---|---|---|---|---|"]
    # loop: NOT-WORTH — the gate's few clips
    for c in clips:
        k = cmp_rows.get(c)
        if not k:
            L.append(f"| {c} | n/a | | | | | | | no comparison |")
            continue
        band = f"{fmt(k.get('edge_band_mae'), '.2e')} / {fmt(k.get('edge_band_pct_gt_1_255'), '.2f', ' %')}"
        fg = f"{fmt(k.get('fg_psnr_db'), '.1f')} / {fmt(k.get('fg_psnr_subject_db'), '.1f')} dB"
        L.append(f"| {c} | {k['frames']} | {k['alpha_mae']:.2e} | {k['alpha_max']:.2e} | {k['alpha_pct_gt_1_255']:.3f} | "
                 f"{k['alpha_pct_gt_4_255']:.3f} | {band} | {fg} | {'pass' if c in passed else 'FAIL'} |")
    L += ["", "## Speed and memory", "",
          "| clip | side | provider / precision | size | frames | window | load→first frame | steady fps | total | peak RSS | peak VRAM |",
          "|---|---|---|---|---|---|---|---|---|---|---|"]
    # loop: NOT-WORTH — the gate's few clips, two sides each
    for c in clips:
        # loop: NOT-WORTH — the two runs of one clip
        for side, row in (("Mac", mac.get(c)), ("CUDA (this PC)", ref.get(c))):
            if not row:
                continue
            vram = fmt(row.get("peakVramMb", 0) / 1024, ".2f", " GB") if row.get("peakVramMb") else "n/a"
            L.append(f"| {c} | {side} | {provider(row)} / {precision(row)} | {row.get('width', '?')}×{row.get('height', '?')} | "
                     f"{row.get('framesDone')}/{row.get('totalFrames', '?')} | {window(row) or 'n/a'} | {fmt(row.get('firstFrameAt'), '.1f', ' s')} | "
                     f"{fmt(row.get('steadyFps'), '.2f')} | {fmt(row.get('totalS'), '.1f', ' s')} | "
                     f"{fmt((row.get('peakRssMb') or 0) / 1024, '.2f', ' GB')} | {vram} |")
    L += ["", "Peak RSS on the Mac: the engine's process tree sampled with `ps` every 250 ms (unified memory: graphics "
          "memory Core ML holds outside the process is not in it).", ""]
    if sbs:
        L += ["## Side by side (the worst frame of each clip by alpha MAE)", ""]
        # loop: NOT-WORTH — the gate's few clips
        for c, d in sorted(sbs.items()):
            L.append(f"- {c}: [{d}/numbers.md]({d}/numbers.md), [{d}/]({d}/)")
        L.append("")
    if problems:
        # loop: NOT-WORTH — a few problems
        L += ["## Problems", ""] + [f"- {p}" for p in problems] + [""]
    L += [verdict, ""]
    with open(a.out, "w") as f:
        f.write("\n".join(L))
    print(verdict)
    return 0


if __name__ == "__main__":
    sys.exit(main())
