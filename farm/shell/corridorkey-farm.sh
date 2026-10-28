#!/usr/bin/env bash
# Key a list of shots with corridorkey, one shot per graphics card at a time: a farm for a studio without a scheduler.
# docs/CLI.md is the contract; farm/README.md "Shell" has the details.
#
#   corridorkey-farm.sh [--gpus 0,1] [--logs DIR] [--overwrite] SHOTS.txt [-- CORRIDORKEY RENDER FLAGS...]
#
# SHOTS.txt: one shot per line, INPUT OUTPUT [FRAMES], separated by tabs (or by spaces when no path has one);
# FRAMES empty or "-" keys the whole shot. Blank lines and lines starting with # are skipped.
#   plates/sh010.####.exr	key/sh010_key.####.exr
#   shots/sh020.mov	key/sh020/	1001-1100
# Every shot runs with --skip-existing, so running the list again resumes it: shots whose frames are all there and
# whole are done at once (exit 0), the others are keyed again. --overwrite keys every shot again instead.
# The command is $CORRIDORKEY, else corridorkey on PATH. Flags after -- go to every render (--models, --ort, --linear).
# Exit: 0 when every shot ended 0, else 1; the summary lists each shot's exit code (docs/CLI.md "Exit codes").
set -u -o pipefail

usage() { sed -n '4,5p' "$0" | sed 's/^# *//' >&2; exit 2; }

gpus="" logs="corridorkey-farm-logs" existing="--skip-existing" shots=""
# loop: NOT-WORTH — the command-line arguments, once per run
while (($#)); do
    case "$1" in
        --gpus) gpus="${2:?--gpus needs a list, such as 0,1}"; shift 2 ;;
        --logs) logs="${2:?--logs needs a folder}"; shift 2 ;;
        --overwrite) existing="--overwrite"; shift ;;
        -h | --help) usage ;;
        --) shift; break ;;
        -*) echo "corridorkey-farm: unknown option $1" >&2; usage ;;
        *) [[ -z "$shots" ]] || usage; shots="$1"; shift ;;
    esac
done
[[ -n "$shots" && -r "$shots" ]] || { echo "corridorkey-farm: give a readable shot list" >&2; usage; }
extra=("$@")
ck="${CORRIDORKEY:-corridorkey}"
mkdir -p "$logs" || exit 1

# the shots: INPUT, OUTPUT, FRAMES per index
inputs=() outputs=() frames=()
# loop: NOT-WORTH — one pass over the shot list, once per run
while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" == *$'\t'* ]]; then IFS=$'\t' read -r i o f <<<"$line"; else read -r i o f <<<"$line"; fi
    [[ -n "$i" && -n "$o" ]] || { echo "corridorkey-farm: a line needs INPUT and OUTPUT: $line" >&2; exit 2; }
    inputs+=("$i") outputs+=("$o") frames+=("${f:--}")
done <"$shots"
((${#inputs[@]})) || { echo "corridorkey-farm: no shots in $shots" >&2; exit 2; }

# one lane per card (no --gpus: one lane, the card the environment gives: CUDA_VISIBLE_DEVICES or the first)
IFS=, read -r -a lanes <<<"${gpus:-}"
((${#lanes[@]})) || lanes=("")

# key shot $1 on card $2; its log and report go in $logs, its exit code in $logs/shot-N.exit
key_shot() {
    local n="$1" gpu="$2" args
    args=(render --input "${inputs[n]}" --output "${outputs[n]}" "$existing" --progress-format plain --report "$logs/shot-$n.report.json")
    [[ "${frames[n]}" != "-" ]] && args+=(--frames "${frames[n]}")
    [[ -n "$gpu" ]] && args+=(--gpu "$gpu")
    echo "shot $n${gpu:+ on GPU $gpu}: ${inputs[n]} -> ${outputs[n]}"
    "$ck" "${args[@]}" ${extra[@]+"${extra[@]}"} >"$logs/shot-$n.log" 2>&1
    local code=$?
    echo "$code" >"$logs/shot-$n.exit"
    echo "shot $n: exit $code"
}

# lane k keys shots k, k+L, k+2L, ... one after another
run_lane() {
    local k="$1" n
    trap : TERM # a stop: corridorkey gets the TERM too; the lane records its exit, then starts nothing new
    # --gpu N counts in CUDA's order, fastest card first by default: PCI bus order makes it nvidia-smi's on mixed-card
    # machines (as the Deadline plugin does; the lane is a subshell, so this stays in it)
    [[ -n "${lanes[k]}" ]] && export CUDA_DEVICE_ORDER=PCI_BUS_ID
    # loop: NOT-WORTH — the lane's shots, one corridorkey run each [bounded: the shot list]
    for ((n = k; n < ${#inputs[@]}; n += ${#lanes[@]})); do
        [[ -e "$stop" ]] && break
        key_shot "$n" "${lanes[k]}"
    done
}

# Each lane runs in its own process group (set -m), so Ctrl+C reaches only this script, which sends the lanes one
# SIGTERM: corridorkey stops after the frame or window it is on (exit 143) and no new shot starts.
stop="$logs/.stop"
rm -f "$stop" "$logs"/shot-*.exit
set -m
pids=()
# set before the first lane starts, so a stop while lanes are starting reaches the ones already running (a lane, a
# subshell, doesn't inherit it)
trap '[[ -e "$stop" ]] || { touch "$stop"; for p in ${pids[@]+"${pids[@]}"}; do kill -TERM -- "-$p" 2>/dev/null; done; }' INT TERM
# loop: NOT-WORTH — one background lane per card
for k in "${!lanes[@]}"; do
    run_lane "$k" &
    pids+=($!)
done
# loop: NOT-WORTH — waits for each lane; a signal interrupts wait, so wait again [bounded: each lane ends after its last shot]
for p in "${pids[@]}"; do
    # loop: SERIAL-REQUIRED — a signal interrupts wait, so wait again [bounded: the lane ends after its last shot]
    while kill -0 "$p" 2>/dev/null; do wait "$p"; done
done
rm -f "$stop"

failed=0
printf '\n%-5s %-6s %s\n' shot exit input
# loop: NOT-WORTH — one line per shot for the summary
for n in "${!inputs[@]}"; do
    code=$(cat "$logs/shot-$n.exit" 2>/dev/null || echo "-")
    [[ "$code" == 0 ]] || failed=$((failed + 1))
    printf '%-5s %-6s %s\n' "$n" "$code" "${inputs[n]}"
done
echo "logs and reports: $logs/ (shot-N.log, shot-N.report.json)"
((failed == 0)) || { echo "$failed of ${#inputs[@]} shot(s) not done (exit '-': not run)"; exit 1; }
