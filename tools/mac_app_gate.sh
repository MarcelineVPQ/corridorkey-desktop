#!/usr/bin/env bash
# The Mac gate through the app itself (BACKLOG row 174): one clip keyed by the installed app's queue on a real Mac, as
# a user does it, where tools/mac_gate.sh keys through the engine and the command line. From this PC over SSH:
#
#   tools/mac_app_gate.sh --host mac --run RUN_ID [--clip DIR_ON_MAC] [--out DIR]
#
#   1. the disk image of macos.yml run RUN_ID (gh run download), copied to the Mac with a browser's quarantine flag;
#      Gatekeeper's verdict on the image and on the app, recorded
#   2. installed over /Applications/CorridorKey.app (the app's data folder stays: a Mac with an older Core ML set gets
#      only the new files, which the setup's byte count shows), started through LaunchServices with a DevTools port
#      (tunnelled here; tools/drive.mjs drives it)
#   3. the setup's download when it needs one, then the clip added and the queue started; every 15 s the job's state
#   4. a report: Gatekeeper's answers, the setup's bytes, the job's provider, frames and time; exit 1 when the job
#      didn't finish on Core ML
#
# The clip: a frame folder already on the Mac (default ~/ck-gate/clips/04_5d_1080, tools/mac_gate.sh's 1920x1080 cut of
# 04_5d). Nothing runs on this PC's graphics card.
set -euo pipefail
HOST="" RUN="" CLIP='~/ck-gate/clips/04_5d_1080' OUT=""
# loop: NOT-WORTH — the command line
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --run) RUN="$2"; shift 2 ;;
    --clip) CLIP="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "mac_app_gate: unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$HOST" ] && [ -n "$RUN" ] || { echo "usage: tools/mac_app_gate.sh --host USER@HOST --run RUN_ID [--clip DIR_ON_MAC] [--out DIR]" >&2; exit 2; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$HOME/.cache/claude-scratch/mac-app-gate/$(date +%F)-$RUN}"
mkdir -p "$OUT"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 "$HOST")
PORT=9334
APP=/Applications/CorridorKey.app
log() { printf '%s\n' "$*" | tee -a "$OUT/report.md"; }
: > "$OUT/report.md"

# 1. the image, as a download
gh run download "$RUN" -n corridorkey-desktop-macos-arm64 -D "$OUT/dmg"
dmg="$(ls "$OUT"/dmg/*.dmg)"
"${SSH[@]}" 'mkdir -p ~/ck-app-gate && find ~/ck-app-gate -name "*.dmg" -delete'
scp -q -o BatchMode=yes "$dmg" "$HOST:ck-app-gate/"
log "# Mac app gate, run $RUN ($(basename "$dmg"))"
"${SSH[@]}" bash -s > "$OUT/gatekeeper.txt" 2>&1 <<'EOF' || true
set -u
d=$(ls ~/ck-app-gate/*.dmg)
# loop: NOT-WORTH — a running copy ends before the install replaces it (one pause)
pkill -f '/Applications/CorridorKey.app/Contents/MacOS/' ; sleep 2
xattr -w com.apple.quarantine "0083;$(printf %x $(date +%s));Safari;" "$d"
echo "== the image"; spctl --assess --type open --context context:primary-signature -vv "$d" 2>&1
mnt=$(mktemp -d); hdiutil attach "$d" -nobrowse -readonly -mountpoint "$mnt" > /dev/null
rm -rf /Applications/CorridorKey.app && ditto "$mnt/CorridorKey.app" /Applications/CorridorKey.app
hdiutil detach "$mnt" > /dev/null
xattr -w com.apple.quarantine "0083;$(printf %x $(date +%s));Safari;" /Applications/CorridorKey.app
echo "== the app"; spctl --assess --type execute -vv /Applications/CorridorKey.app 2>&1
# the verdict is recorded; the flag comes off as "Open" does, so the start below needs no click on the Mac's screen
xattr -dr com.apple.quarantine /Applications/CorridorKey.app
EOF
log ""; log "## Gatekeeper"; log '```'; grep -E "^==|accepted|rejected|source=" "$OUT/gatekeeper.txt" | tee -a "$OUT/report.md"; log '```'

# 2. started as a user starts it, its DevTools port tunnelled here
"${SSH[@]}" "open -a $APP --args --remote-debugging-port=$PORT"
"${SSH[@]}" -N -o ExitOnForwardFailure=yes -L "$PORT:localhost:$PORT" &
tunnel=$!
trap 'kill $tunnel 2>/dev/null || true' EXIT
d() { node "$REPO/tools/drive.mjs" --port "$PORT" --out "$OUT/shots" "$@" 2>&1 | sed -n 's/^eval: //p'; }
st() { d --eval "window.ck.getState().then(s=>JSON.stringify($1))" | tr -d '\\' | sed 's/^"//; s/"$//'; }
# loop: SERIAL-REQUIRED — waits for the app's page (first start compiles nothing; Gatekeeper's scan of a new app can take a minute) [bounded: 40 tries, 5 s apart]
for _ in $(seq 40); do st '1' > /dev/null 2>&1 && [ -n "$(st '1')" ] && break; sleep 5; done

# 3. the setup, when it needs anything
need="$(st '{needRuntime:s.install.needRuntime,needModels:s.install.needModels,bytes:s.install.bytes}')"
log ""; log "## Setup"; log "before: $need"
if ! grep -q '"needRuntime":false,"needModels":false' <<< "$need"; then
  d --eval "window.ck.startInstall().then(()=>'started')" > /dev/null
  # loop: SERIAL-REQUIRED — follows the download [bounded: 240 tries, 15 s apart = 1 h]
  for _ in $(seq 240); do
    s="$(st '{status:s.install.status,error:s.install.error}')"
    grep -q '"status":"running"' <<< "$s" || break
    # loop: NOT-WORTH — the poll's pause (the loop above is bounded)
    sleep 15
  done
  log "after: $(st '{needRuntime:s.install.needRuntime,needModels:s.install.needModels,status:s.install.status,error:s.install.error}')"
fi

# 4. one clip through the queue
mclip="$("${SSH[@]}" "cd $CLIP && pwd")"
d --eval "window.ck.addPaths(['$mclip']).then(()=>'added')" > /dev/null
# loop: NOT-WORTH — one pause while the app probes the clip it was given
sleep 3
d --eval "window.ck.startQueue().then(()=>'started')" > /dev/null
t0=$(date +%s)
# loop: SERIAL-REQUIRED — follows the job [bounded: 120 tries, 15 s apart = 30 min]
for _ in $(seq 120); do
  s="$(st 's.jobs.map(j=>j.status).join()')"
  grep -qE 'waiting|preparing|running' <<< "$s" || break
  # loop: NOT-WORTH — the poll's pause (the loop above is bounded)
  sleep 15
done
job="$(st '(j=>({status:j.status,frames:j.clip.frames,provider:j.tech&&j.tech.provider,precision:j.tech&&j.tech.precision,modelSet:j.tech&&j.tech.modelSet,error:j.error&&j.error.message}))(s.jobs[s.jobs.length-1])')"
log ""; log "## The job ($mclip)"; log "$job"; log "wall time from Start queue: $(( $(date +%s) - t0 )) s"
d --close > /dev/null || true
grep -q '"status":"done"' <<< "$job" && grep -q '"provider":"coreml"' <<< "$job" || { log ""; log "VERDICT: FAIL (the job didn't finish on Core ML)"; exit 1; }
log ""; log "VERDICT: PASS (the installed app keyed the clip on Core ML)"
