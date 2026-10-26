#!/usr/bin/env bash
# The objective comparison with CorridorKey 2.0 (BACKLOG row 36): one command, same machine, same clips, same
# settings, a report folder with the "vs CorridorKey 2.0" scorecard (report.md) across six axes.
#
#   tools/vs_original.sh [--quick] [--blind] [options]
#
# Steps (each writes into the report folder and marks itself done, so a re-run picks up where it stopped):
#   speed       both engines on every clip, --repeats times (order alternating per repeat), tools/engine_bench.mjs
#               --warm: cold = a new engine process (model load included), warm = the same clip as a second job in
#               that process. Total (start → result), first frames (start → first finished frames: load + the
#               first window, never the total), steady fps, peak graphics memory, peak RAM, CPU time. Videos, as the
#               user gets them. The outputs are deleted after each repeat (the formats are recorded first).
#   quality     per clip: the original twice (run A, run B) and ours once, float EXR outputs (no codec in between);
#               tools/matte_compare.py: ours vs A, B vs A (the run-to-run floor), and the same on the first N frames
#               when the precision floor covers only N; a side-by-side of the worst frame (tools/side_by_side.py);
#               with --blind the A/B pairs. The EXR outputs are deleted after each clip (--keep-outputs keeps them).
#   floor       the precision floor: the original's model in fp32 against bf16 autocast, through
#               <original>/scripts/onnx_spike/run_parity.py (Corridor's model code unchanged; the original's runtime
#               has no fp32 switch), at the window the original used, on all frames (HD) / the first 24 (4K; fp32 at
#               4K is heavy: the spike stops itself at 12 GiB of graphics memory, and the case then says so).
#   resources   install and download size of both (the README's Install size method: du, decimal GB).
#   capability  the static capability table, filled from facts checked where they can be: the outputs' formats
#               (ffprobe / OpenEXR), 4K on this 16 GB card, and the smallest memory budget that finishes (a sweep,
#               --budget-sweep, first 24 frames of the first HD clip and the first 4K plate).
#   robust      tools/vs_original_robust.py: out of memory, cancel, cancel a queued job, damaged file, not a
#               video, full output disk, long queue; ours and the original through the protocol, the original also
#               through infer.py where it can be.
#   report      tools/vs_original_report.py build → report.md + scorecard.json.
#
# Options:
#   --quick              a rehearsal on the GPU: one HD clip (with_motion_blur), one 4K plate (04_5d), one repeat,
#                        a 3-budget sweep, an 8-job queue
#   --rehearse           NO GPU: ours on the processor (--device cpu) for both columns (a stand-in for the original,
#                        which needs CUDA), the precision floor on the processor; for proving the tool with tiny
#                        clips (--clips); the report is marked as a rehearsal, never a measurement
#   --blind              blind A/B pairs (labels A/B, order shuffled per clip; the key in <out>.blind-key/key.json)
#   --original-root DIR  the CorridorKey2.0 checkout (default ~/projects/CorridorKey2.0)
#   --python PY          its venv's Python (default <original-root>/venv/bin/python)
#   --out DIR            the report folder (default ~/.cache/claude-scratch/vs-original/<date>-<commit>[-quick])
#   --clips A,B,...      clips instead of the default set (a folder counts as a 4K plate, a file as HD)
#   --repeats N          speed repeats (default 3; --quick 1)
#   --vram-budget GB     the run option vram_budget_gb for both (default 12, the README's)
#   --frames N           key only the first N frames of every clip (default: all)
#   --floor-frames-4k N  precision-floor frames on 4K plates (default 24; HD: all)
#   --budget-sweep L     budgets for the capability sweep (default 4,6,8; --quick 4,8)
#   --queue N            jobs in the long-queue case (default 20; --quick 8)
#   --engine BIN         our engine (default engine-rs/target/dist/corridorkey-engine)
#   --models DIR         our model set (default ~/.local/share/corridorkey-desktop/models/2.0.0-onnx.4)
#   --runtime DIR        our ONNX Runtime folder (default ~/.local/share/corridorkey-desktop/runtime/ort-1.31.0-cuda13)
#   --appimage FILE      the AppImage whose size is reported (default: the newest under ~/Applications)
#   --mem-original GB    memory cap of the original's runs (default 24 with a 4K plate, else 16); ours 18 / 12
#   --mem-wait-min M     wait up to M minutes for 16 GB of available memory before a heavy step (default 60)
#   --keep-outputs       keep the quality runs' EXR outputs
#   --steps a,b,...      only these steps (default all; e.g. --steps report)
#   --fresh              redo steps already marked done
#   --dry-run            print every command; run nothing
#
# GPU (rule 11): refuses while Marcy's Sonata runs (pgrep -fai 'mount_sonata|Sonata.AppImage') and holds
# ~/.cache/claude-scratch/gpu.lock for every GPU step; engine_bench also pauses between clips while another process
# holds graphics memory. Memory: every step runs under ~/.cache/claude-scratch/tools/memrun.sh in claude-work.slice
# and, when heavy, ~/.cache/claude-scratch/heavy.lock (one heavy job at a time).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
SCRATCH="$HOME/.cache/claude-scratch"
PY="${CK_PY:-$SCRATCH/corridorkey-onnx/venv/bin/python}"
MEMRUN="$SCRATCH/tools/memrun.sh"
export CK_SLICE="${CK_SLICE:-claude-work.slice}"
T="$HOME/Videos/corridorkey-tests"
ORIG_ROOT="$HOME/projects/CorridorKey2.0" ORIG_PY="" OUT="" CLIPS="" FRAMES="" STEPS=all
ENGINE="$REPO/engine-rs/target/dist/corridorkey-engine"
MODELS="$HOME/.local/share/corridorkey-desktop/models/2.0.0-onnx.4"
RUNTIME="$HOME/.local/share/corridorkey-desktop/runtime/ort-1.31.0-cuda13"
APPIMAGE="" QUICK=0 REHEARSE=0 BLIND=0 REPEATS="" BUDGET=12 FLOOR_4K=24 SWEEP="" QUEUE="" MEM_ORIG="" MEM_WAIT_MIN=60
KEEP=0 FRESH=0 DRY=0
die() { echo "vs_original: $*" >&2; exit 1; }
# loop: NOT-WORTH — the command line
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1; shift ;;
    --rehearse) REHEARSE=1; shift ;;
    --blind) BLIND=1; shift ;;
    --original-root) ORIG_ROOT=$2; shift 2 ;;
    --python) ORIG_PY=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --clips) CLIPS=$2; shift 2 ;;
    --repeats) REPEATS=$2; shift 2 ;;
    --vram-budget) BUDGET=$2; shift 2 ;;
    --frames) FRAMES=$2; shift 2 ;;
    --floor-frames-4k) FLOOR_4K=$2; shift 2 ;;
    --budget-sweep) SWEEP=$2; shift 2 ;;
    --queue) QUEUE=$2; shift 2 ;;
    --engine) ENGINE=$2; shift 2 ;;
    --models) MODELS=$2; shift 2 ;;
    --runtime) RUNTIME=$2; shift 2 ;;
    --appimage) APPIMAGE=$2; shift 2 ;;
    --mem-original) MEM_ORIG=$2; shift 2 ;;
    --mem-wait-min) MEM_WAIT_MIN=$2; shift 2 ;;
    --keep-outputs) KEEP=1; shift ;;
    --steps) STEPS=$2; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (--help)" ;;
  esac
done
ORIG_PY=${ORIG_PY:-$ORIG_ROOT/venv/bin/python}
REPEATS=${REPEATS:-$([ "$QUICK" = 1 ] || [ "$REHEARSE" = 1 ] && echo 1 || echo 3)}
SWEEP=${SWEEP:-$([ "$QUICK" = 1 ] && echo 4,8 || echo 4,6,8)}
QUEUE=${QUEUE:-$([ "$QUICK" = 1 ] && echo 8 || { [ "$REHEARSE" = 1 ] && echo 3 || echo 20; })}
[[ "$REPEATS" =~ ^[1-9][0-9]*$ ]] || die "--repeats wants a number ≥ 1"
[ -z "$FRAMES" ] || [[ "$FRAMES" =~ ^[0-9]+$ ]] || die "--frames wants a number"
[[ "$SWEEP" =~ ^[0-9.]+(,[0-9.]+)*$ ]] || die "--budget-sweep wants numbers, e.g. 4,6,8"
[[ "$BUDGET" =~ ^[0-9.]+$ ]] || die "--vram-budget wants a number"

# ---- the clips: name, path, kind (a folder = a 4K plate, a file = HD)
CLIP_PATHS=() CLIP_NAMES=() CLIP_KINDS=()
if [ -n "$CLIPS" ]; then
  IFS=, read -r -a list <<<"$CLIPS"
elif [ "$QUICK" = 1 ]; then
  list=("$T/with_motion_blur.mov" "$T/4k/04_5d")
else
  list=("$T"/*.mov "$T"/4k/04_5h "$T"/4k/04_5d "$T"/4k/08_3a "$T"/4k/04_2c)
fi
# loop: NOT-WORTH — the scorecard's clips (≤ 10)
for c in "${list[@]}"; do
  [ -e "$c" ] || die "clip not found: $c"
  b=$(basename "${c%/}"); CLIP_PATHS+=("${c%/}"); CLIP_NAMES+=("${b%.*}")
  if [ -d "$c" ]; then CLIP_KINDS+=(4k); else CLIP_KINDS+=(hd); fi
done
HAS_4K=0
# loop: NOT-WORTH — the scorecard's clips
for k in "${CLIP_KINDS[@]}"; do [ "$k" = 4k ] && HAS_4K=1; done
SHORT="" BIG=""
# loop: NOT-WORTH — the scorecard's clips: the short HD clip for robustness (with_motion_blur when there), the first 4K plate
for i in "${!CLIP_PATHS[@]}"; do
  if [ "${CLIP_KINDS[$i]}" = hd ] && { [ -z "$SHORT" ] || [ "${CLIP_NAMES[$i]}" = with_motion_blur ]; }; then SHORT=${CLIP_PATHS[$i]}; fi
  if [ "${CLIP_KINDS[$i]}" = 4k ] && [ -z "$BIG" ]; then BIG=${CLIP_PATHS[$i]}; fi
done
SHORT=${SHORT:-${CLIP_PATHS[0]}}

# ---- engines and tools
COMMIT=$(git -C "$REPO" rev-parse HEAD)
MODE=$([ "$REHEARSE" = 1 ] && echo rehearse || { [ "$QUICK" = 1 ] && echo quick || echo full; })
OUT=${OUT:-$SCRATCH/vs-original/$(date +%F)-${COMMIT:0:10}$([ "$MODE" = full ] || echo "-$MODE")}
KEY_DIR="${OUT%/}.blind-key"
[ -x "$ENGINE" ] || die "no engine at $ENGINE (tools/build_engine.sh, or --engine)"
[ -f "$MODELS/manifest.json" ] || [ -f "$MODELS/models.json" ] || die "no model set at $MODELS (--models)"
ORT=$(ls "$RUNTIME"/onnxruntime/capi/libonnxruntime.so.* 2>/dev/null | head -1)
[ -n "$ORT" ] || die "no ONNX Runtime under $RUNTIME (--runtime)"
LD="$RUNTIME/onnxruntime/capi:$RUNTIME/nvidia/cu13/lib:$RUNTIME/nvidia/cudnn/lib"
[ -x "$PY" ] || die "no Python with numpy + OpenCV at $PY (set CK_PY)"
[ -x "$MEMRUN" ] || die "no memory guard at $MEMRUN"
if [ "$REHEARSE" = 0 ]; then
  [ -x "$ORIG_PY" ] || die "no Python for the original at $ORIG_PY (--python)"
  [ -f "$ORIG_ROOT/infer.py" ] || die "no CorridorKey2.0 checkout at $ORIG_ROOT (--original-root)"
fi
SPIKE="$ORIG_ROOT/scripts/onnx_spike/run_parity.py"
if [ "$REHEARSE" = 1 ]; then
  OURS_BENCH=(rust --bin "$ENGINE" --models "$MODELS" --ort "$ORT" --env "LD_LIBRARY_PATH=$LD" --device cpu --cpu --stall-s 3600)
  ORIG_BENCH=("${OURS_BENCH[@]}")  # the stand-in: the original needs CUDA
  OURS_CMD=("$ENGINE" --models "$MODELS" --ort "$ORT" --device cpu)
  MEM_OURS=12 MEM_ORIG=${MEM_ORIG:-12}
else
  OURS_BENCH=(rust --bin "$ENGINE" --models "$MODELS" --ort "$ORT" --env "LD_LIBRARY_PATH=$LD" --device cuda --stall-s 900)
  ORIG_BENCH=(python --python "$ORIG_PY" --script "$REPO/engine/ck_engine.py" --package-root "$ORIG_ROOT" --stall-s 900)
  OURS_CMD=("$ENGINE" --models "$MODELS" --ort "$ORT" --device cuda)
  MEM_OURS=$([ "$HAS_4K" = 1 ] && echo 18 || echo 12)
  MEM_ORIG=${MEM_ORIG:-$([ "$HAS_4K" = 1 ] && echo 24 || echo 16)}
fi
SETTINGS_OPTS=(--vram-budget "$BUDGET")
[ -z "$FRAMES" ] || SETTINGS_OPTS+=(--option "num_frames=$FRAMES")
SETTINGS="${BUDGET} GB graphics-memory budget, automatic temporal window, alpha + foreground, no hint${FRAMES:+, first $FRAMES frames}"

step() { printf '\n== %s (%s)\n' "$*" "$(date +%T)"; }
run() { printf '+'; printf ' %q' "$@"; printf '\n'; [ "$DRY" = 1 ] || "$@"; }
# CK_GPU_IGNORE_SONATA=1: only on Marcy's word that Sonata won't be used (2026-10-26); printed when it applies
sonata() {
  local s; s=$(pgrep -fai 'mount_sonata|Sonata.AppImage' | grep -v -e claude-scratch -e pgrep || true)
  if [ -n "$s" ] && [ "${CK_GPU_IGNORE_SONATA:-}" = 1 ]; then echo "GPU guard: Sonata is running, ignored: CK_GPU_IGNORE_SONATA=1" >&2; return; fi
  printf '%s' "$s"
}
wait_mem() {
  [ "$DRY" = 1 ] && return 0
  local deadline=$(( $(date +%s) + MEM_WAIT_MIN * 60 )) avail
  # loop: SERIAL-REQUIRED — waits for 16 GB of available memory before a heavy step [bounded: --mem-wait-min]
  while :; do
    avail=$(free -g | awk '/^Mem:/ {print $7}')
    [ "$avail" -ge 16 ] && return 0
    [ "$(date +%s)" -lt "$deadline" ] || die "only $avail GB of memory available after $MEM_WAIT_MIN min (16 needed); stopping"
    echo "vs_original: $avail GB of memory available, waiting for 16"
    # loop: SERIAL-REQUIRED — the pause between memory checks [bounded: the loop's deadline]
    sleep 30
  done
}
# a GPU step: one heavy job at a time, memory-capped, the GPU lock (none in a rehearsal: no GPU at all)
gpu() { # GB cmd...
  local gb=$1; shift
  wait_mem
  if [ "$REHEARSE" = 1 ]; then
    run flock "$SCRATCH/heavy.lock" "$MEMRUN" "$gb" env CUDA_VISIBLE_DEVICES= "$@"
  else
    local s; s=$(sonata)
    [ -z "$s" ] || die "Marcy's Sonata is running ($s): no GPU work now; re-run later (finished steps are kept)"
    run flock "$SCRATCH/heavy.lock" "$MEMRUN" "$gb" flock "$SCRATCH/gpu.lock" "$@"
  fi
}
heavy() { local gb=$1; shift; wait_mem; run flock "$SCRATCH/heavy.lock" "$MEMRUN" "$gb" "$@"; }
light() { local gb=$1; shift; run "$MEMRUN" "$gb" "$@"; }
done_mark() { [ "$FRESH" = 0 ] && [ -f "$1/.done" ]; }
bench() { # engine(original|ours) out-dir extra-args... -- clips...
  local eng=$1 out=$2; shift 2
  local -a args
  if [ "$eng" = ours ]; then args=("${OURS_BENCH[@]}"); else args=("${ORIG_BENCH[@]}"); fi
  gpu "$([ "$eng" = ours ] && echo "$MEM_OURS" || echo "$MEM_ORIG")" env NODE_OPTIONS=--max-old-space-size=1024 \
    node "$REPO/tools/engine_bench.mjs" "${args[@]}" "${SETTINGS_OPTS[@]}" --out "$out" "$@"
}
# a bench row's field (python reads it: bench.json may hold Infinity) — prints "" when missing
row() { # bench.json clip expr
  [ "$DRY" = 1 ] && return 0
  "$PY" -I -c 'import json,sys
b=json.load(open(sys.argv[1])); r=[r for r in b["rows"] if r["clip"]==sys.argv[2]]
r=r[0] if r else {}
v=eval(sys.argv[3], {}, {"r": r})
print("" if v is None else v)' "$1" "$2" "$3" 2>/dev/null || true
}

mkdir -p "$OUT"
[ "$DRY" = 1 ] || exec > >(tee -a "$OUT/run.log") 2>&1
echo "vs_original: $MODE run, ${#CLIP_PATHS[@]} clips (${CLIP_NAMES[*]}), $REPEATS repeat(s) → $OUT"
[ "$REHEARSE" = 0 ] || echo "vs_original: REHEARSAL on the processor: the 'original' columns are our engine again; nothing here is a measurement"

# ---- meta.json: what, where, which machine
if [ "$DRY" = 0 ]; then
  gpu_line=""; torch_v=""
  if [ "$REHEARSE" = 0 ]; then
    gpu_line=$(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null | head -1 || true)
    torch_v=$(light 4 "$ORIG_PY" -I -c 'import torch; print(torch.__version__, "CUDA", torch.version.cuda)' 2>/dev/null | tail -1 || true)
  fi
  clips_json=$("$PY" -I -c 'import json,sys; a=sys.argv[1:]; n=len(a)//3; print(json.dumps([{"name":a[i],"path":a[n+i],"kind":a[2*n+i]} for i in range(n)]))' \
    "${CLIP_NAMES[@]}" "${CLIP_PATHS[@]}" "${CLIP_KINDS[@]}")
  "$PY" -I - "$OUT/meta.json" <<PYEOF
import json, platform, sys
cpu = next((l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name")), "?")  # loop: NOT-WORTH — the cpuinfo lines, once
osn = next((l.split("=", 1)[1].strip().strip('"') for l in open("/etc/os-release") if l.startswith("PRETTY_NAME")), "?")  # loop: NOT-WORTH — a few lines, once
mem = round(int(open("/proc/meminfo").readline().split()[1]) / 2**20)
json.dump({"commit": "$COMMIT", "date": "$(date +%F)", "mode": "$MODE", "repeats": $REPEATS, "settings": "$SETTINGS",
           "clips": json.loads('''$clips_json'''), "blind_key": "$KEY_DIR/key.json" if $BLIND else None,
           "machine": {"Graphics card": "${gpu_line:-n/a (rehearsal: no GPU used)}", "Processor, memory": f"{cpu}, {mem} GiB RAM",
                       "System": f"{osn}, Linux {platform.release()}",
                       "Original CorridorKey 2.0": "${torch_v:+PyTorch $torch_v, bf16 autocast (its shipping mode)}" or "n/a (rehearsal)",
                       "CorridorKey Desktop": "Rust engine on ONNX Runtime ($(basename "$RUNTIME")), models $(basename "$MODELS")"}},
          open(sys.argv[1], "w"), indent=2)
PYEOF
fi

want() { [ "$STEPS" = all ] || [[ ",$STEPS," == *",$1,"* ]]; }

# ---- speed
s_speed() {
  step "speed: both engines, ${#CLIP_PATHS[@]} clips, $REPEATS repeat(s), cold + warm"
  local rep eng d
  # loop: SERIAL-REQUIRED — repeats one after the other on one GPU
  for rep in $(seq 1 "$REPEATS"); do
    local order=(original ours)
    [ $((rep % 2)) = 0 ] && order=(ours original)
    # loop: SERIAL-REQUIRED — one engine at a time on one GPU (order alternates per repeat)
    for eng in "${order[@]}"; do
      d="$OUT/speed/$eng/rep$rep"
      if done_mark "$d"; then echo "speed $eng rep$rep: done before"; continue; fi
      run rm -rf "$d"; run mkdir -p "$d"
      bench "$eng" "$d" --warm "${CLIP_PATHS[@]}"
      if [ "$rep" = 1 ] && [ "$DRY" = 0 ]; then
        mkdir -p "$OUT/formats"
        # loop: NOT-WORTH — the scorecard's clips, one ffprobe each
        for n in "${CLIP_NAMES[@]}"; do
          [ -d "$d/out/$n" ] && light 2 "$PY" -I "$REPO/tools/vs_original_report.py" formats "$d/out/$n" >"$OUT/formats/$eng-video-$n.json" || true
        done
      fi
      run rm -rf "$d/out" "$d/out-warm" "$d/tmp"
      [ "$DRY" = 1 ] || touch "$d/.done"
    done
  done
}

# ---- quality (+ blind pairs)
blind_pair() { # name origdir oursdir frames...
  local name=$1 o=$2 u=$3; shift 3
  local coin; coin=$(od -An -N1 -tu1 /dev/urandom | tr -d ' ')
  local a=$o b=$u ka=original kb=ours
  if [ $((coin % 2)) = 1 ]; then a=$u b=$o ka=ours kb=original; fi
  heavy 8 "$PY" -I "$REPO/tools/side_by_side.py" "$a" "$b" --out "$OUT/blind/$name" --labels A B --blind --frames "$@"
  [ "$DRY" = 1 ] && return 0
  mkdir -p "$KEY_DIR"
  "$PY" -I -c 'import json,os,sys; p=sys.argv[1]; k=json.load(open(p)) if os.path.exists(p) else {}; k[sys.argv[2]]={"A":sys.argv[3],"B":sys.argv[4]}; json.dump(k,open(p,"w"),indent=2)' \
    "$KEY_DIR/key.json" "$name" "$ka" "$kb"
}
s_quality() {
  step "quality: per clip the original twice + ours, float EXR, compared exactly"
  local i name qd run eng nf kind
  # loop: SERIAL-REQUIRED — one clip at a time (disk: its EXR outputs are deleted before the next)
  for i in "${!CLIP_PATHS[@]}"; do
    name=${CLIP_NAMES[$i]} kind=${CLIP_KINDS[$i]} qd="$OUT/quality/${CLIP_NAMES[$i]}"
    if done_mark "$qd"; then echo "quality $name: done before"; continue; fi
    run rm -rf "$qd"; run mkdir -p "$qd"
    # loop: SERIAL-REQUIRED — three runs on one GPU
    for run in origA origB ours; do
      eng=$([ "$run" = ours ] && echo ours || echo original)
      bench "$eng" "$qd/$run" --option 'output_format="exr"' --option 'exr_dtype="float"' "${CLIP_PATHS[$i]}"
      if [ "$DRY" = 0 ] && [ ! -d "$qd/$run/out/$name" ]; then
        echo "$run failed: $(row "$qd/$run/bench.json" "$name" 'r.get("error")')" >"$qd/status.txt"
      fi
    done
    if [ -f "$qd/status.txt" ]; then echo "quality $name: $(cat "$qd/status.txt")"; touch "$qd/.done"; continue; fi
    heavy 8 "$PY" -I "$REPO/tools/matte_compare.py" "$qd/origA/out/$name" "$qd/ours/out/$name" --json "$qd/compare.json"
    heavy 8 "$PY" -I "$REPO/tools/matte_compare.py" "$qd/origA/out/$name" "$qd/origB/out/$name" --json "$qd/rr.json"
    nf=$([ "$kind" = 4k ] && echo "$FLOOR_4K" || echo 0)
    [ "$REHEARSE" = 0 ] || nf=4
    if [ "$nf" != 0 ]; then
      heavy 8 "$PY" -I "$REPO/tools/matte_compare.py" "$qd/origA/out/$name" "$qd/ours/out/$name" --frames "$nf" --json "$qd/compare_n.json"
      heavy 8 "$PY" -I "$REPO/tools/matte_compare.py" "$qd/origA/out/$name" "$qd/origB/out/$name" --frames "$nf" --json "$qd/rr_n.json"
    fi
    if [ "$DRY" = 0 ]; then
      mkdir -p "$OUT/formats"
      light 2 "$PY" -I "$REPO/tools/vs_original_report.py" formats "$qd/ours/out/$name" >"$OUT/formats/ours-exr-$name.json" || true
      light 2 "$PY" -I "$REPO/tools/vs_original_report.py" formats "$qd/origA/out/$name" >"$OUT/formats/original-exr-$name.json" || true
    fi
    local worst=0 total=1
    if [ "$DRY" = 0 ]; then
      worst=$("$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["worst_frame"])' "$qd/compare.json")
      total=$("$PY" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["frames"])' "$qd/compare.json")
    fi
    heavy 8 "$PY" -I "$REPO/tools/side_by_side.py" "$qd/origA/out/$name" "$qd/ours/out/$name" --out "$OUT/side_by_side/$name" \
      --labels "CorridorKey 2.0" "CorridorKey Desktop" --frames "$worst"
    if [ "$BLIND" = 1 ]; then
      local mid=$((total / 2))
      if [ "$mid" = "$worst" ]; then blind_pair "$name" "$qd/origA/out/$name" "$qd/ours/out/$name" "$worst"
      else blind_pair "$name" "$qd/origA/out/$name" "$qd/ours/out/$name" "$worst" "$mid"; fi
    fi
    [ "$KEEP" = 1 ] || run rm -rf "$qd/origA/out" "$qd/origB/out" "$qd/ours/out" "$qd/origA/tmp" "$qd/origB/tmp" "$qd/ours/tmp"
    [ "$DRY" = 1 ] || touch "$qd/.done"
  done
}

# ---- the precision floor
s_floor() {
  step "floor: the original's model in fp32 vs bf16 (scripts/onnx_spike/run_parity.py)"
  local i name kind fd nf src chunk stride low dev
  # loop: SERIAL-REQUIRED — one clip at a time on one GPU
  for i in "${!CLIP_PATHS[@]}"; do
    name=${CLIP_NAMES[$i]} kind=${CLIP_KINDS[$i]} fd="$OUT/floor/${CLIP_NAMES[$i]}"
    if done_mark "$fd"; then echo "floor $name: done before"; continue; fi
    run rm -rf "$fd"; run mkdir -p "$fd"
    if [ ! -f "$SPIKE" ]; then echo "no $SPIKE in this checkout" >"$fd/status.txt"; touch "$fd/.done"; continue; fi
    nf=$([ "$kind" = 4k ] && echo "$FLOOR_4K" || echo 0)
    [ "$REHEARSE" = 0 ] || nf=4
    # with --frames, never more than the runs keyed
    if [ -n "$FRAMES" ] && { [ "$nf" = 0 ] || [ "$nf" -gt "$FRAMES" ]; }; then nf=$FRAMES; fi
    # the window the original used for this clip (its quality run A, else its first speed run)
    local b="$OUT/quality/$name/origA/bench.json"
    [ -f "$b" ] || b="$OUT/speed/original/rep1/bench.json"
    chunk=$(row "$b" "$name" '(r.get("memory") or {}).get("hann_chunk")')
    stride=$(row "$b" "$name" '(r.get("memory") or {}).get("hann_stride")')
    low=$(row "$b" "$name" '(r.get("memory") or {}).get("low_vram")')
    if [ "$DRY" = 0 ] && [ -z "$chunk" ]; then echo "no window known (run the quality or speed step first)" >"$fd/status.txt"; touch "$fd/.done"; continue; fi
    # a frame folder for the spike: a 4K plate as it is, a video as 16-bit PNG frames (exactly its values)
    src=${CLIP_PATHS[$i]}
    if [ "$kind" = hd ]; then
      run mkdir -p "$fd/frames"
      local -a lim=()
      [ "$nf" = 0 ] || lim=(-frames:v "$nf")
      heavy 6 ffmpeg -v error -nostdin -y -i "${CLIP_PATHS[$i]}" "${lim[@]}" -pix_fmt rgb48be "$fd/frames/%05d.png"
      src="$fd/frames"
    fi
    dev=$([ "$REHEARSE" = 1 ] && echo cpu || echo cuda)
    local -a extra=(--device "$dev" --frames "$([ "$nf" = 0 ] && echo -1 || echo "$nf")" --chunk "${chunk:-8}" --stride "${stride:-4}")
    [ "$low" = True ] && extra+=(--low-vram)
    local ok=1 amp
    # loop: SERIAL-REQUIRED — two precisions on one GPU
    for amp in fp32 bf16; do
      if [ "$DRY" = 1 ]; then gpu 24 "$ORIG_PY" -E -s "$SPIKE" torch "$src" "$fd/$amp.npz" --amp "$amp" "${extra[@]}"; continue; fi
      if ! gpu "$([ "$REHEARSE" = 1 ] && echo 16 || echo 24)" "$ORIG_PY" -E -s "$SPIKE" torch "$src" "$fd/$amp.npz" --amp "$amp" "${extra[@]}" >"$fd/$amp.log" 2>&1; then
        ok=0; echo "the $amp run failed: $(tail -1 "$fd/$amp.log" | cut -c1-200)" >"$fd/status.txt"; break
      fi
    done
    if [ "$ok" = 1 ]; then
      heavy 8 "$PY" -I "$REPO/tools/matte_compare.py" "$fd/fp32.npz" "$fd/bf16.npz" --json "$fd/precision.json"
      [ "$DRY" = 1 ] || "$PY" -I -c 'import json,sys; json.dump({"frames": None if sys.argv[2]=="0" else int(sys.argv[2]), "chunk": sys.argv[3], "stride": sys.argv[4], "low_vram": sys.argv[5]=="True", "device": sys.argv[6]}, open(sys.argv[1],"w"))' \
        "$fd/meta.json" "$nf" "$chunk" "$stride" "$low" "$dev"
    fi
    [ "$KEEP" = 1 ] || run rm -rf "$fd/frames" "$fd/fp32.npz" "$fd/bf16.npz"
    [ "$DRY" = 1 ] || touch "$fd/.done"
  done
}

# ---- resources: install and download size
du_b() { # bytes on disk of paths (the README's du --si method, in bytes)
  [ "$DRY" = 1 ] && { echo 0; return; }
  local t=0 p
  # loop: NOT-WORTH — a few install folders, du once each [bounded: du over a local folder]
  for p in "$@"; do [ -e "$p" ] && t=$((t + $(du -s -B1 -L "$p" | cut -f1))); done
  echo "$t"
}
s_resources() {
  step "resources: install and download size"
  local app="$APPIMAGE"
  [ -n "$app" ] || app=$(ls -t "$HOME"/Applications/*.AppImage 2>/dev/null | head -1 || true)
  local o_app o_rt o_models c_code c_venv c_models dl
  o_app=$([ -n "$app" ] && du_b "$app" || echo "")
  o_rt=$(du_b "$RUNTIME"); o_models=$(du_b "$MODELS")
  c_code=0; c_venv=0; c_models=0
  if [ "$REHEARSE" = 0 ] || [ -d "$ORIG_ROOT" ]; then
    # the original's code: the checkout without its venv, weights, foundation models and git history
    [ "$DRY" = 1 ] || c_code=$(du -s -B1 --exclude=venv --exclude=weights --exclude=vfms --exclude=.git "$ORIG_ROOT" | cut -f1)
    c_venv=$(du_b "$ORIG_ROOT/venv"); c_models=$(du_b "$ORIG_ROOT/weights" "$ORIG_ROOT/vfms")
  fi
  [ "$DRY" = 1 ] && return 0
  dl=$("$PY" -I "$REPO/tools/vs_original_report.py" sizes "$REPO/electron/main/install.ts")
  "$PY" -I - "$OUT/resources.json" "${o_app:-null}" "$o_rt" "$o_models" "$c_code" "$c_venv" "$c_models" "$dl" "${app:-}" <<'PYEOF'
import json, sys
out, oa, ort, om, cc, cv, cm, dl, app = sys.argv[1:10]
n = lambda v: None if v in ("", "null") else int(v)  # noqa: E731
d = json.loads(dl)
ours = {"app": n(oa), "runtime": n(ort), "models": n(om)}
orig = {"app": n(cc), "runtime": n(cv), "models": n(cm)}
for x in (ours, orig):  # loop: NOT-WORTH — two products
    x["total"] = sum(v for v in x.values() if v) or None  # loop: NOT-WORTH — three parts
notes = [] if app else ["No AppImage found (--appimage): the app's own size is missing from the total."]
json.dump({"install": {"ours": ours, "original": orig, "appimage": app or None},
           "download": {"ours_bytes": d["total_bytes"], "ours_runtime_bytes": d["runtime_bytes"], "ours_models_bytes": d["models_bytes"],
                        "original_weights_bytes": orig["models"]}, "notes": notes}, open(out, "w"), indent=2)
PYEOF
  echo "resources: $OUT/resources.json"
}

# ---- capability: the budget sweep, then the table
s_capability() {
  step "capability: the smallest budget that finishes ($SWEEP GB), formats, the table"
  local eng gbv d clips=()
  [ -n "$SHORT" ] && clips+=("$SHORT")
  [ -n "$BIG" ] && clips+=("$BIG")
  # loop: SERIAL-REQUIRED — one engine at a time on one GPU
  for eng in original ours; do
    # loop: SERIAL-REQUIRED — one budget at a time on one GPU
    for gbv in ${SWEEP//,/ }; do
      d="$OUT/budget/$eng/b$gbv"
      if done_mark "$d"; then continue; fi
      run rm -rf "$d"; run mkdir -p "$d"
      local saved=("${SETTINGS_OPTS[@]}")
      SETTINGS_OPTS=(--vram-budget "$gbv" --option "num_frames=${FRAMES:-24}")
      bench "$eng" "$d" "${clips[@]}"
      SETTINGS_OPTS=("${saved[@]}")
      run rm -rf "$d/out" "$d/tmp"
      [ "$DRY" = 1 ] || touch "$d/.done"
    done
  done
  [ "$DRY" = 1 ] && return 0
  "$PY" -I - "$OUT" "$BUDGET" "$REHEARSE" <<'PYEOF'
import glob, json, os, sys
out, budget, rehearse = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
meta = json.load(open(os.path.join(out, "meta.json")))
kinds = {c["name"]: c["kind"] for c in meta["clips"]}  # loop: NOT-WORTH — the clips


def load(p):
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return None


def smallest(eng):
    best = {}
    # loop: NOT-WORTH — a few budgets
    for b in sorted(glob.glob(os.path.join(out, "budget", eng, "b*", "bench.json")), key=lambda p: float(os.path.basename(os.path.dirname(p))[1:])):
        gbv = float(os.path.basename(os.path.dirname(b))[1:])
        # loop: NOT-WORTH — two clips per budget
        for r in (load(b) or {}).get("rows", []):
            k = kinds.get(r["clip"], "hd")
            if not r.get("error") and r.get("exit") == 0 and k not in best:
                best[k] = gbv
    return best


def fourk(eng):
    # loop: NOT-WORTH — the repeats' bench rows
    rows = [r for b in glob.glob(os.path.join(out, "speed", eng, "rep*", "bench.json")) for r in (load(b) or {}).get("rows", []) if kinds.get(r["clip"]) == "4k"]
    if not rows:
        return "not run"
    ok = [r for r in rows if not r.get("error") and r.get("exit") == 0]  # loop: NOT-WORTH — a few rows
    if not ok:
        return f"no ({rows[0].get('error')})"
    m = ok[0].get("memory") or {}
    return f"yes: {len(ok)}/{len(rows)} runs, {budget} GB budget, window {m.get('hann_chunk')}/{m.get('hann_stride')}, peak {max(r.get('peakVramMb', 0) for r in ok) / 1024:.1f} GiB"  # loop: NOT-WORTH — a few rows


def fmts(eng, kind):
    seen = {}
    # loop: NOT-WORTH — one formats file per clip
    for p in sorted(glob.glob(os.path.join(out, "formats", f"{eng}-{kind}-*.json"))):
        # loop: NOT-WORTH — two outputs
        for name, f in (load(p) or {}).items():
            if kind == "video":
                seen.setdefault(name, f"{f.get('codec')} {f.get('pix_fmt')} ({f.get('bits')}-bit)")
            else:
                seen.setdefault(name, f"channels {','.join(f.get('channels', []))}, {'/'.join(f.get('pixel_types', []))}")
    return "; ".join(f"{k}: {v}" for k, v in seen.items()) or "not checked"  # loop: NOT-WORTH — two outputs


so, sc = smallest("ours"), smallest("original")
sweep = lambda s: ", ".join(f"{k.upper()} {v:g} GB" for k, v in sorted(s.items())) or "none finished"  # noqa: E731  # loop: NOT-WORTH — two kinds
rows = [
    {"what": "Systems", "ours": "Linux, Windows 10/11 (x64), macOS 14+ on Apple Silicon", "original": "Linux, Windows (CUDA PyTorch); no macOS",
     "source": "stated: README Requirements (Windows keying untested on an NVIDIA card; macOS only if tools/mac_gate.sh passes) / its README Setup"},
    {"what": "Graphics card", "ours": "NVIDIA RTX 30-series or newer; Apple Silicon (Core ML, in progress)", "original": "NVIDIA RTX 30-series or newer; ≥ 4 GB up to 1440p, ≥ 6 GB for 4K",
     "source": "stated: README Requirements / its README Setup"},
    {"what": "Smallest memory budget that finished (first frames, this card)", "ours": sweep(so), "original": sweep(sc),
     "source": "measured: budget sweep (vram_budget_gb; the original through ck_engine.py's PyTorch per-process cap)"},
    {"what": "4K on a 16 GB card", "ours": fourk("ours"), "original": fourk("original"), "source": "measured: the speed runs"},
    {"what": "Input bit depth (video, PNG)", "ours": "16-bit decode for 10/12-bit video and 16-bit PNG", "original": "8-bit (OpenCV)",
     "source": "stated: README \"Deep input\" (measured 2026-10-24 by tools/bit_depth_bench.sh)"},
    {"what": "Video outputs", "ours": fmts("ours", "video"), "original": fmts("original", "video"), "source": "measured: ffprobe of the speed runs' files"},
    {"what": "EXR outputs", "ours": fmts("ours", "exr"), "original": fmts("original", "exr"), "source": "measured: OpenEXR header of the quality runs' first frame"},
    {"what": "Engine lifetime", "ours": "only while the queue runs; ends with the app (parent-death signal)", "original": "one process per run (CLI)",
     "source": "stated: docs/ENGINE_PROTOCOL.md / infer.py"},
]
if rehearse:
    # loop: NOT-WORTH — eight rows
    for r in rows:
        r["source"] += " (REHEARSAL: the original column is our engine)" if r["source"].startswith("measured") else ""
json.dump({"rows": rows}, open(os.path.join(out, "capability.json"), "w"), indent=2)
print("capability: " + os.path.join(out, "capability.json"))
PYEOF
}

# ---- robustness
s_robust() {
  step "robust: out of memory, cancel, damaged file, full disk, long queue"
  local d="$OUT/robust"
  if done_mark "$d"; then echo "robust: done before"; return 0; fi
  run rm -rf "$d"; run mkdir -p "$d"
  local ours_json orig_json cli_json
  ours_json=$("$PY" -I -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "${OURS_CMD[@]}")
  local -a args=(--out "$d" --clip "$SHORT" --queue "$QUEUE" --ours "$ours_json" --ours-env "LD_LIBRARY_PATH=$LD")
  [ -z "$BIG" ] || args+=(--big-clip "$BIG")
  if [ "$REHEARSE" = 1 ]; then
    args+=(--cpu --frames 4 --deadline 3600 --full-kb 16)
  else
    orig_json=$("$PY" -I -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$ORIG_PY" -u "$REPO/engine/ck_engine.py" --package-root "$ORIG_ROOT")
    cli_json=$("$PY" -I -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$ORIG_PY" -u "$ORIG_ROOT/infer.py")
    args+=(--original "$orig_json" --original-cli "$cli_json" --original-root "$ORIG_ROOT")
  fi
  gpu "$MEM_ORIG" "$PY" -I "$REPO/tools/vs_original_robust.py" "${args[@]}"
  [ "$DRY" = 1 ] || touch "$d/.done"
}

s_report() {
  step "report"
  light 2 "$PY" -I "$REPO/tools/vs_original_report.py" build "$OUT"
  echo "report: $OUT/report.md"
  [ "$BLIND" = 0 ] || echo "blind pairs: $OUT/blind (the key, kept apart: $KEY_DIR/key.json)"
}

# loop: SERIAL-REQUIRED — the steps in order (floor needs quality's window; report needs all)
for s in speed quality floor resources capability robust report; do
  if want "$s"; then "s_$s"; else step "$s: skipped (--steps $STEPS)"; fi
done
