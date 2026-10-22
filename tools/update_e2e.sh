#!/usr/bin/env bash
# End-to-end self-update test: an older AppImage updates itself to a newer one
# from a local signed test feed, isolated (rule 12): its own Xvfb display, a
# private D-Bus with no services, its own HOME and XDG_RUNTIME_DIR, basic
# password store. Never your screen, session bus, keyring or real feed.
#
#   tools/update_e2e.sh --dir DIR --old OLD.AppImage --new NEW.AppImage --version X.Y.Z-dev.N
#
# DIR gets: run/ (the old AppImage, where the update lands beside it), srv/
# (the feed + the new AppImage, served on 127.0.0.1:8765), keys, logs.
# The restart's systemd-run path can't reach your user manager from inside the
# isolation (on purpose), so it takes its fallback: a detached shell.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
DIR="" OLD="" NEW="" VER=""
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
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  [ -n "${RUN:-}" ] && rm -rf "$RUN"
}
trap cleanup EXIT

python3 -m http.server 8765 --bind 127.0.0.1 --directory "$DIR/srv" > "$DIR/http.log" 2>&1 &
PIDS+=($!)
DISP=":97"
Xvfb "$DISP" -screen 0 1400x900x24 -nolisten tcp > "$DIR/xvfb.log" 2>&1 &
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
sleep 1
BUS="$(head -1 "$DIR/bus.addr")"

# The old copy, isolated. Its restart passes the session variables on (relaunch.ts), so the new copy is isolated too.
env -i HOME="$DIR/home" USER="$USER" PATH="/usr/local/bin:/usr/bin:/bin" LANG="${LANG:-C.UTF-8}" \
  DISPLAY="$DISP" XDG_RUNTIME_DIR="$RUN" DBUS_SESSION_BUS_ADDRESS="$BUS" XDG_SESSION_TYPE=x11 \
  XDG_CONFIG_HOME="$DIR/home/.config" XDG_CACHE_HOME="$DIR/home/.cache" XDG_DATA_HOME="$DIR/home/.local/share" \
  GTK_USE_PORTAL=0 NO_AT_BRIDGE=1 GSETTINGS_BACKEND=memory GIO_USE_VFS=local \
  CK_UPDATE_MANIFEST=http://127.0.0.1:8765/latest.json CK_UPDATE_PUBKEY="$(cat "$DIR/test-key.pub")" \
  setsid "$DIR/run/$(basename "$OLD")" --no-sandbox --password-store=basic --remote-debugging-port=9350 > "$DIR/app-old.log" 2>&1 &
PIDS+=($!)

node "$APP/tools/update_e2e.mjs" --port 9350 --expect "$VER" --out "$DIR" || { echo "--- processes:"; ps -eo pid,args | grep -E "CorridorKey|systemd-run|sleep 0.5" | grep -v grep | cut -c1-160; exit 1; }
echo "--- run/ after the update:"; ls -la "$DIR/run"
