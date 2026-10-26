#!/usr/bin/env bash
# The macOS gate (BACKLOG row 24), one command from the Linux PC: "Mac is in 1.0 only if the Core ML engine is
# proven on a real Apple Silicon Mac: mattes within fp16 rounding of CUDA, speed measured."
#
#   tools/mac_gate.sh --host USER@HOST [options]
#
# Over SSH (key login, docs/MACOS_TEST_MACHINE.md), from this PC's committed HEAD:
#   1. preflight: macOS version, chip, memory, free disk; git, cargo/rustup, node, ffmpeg present (stops naming what's missing)
#   2. the code at HEAD (git archive, no GitHub) → ~/ck-gate/src on the Mac; the engine built there (build_engine.sh --mac)
#   3. ONNX Runtime for macOS (the wheel pinned in electron/main/install.ts: curl + sha256, the dylib unzipped) and the
#      model set from this PC (rsync, every file's sha256 checked against manifest.json); skipped when already verified
#   4. the clips (rsync; the originals are only read)
#   5. keying on the Mac with tools/engine_bench.mjs (detached under caffeinate, so a dropped SSH connection doesn't
#      end it; this script follows its log and picks it up again when re-run), EXR float outputs
#   6. the reference: the same clips and settings keyed here with CUDA (or --ref DIR); refuses while Sonata runs,
#      holds ~/.cache/claude-scratch/gpu.lock
#   7. the Mac's outputs pulled back, compared exactly (matte_compare.py, side_by_side.py: EXR read as float by OpenCV),
#      and a report folder with a verdict against the bar (tools/mac_gate_report.py says where the bar comes from)
#
# Options:
#   --host USER@HOST     the Mac (required)
#   --provider P         the engine's --device on the Mac (default cpu; coreml = the real gate: ONNX Runtime's Core ML
#                        provider on the Core ML model set). The provider that really ran is read from the engine's replies.
#   --precision P        fp16 (default, as CUDA ships) | fp32 | engine (the engine's own default); both sides alike
#   --window C/S         the Hann window, both sides (default 8/4: what the 4K plate gets in 14 GB, and a 16 GB Mac's size;
#                        coreml: default 4/2, and it must be a window the Core ML set was built for)
#   --coreml-set DIR     coreml: the Core ML set (engine-rs/export/coreml/build_coreml_models.sh's OUT/set: the files,
#                        coreml.json, SHA256SUMS; default ~/.cache/claude-scratch/coreml-p4/set, built from 2.0.0-onnx.4). Copied next to the
#                        model set on the Mac, every file's sha256 checked on both sides
#   --coreml-units U     coreml: Core ML's compute units on the Mac: all (default) | cpu-gpu | cpu-ane | cpu
#   --no-low-vram        normal mode instead of staged low-memory mode (identical mattes; low-memory is the default)
#   --frames N           key only the first N frames of each clip (default: all)
#   --clips A,B,...      clips (files or frame folders) instead of the default set (coreml's default: the HD clips the
#                        Core ML set has a size for, decode-stable first: an exact 1280x1080 crop of the 4K EXR plate 04_5d
#                        made here (half-float EXR, no decoder involved), then the three 12-bit ProRes HD clips)
#   --ref DIR            an existing CUDA reference (an engine_bench --out folder with bench.json and out/<clip>/)
#   --out DIR            the report folder (default ~/.cache/claude-scratch/mac-gate/<date>-<commit>)
#   --stall-s S          kill an engine silent this long (default 3600 for cpu and coreml; else 900)
#   --max-hours H        stop following the Mac's run after this long (default 24; the run itself keeps going)
#   --models DIR         the model set (default the app's installed 2.0.0-onnx.4, else the published set's local copy
#                        ~/.cache/claude-scratch/models/2.0.0-onnx.4)
#   --fresh              key again on the Mac even if this exact run finished before
#   --steps 1,2,...      run only these steps (default all; every step is safe to repeat, e.g. --steps 7 reports again)
#   --dry-run            print every step and command; no SSH, no GPU, nothing written
#
# Memory on this PC: the reference keying, comparisons and the local engine build run inside claude-work.slice under
# ~/.cache/claude-scratch/tools/memrun.sh (when present) and ~/.cache/claude-scratch/heavy.lock.
set -euo pipefail

HOST="" PROVIDER=cpu PRECISION=fp16 WINDOW="" LOW_VRAM=true COREML_UNITS=all FRAMES="" CLIPS="" REF="" OUT="" STALL="" MAX_HOURS=24
MODELS="$HOME/.local/share/corridorkey-desktop/models/2.0.0-onnx.4" FRESH=0 DRY=0 STEPS=1,2,3,4,5,6,7
[ -d "$MODELS" ] || MODELS="$HOME/.cache/claude-scratch/models/2.0.0-onnx.4"
COREML_SET="$HOME/.cache/claude-scratch/coreml-p4/set"
T="$HOME/Videos/corridorkey-tests"
DEFAULT_CLIPS="$T/metal_glasses.mov,$T/locked_backdrop.mov,$T/with_motion_blur.mov,$T/4k/04_5d"
# coreml: HD only (the Core ML set has the HD size, 1152x1280 padded); the EXR crop first (no video decoder: the row-31
# study found 8-bit video decodes differ by CPU SIMD, so a decoded-input difference can't hide a model difference)
HD_EXR="$HOME/.cache/claude-scratch/mac-gate/clips/04_5d_hd"
DEFAULT_CLIPS_COREML="$HD_EXR,$T/metal_glasses.mov,$T/locked_backdrop.mov,$T/with_motion_blur.mov"
die() { echo "mac_gate: $*" >&2; exit 1; }
# loop: NOT-WORTH — the command line
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST=$2; shift 2 ;;
    --provider) PROVIDER=$2; shift 2 ;;
    --precision) PRECISION=$2; shift 2 ;;
    --window) WINDOW=$2; shift 2 ;;
    --coreml-set) COREML_SET=$2; shift 2 ;;
    --coreml-units) COREML_UNITS=$2; shift 2 ;;
    --no-low-vram) LOW_VRAM=false; shift ;;
    --frames) FRAMES=$2; shift 2 ;;
    --clips) CLIPS=$2; shift 2 ;;
    --ref) REF=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --stall-s) STALL=$2; shift 2 ;;
    --max-hours) MAX_HOURS=$2; shift 2 ;;
    --models) MODELS=$2; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --steps) STEPS=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (--help)" ;;
  esac
done
[ -n "$HOST" ] || die "--host USER@HOST is required (the Mac, e.g. marcy@mac-mini.local)"
[ -n "$WINDOW" ] || { [ "$PROVIDER" = coreml ] && WINDOW=4/2 || WINDOW=8/4; }
[[ "$WINDOW" =~ ^[0-9]+/[0-9]+$ ]] || die "--window wants CHUNK/STRIDE, e.g. 8/4"
[[ "$COREML_UNITS" =~ ^(all|cpu-gpu|cpu-ane|cpu)$ ]] || die "--coreml-units: all | cpu-gpu | cpu-ane | cpu"
[[ "$PRECISION" =~ ^(fp16|fp32|engine)$ ]] || die "--precision: fp16 | fp32 | engine"
[[ "$PROVIDER" =~ ^[a-z0-9_]+$ ]] || die "--provider: a device name like cpu or coreml"
[ -z "$FRAMES" ] || [[ "$FRAMES" =~ ^[0-9]+$ ]] || die "--frames wants a number"
# (cpu: one 4K window is slow; coreml: the first load compiles each network for Core ML, minutes possible)
[ -n "$STALL" ] || { [[ "$PROVIDER" =~ ^(cpu|coreml)$ ]] && STALL=3600 || STALL=900; }
CHUNK=${WINDOW%/*} STRIDE=${WINDOW#*/}

REPO=$(cd "$(dirname "$0")/.." && pwd)
SCRATCH="$HOME/.cache/claude-scratch"
PY="${CK_PY:-$SCRATCH/corridorkey-onnx/venv/bin/python}"
MEMRUN="$SCRATCH/tools/memrun.sh"
export CK_SLICE="${CK_SLICE:-claude-work.slice}"
RT_NAME=ort-1.31.0-coreml
R=ck-gate  # the Mac's folder, under its home

step() { printf '\n== %s\n' "$*"; }
# a local command: printed, and run unless --dry-run
run() { printf '+'; printf ' %q' "$@"; printf '\n'; [ "$DRY" = 1 ] || "$@"; }
# a local memory-heavy command: inside the shared budget, one at a time
heavy() { # GB cmd...
  local gb=$1; shift
  if [ -x "$MEMRUN" ]; then run flock "$SCRATCH/heavy.lock" "$MEMRUN" "$gb" "$@"; else run "$@"; fi
}
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout="${CK_SSH_TIMEOUT:-10}" -o ServerAliveInterval=30 -o ServerAliveCountMax=6)
# a script on the Mac: its variables (NAME=value pairs) first, then the body from stdin; bash, Homebrew and cargo on PATH
# (a non-interactive SSH session reads neither .zprofile nor .zshrc; node@22 is keg-only)
remote() { # NAME=value... <<'EOF' body
  # shellcheck disable=SC2016 # expanded on the Mac
  local pre='export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"; set -euo pipefail'$'\n'
  local kv
  # loop: NOT-WORTH — a few variables per script
  for kv in "$@"; do pre+="${kv%%=*}=$(printf '%q' "${kv#*=}")"$'\n'; done
  local body; body=$(cat)
  if [ "$DRY" = 1 ]; then
    printf '+ ssh %s bash -s <<EOF\n%s%s\nEOF\n' "$HOST" "$pre" "$body"
    return 0
  fi
  # the body as one function, read whole before it runs, with stdin closed: a command in it can't eat the script
  # loop: SERIAL-REQUIRED — one SSH session per step [bounded: ConnectTimeout + ServerAlive; long work runs detached]
  ssh "${SSH_OPTS[@]}" "$HOST" 'bash -s' <<<"${pre}__gate() {"$'\n'"$body"$'\n'"}"$'\n'"__gate </dev/null"
}
RSYNC_PATH=()  # Homebrew's rsync on the Mac when there is one (macOS's own is openrsync)
xfer() { run rsync "${RSYNC_PATH[@]}" -e "ssh ${SSH_OPTS[*]}" "$@"; }

# ---- 0. this PC: the commit, the tools
step "0. this PC: the commit and local tools"
cd "$REPO"
COMMIT=$(git rev-parse HEAD)
SHORT=${COMMIT:0:10}
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  msg="the working tree has uncommitted changes: the Mac must build exactly a commit. Commit or stash them first."
  if [ "$DRY" = 1 ]; then echo "mac_gate: (dry run) $msg" >&2; else die "$msg"; fi
fi
echo "commit: $COMMIT ($(git log -1 --format=%s))"
# loop: NOT-WORTH — a few tool names
for t in ssh rsync node git ffprobe flock; do command -v "$t" >/dev/null || die "this PC is missing $t"; done
[ -x "$PY" ] || die "no Python with numpy + OpenCV at $PY (set CK_PY)"
[ -f "$MODELS/manifest.json" ] || die "no model set at $MODELS (manifest.json missing)"
if [ "$PROVIDER" = coreml ]; then
  # the Core ML set: present, built from this model set, and built for this window (stage 1 at CHUNK frames; the
  # low-memory prepass calls C-RADIO / MoGe 4 frames at a time, normal mode CHUNK at a time)
  [ -f "$COREML_SET/coreml.json" ] && [ -f "$COREML_SET/SHA256SUMS" ] || die "no Core ML set at $COREML_SET (coreml.json + SHA256SUMS; engine-rs/export/coreml/build_coreml_models.sh)"
  "$PY" -I - "$COREML_SET/coreml.json" "$MODELS/manifest.json" "$CHUNK" "$LOW_VRAM" <<'PYEOF' || die "the Core ML set doesn't fit this run"
import json, sys
cm, man, chunk, low = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), int(sys.argv[3]), sys.argv[4] == "true"
if cm.get("source_set") != man.get("version"):
    sys.exit(f"the Core ML set was built from {cm.get('source_set')}, the model set is {man.get('version')}")
fb = 4 if low else chunk
# loop: NOT-WORTH — the set's few sizes
for size, files in cm["fp16"].items():
    need = [f"rvm-t1", f"stage2-t1", f"stage1-t{chunk}", f"cradio-t{fb}", f"moge-t{fb}"]
    # loop: NOT-WORTH — five names
    miss = [n for n in need if n not in files]
    if miss:
        sys.exit(f"the Core ML set has no {', '.join(miss)} at {size} (it has {', '.join(sorted(files))}): pick --window to match")
    print(f"Core ML set: {size} for window {chunk} ({'low-memory' if low else 'normal'} mode)")
PYEOF
fi
IFS=, read -r -a CLIP_LIST <<<"${CLIPS:-$([ "$PROVIDER" = coreml ] && echo "$DEFAULT_CLIPS_COREML" || echo "$DEFAULT_CLIPS")}"
# the HD EXR clip: an exact 1280x1080 crop (x 2304-3583, y 0-1079: both actors' hair, the green screen) of the 4K
# Tears of Steel plate 04_5d, half-float in, half-float out: no resampling, no decoder; made once
if [[ ",${CLIP_LIST[*]}," == *"$HD_EXR"* ]] && [ ! -f "$HD_EXR/.complete" ]; then
  printf '+ (the HD EXR excerpt: %s cropped to 1280x1080 into %s)\n' "$T/4k/04_5d" "$HD_EXR"
  if [ "$DRY" = 0 ]; then
    rm -rf "$HD_EXR" && mkdir -p "$HD_EXR"
    OPENCV_IO_ENABLE_OPENEXR=1 "$PY" -I - "$T/4k/04_5d" "$HD_EXR" <<'PYEOF' || die "couldn't make the HD EXR excerpt"
import os, sys
import cv2
src, dst = sys.argv[1:3]
names = sorted(n for n in os.listdir(src) if n.lower().endswith(".exr"))
# loop: SERIAL-REQUIRED — 120 frames, one 4K frame in memory at a time
for n in names:
    im = cv2.imread(os.path.join(src, n), cv2.IMREAD_UNCHANGED)
    assert im is not None and im.shape[:2] == (2160, 4096), n
    out = im[0:1080, 2304:3584]
    ok = cv2.imwrite(os.path.join(dst, n.replace("04_5d", "04_5d_hd")), out, [cv2.IMWRITE_EXR_TYPE, cv2.IMWRITE_EXR_TYPE_HALF])
    assert ok, n
print(f"HD EXR excerpt: {len(names)} frames, 1280x1080")
PYEOF
    touch "$HD_EXR/.complete"
  fi
fi
CLIP_NAMES=()
# loop: NOT-WORTH — the gate's few clips
for c in "${CLIP_LIST[@]}"; do
  [ -e "$c" ] || [ "$DRY" = 1 ] || die "clip not found: $c"
  b=$(basename "$c"); CLIP_NAMES+=("${b%.*}")
done
echo "clips: ${CLIP_NAMES[*]}"
OUT=${OUT:-$SCRATCH/mac-gate/$(date +%F)-$SHORT}
WIN_TAG="w${CHUNK}-${STRIDE}$([ "$LOW_VRAM" = true ] && echo low || true)${FRAMES:+-f$FRAMES}"
KEY="$SHORT-$PROVIDER$([ "$PROVIDER" = coreml ] && echo "-$COREML_UNITS" || true)-$PRECISION-$WIN_TAG"
echo "run: $KEY → report in $OUT"
if [ "$DRY" = 0 ]; then
  mkdir -p "$OUT"
  avail=$(df -BG --output=avail "$OUT" | tail -1 | tr -dc 0-9)
  [ "$avail" -ge 40 ] || die "only $avail GB free under $OUT; the reference and the Mac's EXR outputs need up to ~40 GB (the 4K plate in float)"
fi

# the run options, the same for both sides (engine_bench --option key=json; --env for the precision)
BENCH_OPTS=(--option 'output_format="exr"' --option 'exr_dtype="float"' --option "hann_chunk=$CHUNK" --option "hann_stride=$STRIDE" --option "low_vram=$LOW_VRAM")
[ -z "$FRAMES" ] || BENCH_OPTS+=(--option "num_frames=$FRAMES")
[ "$PRECISION" = engine ] || BENCH_OPTS+=(--env "CK_ENGINE_PRECISION=$PRECISION")
# the Mac's side only: Core ML's compute units
MAC_OPTS=()
[ "$PROVIDER" != coreml ] || MAC_OPTS+=(--env "CK_ENGINE_COREML_UNITS=$COREML_UNITS")
SETTINGS="$([ "$PROVIDER" = coreml ] && echo "Core ML units $COREML_UNITS, " || true)window $CHUNK/$STRIDE$([ "$LOW_VRAM" = true ] && echo ' low-memory' || true), precision $PRECISION, EXR float, outputs alpha+fg${FRAMES:+, first $FRAMES frames}"
# where things are, for every step
SET=$(basename "$MODELS")
FACTS="$OUT/facts.txt"
RUN="runs/$KEY"
MAC_CLIPS=()
# loop: NOT-WORTH — the gate's few clips
for c in "${CLIP_LIST[@]}"; do MAC_CLIPS+=("clips/$(basename "$c")"); done
REF_GIVEN=$([ -n "$REF" ] && echo 1 || echo 0)
REF=${REF:-$SCRATCH/mac-gate/ref/$SHORT-$PRECISION-$WIN_TAG}

# ---- 1. the Mac: preflight
s1() {
step "1. the Mac: preflight ($HOST)"
pre_out=$(remote <<'EOF'
echo "macos=$(sw_vers -productName) $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
echo "chip=$(sysctl -n machdep.cpu.brand_string)"
echo "memory_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))"
echo "cores=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || echo ?) performance + $(sysctl -n hw.perflevel1.physicalcpu 2>/dev/null || echo ?) efficiency"
echo "disk_free_gb=$(df -g "$HOME" | awk 'NR==2 {print $4}')"
echo "arch=$(uname -m)"
missing=""
xcode-select -p >/dev/null 2>&1 || missing="$missing Command-Line-Tools(xcode-select --install)"
# loop: NOT-WORTH — a few tool names
for t in git cargo rustup node ffmpeg ffprobe curl shasum unzip caffeinate; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
echo "missing=${missing# }"
[ -x /opt/homebrew/bin/rsync ] && echo "rsync=/opt/homebrew/bin/rsync" || echo "rsync="
command -v node >/dev/null 2>&1 && echo "node=$(node --version)"
command -v ffmpeg >/dev/null 2>&1 && echo "ffmpeg=$(ffmpeg -version | head -1 | awk '{print $3}')"
command -v rustup >/dev/null 2>&1 && echo "rustup=$(rustup --version 2>/dev/null | head -1 | awk '{print $2}')"
true
EOF
) || die "can't reach $HOST over SSH (key login, Remote Login on; docs/MACOS_TEST_MACHINE.md)"
echo "$pre_out"
if [ "$DRY" = 0 ]; then
  val() { sed -n "s/^$1=//p" <<<"$pre_out" | head -1; }
  [ "$(val arch)" = arm64 ] || die "the Mac reports arch '$(val arch)', not arm64 (Apple Silicon)"
  [ -z "$(val missing)" ] || die "the Mac is missing: $(val missing) (docs/MACOS_TEST_MACHINE.md, 'On the Mac')"
  [ "$(val disk_free_gb)" -ge 40 ] || die "the Mac has $(val disk_free_gb) GB free; the models, clips and EXR outputs need ~40 GB"
  [ -z "$(val rsync)" ] || RSYNC_PATH=(--rsync-path="$(val rsync)")
  { grep -v '^missing=\|^rsync=' <<<"$pre_out"; echo "host=$HOST"; } >"$FACTS"
fi
}

# ---- 2. the code at HEAD, and the engine built on the Mac
s2() {
step "2. the code at $SHORT → ~/$R/src on the Mac, the engine built there"
STAGE="$SCRATCH/mac-gate/stage/$SHORT"
if [ ! -f "$STAGE/.complete" ]; then
  run rm -rf "$STAGE"
  run mkdir -p "$STAGE/src"
  printf '+ git archive %s | tar -x -C %q\n' "$COMMIT" "$STAGE/src"
  [ "$DRY" = 1 ] || { git archive "$COMMIT" | tar -x -C "$STAGE/src" && echo "$COMMIT" >"$STAGE/src/.gate-commit" && touch "$STAGE/.complete"; }
fi
remote <<EOF
mkdir -p "\$HOME/$R/src"
EOF
# content-compared (-c), times not kept: only changed files are written, so cargo sees exactly what changed
xfer -rlpc --delete --exclude=/engine-rs/target/ "$STAGE/src/" "$HOST:$R/src/"
remote COMMIT="$COMMIT" <<'EOF'
cd "$HOME/ck-gate/src"
[ "$(cat .gate-commit)" = "$COMMIT" ] || { echo "the Mac's source is not at $COMMIT" >&2; exit 1; }
echo "building the engine (log: ~/ck-gate/build.log) ..."
if ! tools/build_engine.sh --mac >"$HOME/ck-gate/build.log" 2>&1; then tail -30 "$HOME/ck-gate/build.log" >&2; exit 1; fi
tail -1 "$HOME/ck-gate/build.log"
engine-rs/target/dist/corridorkey-engine --version
EOF
}

# ---- 3. ONNX Runtime and the models, verified
s3() {
step "3. ONNX Runtime ($RT_NAME) and the models on the Mac, verified"
# the pinned wheel from electron/main/install.ts (RUNTIME_MAC): one place decides it
mac_block=$(sed -n '/^export const RUNTIME_MAC = {/,/^};/p' "$REPO/electron/main/install.ts")
PYPI=$(sed -n 's/^const PYPI = "\(.*\)";/\1/p' "$REPO/electron/main/install.ts")
# shellcheck disable=SC2016 # a literal ${PYPI} in install.ts
WHEEL_URL=$(sed -n 's/^ *url: `\${PYPI}\(.*\)`,/\1/p' <<<"$mac_block"); WHEEL_URL="$PYPI$WHEEL_URL"
WHEEL_SHA=$(sed -n 's/^ *sha256: "\([0-9a-f]\{64\}\)",/\1/p' <<<"$mac_block")
WHEEL_FILE=$(sed -n 's/^ *file: "\(.*\)",/\1/p' <<<"$mac_block")
grep -q "name: \"$RT_NAME\"" <<<"$mac_block" || die "install.ts's RUNTIME_MAC is no longer $RT_NAME: update RT_NAME here"
[ -n "$PYPI" ] && [ -n "$WHEEL_SHA" ] && [ -n "$WHEEL_FILE" ] && [[ "$WHEEL_URL" == https://* ]] || die "couldn't read the macOS wheel from electron/main/install.ts"
echo "wheel: $WHEEL_FILE sha256 $WHEEL_SHA"
remote RT="$RT_NAME" URL="$WHEEL_URL" SHA="$WHEEL_SHA" FILE="$WHEEL_FILE" <<'EOF'
D="$HOME/ck-gate/runtime/$RT"
if [ "$(cat "$D/.verified" 2>/dev/null)" = "$SHA" ] && ls "$D"/onnxruntime/capi/libonnxruntime.*.dylib >/dev/null 2>&1; then
  echo "runtime: already there and verified"; exit 0
fi
mkdir -p "$HOME/ck-gate/downloads" "$D.partial"
W="$HOME/ck-gate/downloads/$FILE"
if [ "$(shasum -a 256 "$W" 2>/dev/null | cut -d' ' -f1)" != "$SHA" ]; then
  curl -fsSL --retry 3 --connect-timeout 20 -o "$W.part" "$URL"
  mv -f "$W.part" "$W"
fi
got=$(shasum -a 256 "$W" | cut -d' ' -f1)
[ "$got" = "$SHA" ] || { echo "runtime: sha256 mismatch: $got, expected $SHA" >&2; rm -f "$W"; exit 1; }
# what install.ts keeps (keepFromWheel): the dylib, ONNX Runtime's licence and notices, the dist-info licences
rm -rf "$D.partial" && mkdir -p "$D.partial"
# (unzip exits 11 when a pattern matches nothing: the dylib check below decides)
unzip -q -o "$W" 'onnxruntime/capi/libonnxruntime.*.dylib' 'onnxruntime/LICENSE' 'onnxruntime/ThirdPartyNotices.txt' -d "$D.partial" || [ $? -eq 11 ]
unzip -q -o "$W" '*.dist-info/LICENSE*' '*.dist-info/licenses/*' -d "$D.partial" 2>/dev/null || [ $? -eq 11 ]
ls "$D.partial"/onnxruntime/capi/libonnxruntime.*.dylib >/dev/null || { echo "runtime: no libonnxruntime.*.dylib in the wheel" >&2; exit 1; }
rm -rf "$D" && mv "$D.partial" "$D" && echo "$SHA" >"$D/.verified"
echo "runtime: $(ls "$D"/onnxruntime/capi/libonnxruntime.*.dylib)"
EOF
SUMS="$OUT/models.sha256"
printf '+ (the model files on this PC checked against %s, then their sha256 list written to %s)\n' "$MODELS/manifest.json" "$SUMS"
if [ "$DRY" = 0 ]; then
  # this PC's copy first: every file the manifest lists that is present must match its size and sha256
  "$PY" -I - "$MODELS" "$SUMS" "$PRECISION" <<'PYEOF' || die "the model set on this PC doesn't match its manifest"
import hashlib, json, os, sys
d, out, prec = sys.argv[1:4]
m = json.load(open(os.path.join(d, "manifest.json")))
lines, bad, absent = [], [], []
# loop: NOT-WORTH — ten model files, each hashed once (3 GB, ~10 s)
for f in (f for model in m["models"] for f in model["files"]):
    p = os.path.join(d, f["file"])
    if not os.path.exists(p):
        absent.append(f["file"])
        continue
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        # loop: SERIAL-REQUIRED — 16 MB reads of one file [bounded: the file's size]
        for b in iter(lambda: fh.read(1 << 24), b""):
            h.update(b)
    if os.path.getsize(p) != f["bytes"] or h.hexdigest() != f["sha256"]:
        bad.append(f["file"])
    lines.append(f"{f['sha256']}  {f['file']}")
names = json.load(open(os.path.join(d, "models.json"))) if os.path.exists(os.path.join(d, "models.json")) else {}
want = [] if prec == "engine" else list(names.get(prec, {}).values())
# loop: NOT-WORTH — five names
missing = [w for w in want if not os.path.exists(os.path.join(d, w))]
if bad or missing:
    print(f"mismatching: {bad}; missing for {prec}: {missing}", file=sys.stderr)
    sys.exit(1)
open(out, "w").write("\n".join(lines) + "\n")
print(f"models: {len(lines)} files verified here" + (f" (not in this set: {len(absent)} files, e.g. {absent[0]})" if absent else ""))
PYEOF
fi
remote <<EOF
mkdir -p "\$HOME/$R/models/$SET"
EOF
xfer -a --partial --include='*.onnx' --include='*.onnx.data' --include='*.json' --exclude='*' "$MODELS/" "$HOST:$R/models/$SET/"
if [ "$PROVIDER" = coreml ]; then
  # the Core ML set next to the model set (its files keep their weights in the set's .onnx.data); its own checksums
  # here first, then on the Mac below with the rest
  printf '+ (the Core ML set %s checked against its SHA256SUMS, added to the list)\n' "$COREML_SET"
  if [ "$DRY" = 0 ]; then
    (cd "$COREML_SET" && sha256sum --quiet -c SHA256SUMS) || die "the Core ML set at $COREML_SET doesn't match its SHA256SUMS"
    cat "$COREML_SET/SHA256SUMS" >>"$SUMS"
    echo "$(sha256sum "$COREML_SET/coreml.json" | cut -d' ' -f1)  coreml.json" >>"$SUMS"
  fi
  xfer -a --partial "$COREML_SET/coreml.json" "$COREML_SET"/*.onnx "$HOST:$R/models/$SET/"
fi
xfer "$SUMS" "$HOST:$R/models/$SET/.sha256"
remote SET="$SET" <<'EOF'
cd "$HOME/ck-gate/models/$SET"
# verified before with the same list and nothing written since: skip the 3 GB of hashing
if cmp -s .sha256 .verified 2>/dev/null && [ -z "$(find . -type f -newer .verified ! -name .sha256 | head -1)" ]; then
  echo "models: already there and verified"; exit 0
fi
res=$(shasum -a 256 -c .sha256 2>&1) || { echo "models: sha256 mismatch on the Mac:" >&2; grep -v ': OK$' <<<"$res" >&2; exit 1; }
cp .sha256 .verified && echo "models: $(wc -l <.sha256 | tr -d ' ') files verified on the Mac"
EOF
}

# ---- 4. the clips
s4() {
step "4. the clips → ~/$R/clips on the Mac (the originals are only read)"
remote <<EOF
mkdir -p "\$HOME/$R/clips"
EOF
# loop: SERIAL-REQUIRED — one transfer per clip over one link
for c in "${CLIP_LIST[@]}"; do
  if [ -d "$c" ]; then
    xfer -a --partial --delete "${c%/}/" "$HOST:$R/clips/$(basename "$c")/"
  else
    xfer -a --partial "$c" "$HOST:$R/clips/"
  fi
done
}

# ---- 5. keying on the Mac
s5() {
step "5. keying on the Mac: provider $PROVIDER, $SETTINGS"
remote SET="$SET" RT="$RT_NAME" PROVIDER="$PROVIDER" PRECISION="$PRECISION" <<'EOF'
cd "$HOME/ck-gate"
ORT=$(ls runtime/$RT/onnxruntime/capi/libonnxruntime.*.dylib | head -1)
prec=""; [ "$PRECISION" = engine ] || prec="CK_ENGINE_PRECISION=$PRECISION"
# the engine says what it runs on before anything is keyed (an unknown --device stops it, saying so)
said=$(printf '{"cmd":"ping"}\n{"cmd":"quit"}\n' | env $prec src/engine-rs/target/dist/corridorkey-engine --models "models/$SET" --ort "$ORT" --device "$PROVIDER" 2>&1 || true)
echo "$said" | node -e '
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  // loop: NOT-WORTH — the engine'"'"'s few startup lines
  const pong = s.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m && m.type === "pong");
  if (!pong) { console.error(`the engine did not start with --device ${process.argv[1]} (the engine at this commit may not have it yet):\n${s.trim()}`); process.exit(1); }
  console.log(`engine: ${pong.engine} ${pong.version}, provider ${pong.provider}, precision ${pong.precision}, onnxruntime ${pong.ort}`);
  if (!pong.provider) { console.error(`the engine has no usable provider for --device ${process.argv[1]} on this Mac`); process.exit(1); }
});' "$PROVIDER"
EOF
# the run, detached (nohup + caffeinate: the Mac stays awake, a dropped SSH connection doesn't end it); a finished run
# of this exact key is kept unless --fresh, a live one is followed again
opts_q=$(printf '%q ' "${BENCH_OPTS[@]}") clips_q=$(printf '%q ' "${MAC_CLIPS[@]}")
[ ${#MAC_OPTS[@]} = 0 ] || opts_q+="$(printf '%q ' "${MAC_OPTS[@]}")"
remote RUN="$RUN" FRESH="$FRESH" SET="$SET" RT="$RT_NAME" PROVIDER="$PROVIDER" STALL="$STALL" \
  OPTS="${opts_q% }" CLIPS="${clips_q% }" <<'EOF'
cd "$HOME/ck-gate"
if [ -f "$RUN/exit" ] && [ "$FRESH" = 0 ] && [ "$(cat "$RUN/exit")" = 0 ]; then echo "this run finished before (--fresh to key again)"; exit 0; fi
if [ -f "$RUN/pid" ] && kill -0 "$(cat "$RUN/pid")" 2>/dev/null; then echo "this run is still going (pid $(cat "$RUN/pid")): following it"; exit 0; fi
rm -rf "$RUN" && mkdir -p "$RUN"
ORT=$(ls runtime/$RT/onnxruntime/capi/libonnxruntime.*.dylib | head -1)
cat >"$RUN/run.sh" <<RUNEOF
cd "\$HOME/ck-gate"
export PATH="$PATH" NODE_OPTIONS=--max-old-space-size=512
node src/tools/engine_bench.mjs rust --bin src/engine-rs/target/dist/corridorkey-engine --models models/$SET --ort $ORT \
  --device $PROVIDER --cpu --stall-s $STALL $OPTS --out $RUN $CLIPS
echo \$? >$RUN/exit
RUNEOF
nohup caffeinate -i -s bash "$RUN/run.sh" >"$RUN/run.log" 2>&1 </dev/null &
echo $! >"$RUN/pid"
echo "started (pid $!): ~/ck-gate/$RUN/run.log"
EOF
# follow the Mac's log until the run writes its exit code
if [ "$DRY" = 1 ]; then
  echo "+ (every 30 s: ssh $HOST tail of ~/$R/$RUN/run.log, until ~/$R/$RUN/exit exists or $MAX_HOURS h pass)"
else
  deadline=$(( $(date +%s) + MAX_HOURS * 3600 )) seen=0 fails=0
  # loop: SERIAL-REQUIRED — follows one remote run [bounded: --max-hours; the engine's stall watchdog ends a silent clip]
  while :; do
    if st=$(remote RUN="$RUN" SEEN="$seen" <<'EOF'
cd "$HOME/ck-gate/$RUN"
n=$(wc -l <run.log | tr -d ' ')
[ "$n" -gt "$SEEN" ] && tail -n +"$((SEEN + 1))" run.log | cut -c1-300
echo "@@lines=$n"
if [ -f exit ]; then echo "@@exit=$(cat exit)"; elif ! kill -0 "$(cat pid)" 2>/dev/null; then echo "@@exit=died"; fi
EOF
    ); then
      fails=0
      grep -v '^@@' <<<"$st" || true
      seen=$(sed -n 's/^@@lines=//p' <<<"$st")
      ex=$(sed -n 's/^@@exit=//p' <<<"$st")
      if [ -n "$ex" ]; then
        [ "$ex" = 0 ] || echo "mac_gate: the Mac's bench ended with '$ex' (its log: ~/$R/$RUN/run.log); reporting what it wrote" >&2
        break
      fi
    else
      fails=$((fails + 1))
      echo "mac_gate: lost the Mac for a moment ($fails); the run goes on there"
      [ "$fails" -lt 20 ] || die "the Mac stayed unreachable; re-run the same command to pick the run up again"
    fi
    [ "$(date +%s)" -lt "$deadline" ] || die "still keying after $MAX_HOURS h; re-run the same command to follow it again"
    # loop: SERIAL-REQUIRED — the 30 s pause between looks at the Mac's log [bounded: the loop's deadline]
    sleep 30
  done
fi
}

# ---- 6. the CUDA reference on this PC
s6() {
step "6. the CUDA reference on this PC"
if [ "$REF_GIVEN" = 1 ]; then
  [ -f "$REF/bench.json" ] && [ -d "$REF/out" ] || die "--ref $REF: no bench.json + out/ (an engine_bench --out folder)"
  echo "using $REF"
else
  done_before=0
  if [ -f "$REF/bench.json" ]; then
    done_before=1
    # loop: NOT-WORTH — the gate's few clips
    for n in "${CLIP_NAMES[@]}"; do
      node -e 'const b=require(process.argv[1]); const r=b.rows.find(r=>r.clip===process.argv[2]); process.exit(r && !r.error && r.exit===0 ? 0 : 1)' "$REF/bench.json" "$n" || done_before=0
    done
  fi
  if [ "$done_before" = 1 ]; then
    echo "the reference for this commit and settings is already there: $REF"
  else
    sonata=$(pgrep -fai 'mount_sonata|Sonata.AppImage' | grep -v -e claude-scratch -e pgrep || true)
    [ -z "$sonata" ] || die "Marcy's Sonata is running ($sonata): no GPU work now. Re-run later, or pass --ref DIR."
    [ "$DRY" = 1 ] || command -v nvidia-smi >/dev/null || die "no nvidia-smi: this PC can't key the CUDA reference (--ref DIR)"
    # the engine at this commit (the bundled Linux build; cargo rebuilds only what changed)
    # (build_engine.sh caps itself in its own 12 G scope inside CK_SLICE; heavy.lock keeps it one heavy job)
    run flock "$SCRATCH/heavy.lock" "$REPO/tools/build_engine.sh"
    LRT="$HOME/.local/share/corridorkey-desktop/runtime/ort-1.31.0-cuda13"
    [ "$DRY" = 1 ] || [ -d "$LRT" ] || die "no CUDA runtime at $LRT (the app's setup installs it)"
    LD="$LRT/onnxruntime/capi:$LRT/nvidia/cu13/lib:$LRT/nvidia/cudnn/lib"
    run rm -rf "$REF"
    run mkdir -p "$REF"
    # the GPU lock, then the shared memory budget; engine_bench's own guard also stops between clips while Sonata
    # plays or another process holds graphics memory
    heavy 16 flock "$SCRATCH/gpu.lock" env NODE_OPTIONS=--max-old-space-size=512 node "$REPO/tools/engine_bench.mjs" rust \
      --bin "$REPO/engine-rs/target/dist/corridorkey-engine" --models "$MODELS" --ort "$LRT/onnxruntime/capi/libonnxruntime.so.1.31.0" \
      --env "LD_LIBRARY_PATH=$LD" --device cuda --stall-s 900 "${BENCH_OPTS[@]}" --out "$REF" "${CLIP_LIST[@]}"
  fi
fi
}

# ---- 7. pull, compare, report
s7() {
step "7. the Mac's results → $OUT, compared with the reference"
MAC="$OUT/mac"
run rm -rf "$OUT/compare" "$OUT/side_by_side"
run mkdir -p "$MAC" "$OUT/compare"
xfer -a --partial --exclude=/tmp/ --exclude=/pid "$HOST:$R/$RUN/" "$MAC/"
SBS_ARGS=()
# loop: SERIAL-REQUIRED — one clip at a time (a few frames in memory each); a clip that can't be compared is reported
for n in "${CLIP_NAMES[@]}"; do
  if ! heavy 8 "$PY" -I "$REPO/tools/matte_compare.py" "$REF/out/$n" "$MAC/out/$n" --json "$OUT/compare/$n.json"; then
    echo "mac_gate: $n couldn't be compared (the report says so)" >&2
    continue
  fi
  worst=0
  # (Python reads it: its JSON has Infinity for identical frames' PSNR)
  [ "$DRY" = 1 ] || worst=$("$PY" -I -c 'import json, sys; print(json.load(open(sys.argv[1]))[0]["worst_frame"])' "$OUT/compare/$n.json")
  heavy 8 "$PY" -I "$REPO/tools/side_by_side.py" "$REF/out/$n" "$MAC/out/$n" --out "$OUT/side_by_side/$n" \
    --labels "CUDA (this PC)" "Mac ($PROVIDER)" --frames "$worst" && SBS_ARGS+=(--sbs "$n=side_by_side/$n")
done
printf '+ (the per-clip comparisons merged into %s)\n' "$OUT/compare.json"
if [ "$DRY" = 0 ]; then
  "$PY" -I -c 'import glob, json, sys; d = sys.argv[1]; json.dump([m for f in sorted(glob.glob(d + "/compare/*.json")) for m in json.load(open(f))], open(d + "/compare.json", "w"), indent=2)' "$OUT"
  [ -f "$FACTS" ] || echo "facts=not collected in this run (step 1 skipped)" >"$FACTS"
fi
run "$PY" -I "$REPO/tools/mac_gate_report.py" --compare "$OUT/compare.json" --mac-bench "$MAC/bench.json" \
  --ref-bench "$REF/bench.json" --facts "$FACTS" --commit "$COMMIT" --settings "$SETTINGS" "${SBS_ARGS[@]}" --out "$OUT/report.md"
echo "report: $OUT/report.md"
}

# loop: SERIAL-REQUIRED — the steps in order, each depends on the ones before
for n in 1 2 3 4 5 6 7; do
  case ",$STEPS," in *",$n,"*) "s$n" ;; *) step "$n. skipped (--steps $STEPS)" ;; esac
done
