#!/usr/bin/env bash
# Flicker vs the temporal window (BACKLOG row 37): one plate keyed at several Hann windows by our engine, with speed
# and memory (tools/engine_bench.mjs) and temporal stability (tools/temporal_stability.py) per window, in one table.
#
#   tools/window_sweep.sh [--plate CLIP] [--windows 8/4,16/8,24/12,48/24] [options]
#
# Per window: the engine with the run options hann_chunk / hann_stride (docs/ENGINE_PROTOCOL.md), low_vram (default
# true: staged low-memory mode, the same mattes as the normal mode, what lets long windows fit), the same graphics-
# memory budget for all; alpha only, float EXR (no codec noise in a flicker measure). A window that doesn't fit ends
# in the engine's own error (it refuses to go past the budget) and the table says so. Then the stability of the
# matte against the plate, and the EXR frames are deleted (--keep-outputs keeps them).
#
# Options:
#   --plate CLIP         the plate (default ~/Videos/corridorkey-tests/godiva_close.mov, HD: on a 16 GB card 4K fits only
#                        8/4 (BACKLOG row 37, measured 2026-10-24), so the window range is an HD question; a 4K plate
#                        such as 4k/04_5h runs too, and the windows that don't fit say so)
#   --windows L          chunk/stride pairs (default 8/4,16/8,24/12,48/24)
#   --frames N           only the first N frames (default: all)
#   --low-vram B         true | false (default true)
#   --vram-budget GB     the run option vram_budget_gb (default 14: what a 16 GB card leaves for one job)
#   --format F           exr-float (default) | exr-half | video (x264 CRF 12: adds codec noise to the flicker)
#   --engine BIN         default engine-rs/target/dist/corridorkey-engine
#   --models DIR         default ~/.local/share/corridorkey-desktop/models/2.0.0-onnx.4
#   --runtime DIR        default ~/.local/share/corridorkey-desktop/runtime/ort-1.31.0-cuda13
#   --flow-width PX      the stability metric's optical-flow width (default 960)
#   --out DIR            default ~/.cache/claude-scratch/window-sweep/<date>-<plate>
#   --cpu                NO GPU: the engine on the processor (a rehearsal with a tiny plate; numbers not quotable)
#   --keep-outputs       keep each window's EXR frames
#   --dry-run            print the commands; run nothing
#
# GPU (rule 11): refuses while Marcy's Sonata runs and holds ~/.cache/claude-scratch/gpu.lock for each keying.
# Memory: every step under ~/.cache/claude-scratch/tools/memrun.sh in claude-work.slice; keying and the metric also
# take ~/.cache/claude-scratch/heavy.lock (one heavy job at a time).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
SCRATCH="$HOME/.cache/claude-scratch"
PY="${CK_PY:-$SCRATCH/corridorkey-onnx/venv/bin/python}"
MEMRUN="$SCRATCH/tools/memrun.sh"
export CK_SLICE="${CK_SLICE:-claude-work.slice}"
PLATE="$HOME/Videos/corridorkey-tests/godiva_close.mov" WINDOWS="8/4,16/8,24/12,48/24" FRAMES="" LOW=true BUDGET=14 FORMAT=exr-float
ENGINE="$REPO/engine-rs/target/dist/corridorkey-engine"
MODELS="$HOME/.local/share/corridorkey-desktop/models/2.0.0-onnx.4"
RUNTIME="$HOME/.local/share/corridorkey-desktop/runtime/ort-1.31.0-cuda13"
FLOW=960 OUT="" CPU=0 KEEP=0 DRY=0
die() { echo "window_sweep: $*" >&2; exit 1; }
# loop: NOT-WORTH — the command line
while [ $# -gt 0 ]; do
  case "$1" in
    --plate) PLATE=$2; shift 2 ;;
    --windows) WINDOWS=$2; shift 2 ;;
    --frames) FRAMES=$2; shift 2 ;;
    --low-vram) LOW=$2; shift 2 ;;
    --vram-budget) BUDGET=$2; shift 2 ;;
    --format) FORMAT=$2; shift 2 ;;
    --engine) ENGINE=$2; shift 2 ;;
    --models) MODELS=$2; shift 2 ;;
    --runtime) RUNTIME=$2; shift 2 ;;
    --flow-width) FLOW=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --cpu) CPU=1; shift ;;
    --keep-outputs) KEEP=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (--help)" ;;
  esac
done
[ -e "$PLATE" ] || die "no plate at $PLATE"
[[ "$WINDOWS" =~ ^[0-9]+/[0-9]+(,[0-9]+/[0-9]+)*$ ]] || die "--windows wants chunk/stride pairs, e.g. 8/4,16/8"
[[ "$LOW" =~ ^(true|false)$ ]] || die "--low-vram: true | false"
[[ "$FORMAT" =~ ^(exr-float|exr-half|video)$ ]] || die "--format: exr-float | exr-half | video"
[ -z "$FRAMES" ] || [[ "$FRAMES" =~ ^[0-9]+$ ]] || die "--frames wants a number"
[ -x "$ENGINE" ] || die "no engine at $ENGINE (tools/build_engine.sh, or --engine)"
[ -x "$PY" ] || die "no Python with numpy + OpenCV at $PY (set CK_PY)"
[ -x "$MEMRUN" ] || die "no memory guard at $MEMRUN"
ORT=$(ls "$RUNTIME"/onnxruntime/capi/libonnxruntime.so.* 2>/dev/null | head -1)
[ -n "$ORT" ] || die "no ONNX Runtime under $RUNTIME (--runtime)"
LD="$RUNTIME/onnxruntime/capi:$RUNTIME/nvidia/cu13/lib:$RUNTIME/nvidia/cudnn/lib"
NAME=$(basename "${PLATE%/}"); NAME=${NAME%.*}
OUT=${OUT:-$SCRATCH/window-sweep/$(date +%F)-$NAME$([ "$CPU" = 1 ] && echo -cpu)}

run() { printf '+'; printf ' %q' "$@"; printf '\n'; [ "$DRY" = 1 ] || "$@"; }
wait_mem() {
  [ "$DRY" = 1 ] && return 0
  local deadline=$(( $(date +%s) + 3600 )) avail
  # loop: SERIAL-REQUIRED — waits for 16 GB of available memory before a heavy step [bounded: 60 min]
  while :; do
    avail=$(free -g | awk '/^Mem:/ {print $7}')
    [ "$avail" -ge 16 ] && return 0
    [ "$(date +%s)" -lt "$deadline" ] || die "only $avail GB of memory available after 60 min (16 needed)"
    echo "window_sweep: $avail GB available, waiting for 16"
    # loop: SERIAL-REQUIRED — the pause between memory checks [bounded: the loop's deadline]
    sleep 30
  done
}

mkdir -p "$OUT"
case "$FORMAT" in
  exr-float) FMT=(--option 'output_format="exr"' --option 'exr_dtype="float"') ;;
  exr-half) FMT=(--option 'output_format="exr"' --option 'exr_dtype="half"') ;;
  video) FMT=() ;;
esac
if [ "$CPU" = 1 ]; then DEV=(--device cpu --cpu --stall-s 3600); else DEV=(--device cuda --stall-s 900); fi
echo "window_sweep: $NAME, windows $WINDOWS, low_vram $LOW, budget $BUDGET GB, $FORMAT → $OUT"
# loop: SERIAL-REQUIRED — one window at a time on one GPU, then its metric (the EXR frames go before the next)
for w in ${WINDOWS//,/ }; do
  c=${w%/*} s=${w#*/} d="$OUT/w$c-$s"
  echo; echo "== window $c/$s ($(date +%T))"
  run rm -rf "$d"; run mkdir -p "$d"
  wait_mem
  opts=(--vram-budget "$BUDGET" --option "hann_chunk=$c" --option "hann_stride=$s" --option "low_vram=$LOW" --option 'outputs=["alpha"]' "${FMT[@]}")
  [ -z "$FRAMES" ] || opts+=(--option "num_frames=$FRAMES")
  bench=(env NODE_OPTIONS=--max-old-space-size=1024 node "$REPO/tools/engine_bench.mjs" rust --bin "$ENGINE" --models "$MODELS" --ort "$ORT"
    --env "LD_LIBRARY_PATH=$LD" "${DEV[@]}" "${opts[@]}" --out "$d" "$PLATE")
  if [ "$CPU" = 1 ]; then
    run flock "$SCRATCH/heavy.lock" "$MEMRUN" 12 env CUDA_VISIBLE_DEVICES= "${bench[@]}"
  else
    sonata=$(pgrep -fai 'mount_sonata|Sonata.AppImage' | grep -v -e claude-scratch -e pgrep || true)
    [ -z "$sonata" ] || die "Marcy's Sonata is running ($sonata): no GPU work now (finished windows are kept in $OUT)"
    run flock "$SCRATCH/heavy.lock" "$MEMRUN" 18 flock "$SCRATCH/gpu.lock" "${bench[@]}"
  fi
  if [ "$DRY" = 1 ] || [ -d "$d/out/$NAME" ]; then
    metric=(flock "$SCRATCH/heavy.lock" "$MEMRUN" 8 "$PY" -I "$REPO/tools/temporal_stability.py" "$d/out/$NAME" --input "$PLATE"
      ${FRAMES:+--frames "$FRAMES"} --flow-width "$FLOW" --name "$c/$s" --json "$d/stability.json" --csv "$d/stability.csv")
    if [ "$DRY" = 1 ]; then run "${metric[@]}"
    else run "${metric[@]}" >"$d/stability.log" 2>&1 || echo "window $c/$s: the stability metric failed (see $d/stability.log)"; fi
  else
    echo "window $c/$s: no outputs (the engine's error is in $d/bench.json)"
  fi
  [ "$KEEP" = 1 ] || run rm -rf "$d/out" "$d/tmp"
done

[ "$DRY" = 1 ] && exit 0
"$PY" -I - "$OUT" "$WINDOWS" "$NAME" "$LOW" "$BUDGET" "$FORMAT" "$CPU" <<'PYEOF'
import json, os, sys
out, windows, name, low, budget, fmt, cpu = sys.argv[1:8]


def load(p):
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return None


def n(v, spec):
    return "n/a" if v is None else f"{v:{spec}}"


L = [f"# Flicker vs the temporal window: {name}", ""]
if cpu == "1":
    L += ["> REHEARSAL on the processor with a tiny plate: proves the tool, not a measurement.", ""]
L += [f"Our engine, low_vram {low}, {budget} GB budget, alpha only, {fmt}; stability by tools/temporal_stability.py "
      "(alpha units 0-1; lower is steadier; flow-compensated numbers hold flow error too, so compare windows, not absolutes).", "",
      "| Window | Result | Total | First frames | Steady fps | Peak VRAM | Peak RAM | Static | Static, hair edge (% > 1/255) | Moving, flow-comp., edge | Sizzle, edge |",
      "|---|---|---|---|---|---|---|---|---|---|---|"]
rows = []
# loop: NOT-WORTH — a handful of windows
for w in windows.split(","):
    c, s = w.split("/")
    d = os.path.join(out, f"w{c}-{s}")
    b = (load(os.path.join(d, "bench.json")) or {}).get("rows", [{}])[0] if load(os.path.join(d, "bench.json")) else {}
    st = load(os.path.join(d, "stability.json")) or {}
    g = lambda k, f="mean": (st.get(k) or {}).get(f)  # noqa: E731
    res = b.get("error") or ("ok" if b.get("exit") == 0 else f"exit {b.get('exit')}") if b else "not run"
    L.append(f"| {c}/{s} | {res} | {n(b.get('totalS'), '.1f')} s | {n(b.get('firstFrameAt'), '.1f')} s | {n(b.get('steadyFps'), '.2f')} | "
             f"{n((b.get('peakVramMb') or 0) / 1024 if b else None, '.2f')} GiB | {n((b.get('peakRssMb') or 0) / 1024 if b else None, '.2f')} GiB | "
             f"{n(g('static'), '.2e')} | {n(g('static_edge'), '.2e')} ({n(g('static_edge', 'pct_gt'), '.2f')} %) | "
             f"{n(g('moving_flow_edge'), '.2e')} | {n(g('sizzle_edge'), '.2e')} |")
    rows.append({"window": w, "bench": b, "stability": st})
text = "\n".join(L) + "\n"
open(os.path.join(out, "results.md"), "w").write(text)
json.dump(rows, open(os.path.join(out, "results.json"), "w"), indent=2, default=str)
print(text)
PYEOF
echo "window_sweep: $OUT/results.md"
