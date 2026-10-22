#!/usr/bin/env bash
# End-to-end self-update test: an older AppImage updates itself to a newer one
# from a local signed test feed, isolated (rule 12): its own headless Wayland
# compositor (kwin_wayland --virtual: the app is Wayland-only), a private D-Bus
# with no services, its own HOME and XDG_RUNTIME_DIR, basic password store.
# Never your screen, session bus, keyring or real feed.
#
#   tools/update_e2e.sh --dir DIR --old OLD.AppImage --new NEW.AppImage --version X.Y.Z-dev.N
#
# DIR gets: run/ (the old AppImage, where the update lands beside it), srv/
# (the feed + the new AppImage, served on 127.0.0.1:8765), keys, logs, and on a
# failure diag.txt (each test process's state, kernel wait channel, open files
# and AppImage mounts).
# The restart's systemd-run path can't reach your user manager from inside the
# isolation (on purpose), so it takes its fallback: a detached shell.
# Run it memory-capped (memrun.sh / a systemd scope): it starts two Electron copies.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
DIR="" OLD="" NEW="" VER=""
# loop: NOT-WORTH — the command line
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --old) OLD="$2"; shift 2 ;;
    --new) NEW="$2"; shift 2 ;;
    --version) VER="$2"; shift 2 ;;
    *) echo "update_e2e.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$DIR" ] && [ -f "$OLD" ] && [ -f "$NEW" ] && [ -n "$VER" ] || { echo "usage: see the header" >&2; exit 2; }
DIR="$(mkdir -p "$DIR" && cd "$DIR" && pwd)"
mkdir -p "$DIR/run" "$DIR/srv/v$VER" "$DIR/home" "$DIR/iso/no-services"
cp "$OLD" "$DIR/run/" && chmod +x "$DIR/run/$(basename "$OLD")"
cp "$NEW" "$DIR/srv/v$VER/"

# A throwaway key pair: the private key signs the test feed, the public key goes only to the test app.
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');require('fs').writeFileSync('$DIR/test-key.pem',k.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});process.stdout.write(k.publicKey.export({format:'der',type:'spki'}).toString('base64'))" > "$DIR/test-key.pub"
# The feed, with the app's own feedText (tools/feed-rules.mjs), then signed like CI.
node --input-type=module -e "
import { createHash } from 'node:crypto'; import { readFileSync, writeFileSync } from 'node:fs';
const { feedText } = await import('$APP/tools/feed-rules.mjs');
const data = readFileSync('$DIR/srv/v$VER/' + '$(basename "$NEW")');
const text = feedText('dev', { tag: 'v$VER', version: '$VER', notes: 'Update test build' }, { sha512: createHash('sha512').update(data).digest('hex'), size: data.length }, 'http://127.0.0.1:8765/');
writeFileSync('$DIR/srv/latest-dev.json', text); console.log(text);"
CK_FEED_KEY="$(cat "$DIR/test-key.pem")" node "$APP/tools/sign-feed.mjs" "$DIR/srv/latest-dev.json" >/dev/null

PIDS=()
RUN=""
# The test copies' processes: anything started from DIR/run (both AppImages, their mounts' Electron) and the shell between them.
test_pids() { pgrep -f -- "$DIR/run/|/tmp/.mount_CorridKey|\.mount_Corrid" 2>/dev/null || true; }
diag() {
  set +o pipefail
  {
    echo "=== $(date -Is) diagnostics"
    echo "--- AppImage mounts:"; grep -E "mount_Corrid" /proc/self/mountinfo | cut -d' ' -f5 || true
    echo "--- the test copies' process trees:"
    # loop: NOT-WORTH — the test copies' few processes, once on failure
    for p in $(test_pids); do timeout 5 ps --forest -o pid,ppid,stat,wchan:30,args -g "$(ps -o sid= -p "$p" | tr -d ' ')" 2>/dev/null | cut -c1-220; done | sort -u
    # loop: NOT-WORTH — the test copies' few processes, once on failure
    for p in $(test_pids); do
      [ -r "/proc/$p/status" ] || continue
      echo "--- pid $p ppid $(awk '/^PPid/{print $2}' "/proc/$p/status") state $(awk '/^State/{print $2}' "/proc/$p/status") wchan $(cat "/proc/$p/wchan" 2>/dev/null)"
      tr '\0' ' ' < "/proc/$p/cmdline" | cut -c1-200; echo
      echo "  env: $(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -E '^(WAYLAND_DISPLAY|DISPLAY|XDG_RUNTIME_DIR|APPIMAGE|APPDIR)=' | tr '\n' ' ')"
      # loop: NOT-WORTH — one process's open files, once on failure
      for fd in /proc/$p/fd/*; do printf '  fd %s -> %s\n' "${fd##*/}" "$(readlink "$fd" 2>/dev/null)"; done | grep -E "pipe:|/dev/fuse|mount_Corrid[^/]*$|AppImage"
      # loop: NOT-WORTH — one process's threads, once on failure
      for t in /proc/$p/task/*; do printf '  thread %s %s %s\n' "${t##*/}" "$(cat "$t/comm" 2>/dev/null)" "$(cat "$t/wchan" 2>/dev/null)"; done
      if ! grep -q /dev/fuse < <(ls -l /proc/$p/fd 2>/dev/null); then
        echo "  strace (3 s, main thread):"
        timeout 3 strace -p "$p" -tt -s 120 2>&1 | head -30 | sed 's/^/    /'
      fi
    done
  } >> "$DIR/diag.txt" 2>&1
  set -o pipefail
}
cleanup() {
  # loop: NOT-WORTH — the test copies' few processes at cleanup
  for p in $(test_pids); do kill "$p" 2>/dev/null || true; done
  # loop: NOT-WORTH — the harness's own few processes at cleanup
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  # loop: SERIAL-REQUIRED — 1 s for the copies to go before the leftover check [bounded: one second]
  sleep 1
  # loop: NOT-WORTH — stragglers after SIGTERM, once at cleanup
  for p in $(test_pids); do kill -9 "$p" 2>/dev/null || true; done
  [ -n "$RUN" ] && rm -rf "$RUN"
}
trap cleanup EXIT

python3 -m http.server 8765 --bind 127.0.0.1 --directory "$DIR/srv" > "$DIR/http.log" 2>&1 &
PIDS+=($!)
RUN="$(mktemp -d /tmp/ck-upd-XXXXXX)"   # a socket path must fit 108 bytes; tiny, removed at exit
chmod 700 "$RUN"
cat > "$DIR/iso/session.conf" <<CONF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=$RUN</listen>
  <auth>EXTERNAL</auth>
  <servicedir>$DIR/iso/no-services</servicedir>
  <policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>
CONF
dbus-daemon --config-file="$DIR/iso/session.conf" --nofork --print-address=1 > "$DIR/bus.addr" 2>"$DIR/bus.log" &
PIDS+=($!)
# loop: SERIAL-REQUIRED — 1 s for the private bus to start
sleep 1
BUS="$(head -1 "$DIR/bus.addr")"
WL="ck-wl-upd"
ISO_ENV=(HOME="$DIR/home" USER="$USER" PATH="/usr/local/bin:/usr/bin:/bin" LANG="${LANG:-C.UTF-8}"
  XDG_RUNTIME_DIR="$RUN" DBUS_SESSION_BUS_ADDRESS="$BUS" XDG_SESSION_TYPE=wayland
  XDG_CONFIG_HOME="$DIR/home/.config" XDG_CACHE_HOME="$DIR/home/.cache" XDG_DATA_HOME="$DIR/home/.local/share"
  GTK_USE_PORTAL=0 NO_AT_BRIDGE=1 GSETTINGS_BACKEND=memory GIO_USE_VFS=local)
# The compositor outlives both copies (no --exit-with-session: the old copy quits during the test).
env -i "${ISO_ENV[@]}" kwin_wayland --virtual --no-lockscreen --no-global-shortcuts --socket "$WL" --width 1400 --height 900 > "$DIR/kwin.log" 2>&1 &
PIDS+=($!)
# loop: SERIAL-REQUIRED — waits for the compositor's socket, 0.2 s steps [bounded: 10 s]
for _ in $(seq 1 50); do [ -S "$RUN/$WL" ] && break; sleep 0.2; done
[ -S "$RUN/$WL" ] || { echo "kwin_wayland did not start (kwin.log)" >&2; exit 1; }

# The old copy, isolated. Its restart passes the session variables on (relaunch.ts), so the new copy is isolated too.
env -i "${ISO_ENV[@]}" WAYLAND_DISPLAY="$WL" \
  CK_UPDATE_MANIFEST=http://127.0.0.1:8765/latest.json CK_UPDATE_PUBKEY="$(cat "$DIR/test-key.pub")" \
  setsid "$DIR/run/$(basename "$OLD")" --no-sandbox --password-store=basic --remote-debugging-port=0 --enable-logging=file --log-file="$DIR/chromium.log" > "$DIR/app-old.log" 2>&1 &
PIDS+=($!)

# The AppImage mounts every 0.2 s (the old copy's must go once it has quit). Only the mount table: reading
# another process's /proc entries can block while it exits from a FUSE mount (measured: an `ss -p` sampler stalled).
# loop: SERIAL-REQUIRED — a 0.2 s sampler for the test's length [bounded: killed at cleanup]
( while :; do echo "$(date +%T.%N | cut -c1-12) $(grep -oE '/tmp/\.mount_Corrid[^ ]*' /proc/self/mountinfo | tr '\n' ' ')"; sleep 0.2; done > "$DIR/mounts.log" 2>&1 ) &
PIDS+=($!)
# loop: SERIAL-REQUIRED — the driver step and its failure dump (one run)
if ! node "$APP/tools/update_e2e.mjs" --port-file "$DIR/home/.config/corridorkey-desktop/DevToolsActivePort" --expect "$VER" --out "$DIR"; then
  diag
  echo "--- diagnostics: $DIR/diag.txt"
  exit 1
fi
# loop: SERIAL-REQUIRED — 6 s: the mount guard's longest wait, then the old copy's mount must be gone
sleep 6
echo "--- AppImage mounts after the update (only the new copy's may remain):"
grep -E "mount_Corrid" /proc/self/mountinfo | cut -d' ' -f5 || true
diag
echo "--- run/ after the update:"; ls -la "$DIR/run"
