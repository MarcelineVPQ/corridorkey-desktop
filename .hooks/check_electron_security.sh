#!/usr/bin/env bash
# Pre-commit / CI gate: the Electron security baseline must not regress.
#
# Blocks, anywhere in electron/ and src/:
#   nodeIntegration: true        renderer gets Node
#   contextIsolation: false      preload and page share a JS world
#   sandbox: false               renderer runs unsandboxed
#   webSecurity: false           same-origin policy off
#   allowRunningInsecureContent  mixed content allowed
#   enableRemoteModule           legacy remote module
#   ipcRenderer exposed directly via contextBridge
#   shell: true                  a command line through the system shell (spawn / execFile with a shell)
#   exec( / execSync(            child_process's shell-string runners: the app runs a fixed program with an argv
#                                (execFile / spawn) only. Also child_process.exec, `exec as`, and child_process
#                                imported whole (namespace, default, require, dynamic import()), so every use is a
#                                named import.
# and, unless the line or the one above says `gate: shell-ok — why` (a reviewed use; senior review 2026-10-26 S5):
#   shell: <anything but false>  a shell by another spelling ("/bin/bash", an expression)
#   spawn / execFile of a shell  sh, bash, zsh, dash, ksh, fish, cmd(.exe), powershell(.exe), pwsh(.exe) by name
#   "-c" "/c" "-Command"         a shell's command-string argument, wherever an argv is built
#   shell.openPath               opens a path with its default program (an .exe, a script: runs it)
#
# Requires the renderer's Content-Security-Policy (electron.vite.config.ts, injected into index.html at build):
#   default-src 'self', script-src 'self' (never 'unsafe-inline' or 'unsafe-eval'), object-src 'none',
#   base-uri 'none', and the csp() plugin on the renderer.
# Requires, in electron/: a permission request handler and a permission check handler (Electron grants every permission
# by default), a will-navigate handler that calls preventDefault on its line, and a window-open handler; never
# `action: "allow"` for a new window.
#
# Requires Electron's fuses in electron-builder.yml (electronFuses): enableNodeOptionsEnvironmentVariable: false,
# enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, and
# runAsNode: false unless the line above it says `gate: run-as-node-ok — why` (whole-code review 2026-10-27).
#
# From the DS5 app (same baseline). Optional argument: the tree to check (tests use fixtures); default the repo.
set -uo pipefail
cd "${1:-$(git rev-parse --show-toplevel)}"

cp='["'"'"'](node:)?child_process["'"'"']'
hits=$(grep -rnE \
  'nodeIntegration\s*:\s*true|contextIsolation\s*:\s*false|sandbox\s*:\s*false|webSecurity\s*:\s*false|allowRunningInsecureContent|enableRemoteModule|exposeInMainWorld\([^)]*ipcRenderer'\
'|shell\s*:\s*true'\
'|(^|[^.[:alnum:]_$])exec(Sync)?\s*\(|\.execSync\s*\(|child_process\.exec|\bexec(Sync)?\s+as\b'\
"|import\s+(\*\s+as\s+)?[[:alnum:]_\$]+\s+from\s+$cp|require\(\s*$cp" \
  electron src --include='*.ts' --include='*.tsx' --include='*.js' 2>/dev/null)

# the shell rules: a hit passes only with the marker on its line or the line above
q="[\"'\`]"
shellHits=$( {
  grep -rnE "(^|[{,])[[:space:]]*shell[[:space:]]*:" electron src --include='*.ts' --include='*.tsx' --include='*.js' 2>/dev/null |
    grep -vE ":[0-9]+:.*shell[[:space:]]*:[[:space:]]*false([^[:alnum:]_\$]|$)"
  grep -rniE "(spawn|execFile)(Sync)?[[:space:]]*\([[:space:]]*$q([^\"'\`]*[/\\])?(sh|bash|zsh|dash|ksh|fish|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe)$q" \
    electron src --include='*.ts' --include='*.tsx' --include='*.js' 2>/dev/null
  grep -rnE "$q(-c|/c|/C|-Command|-command|-EncodedCommand)$q|import\([[:space:]]*$cp|shell\.openPath" \
    electron src --include='*.ts' --include='*.tsx' --include='*.js' 2>/dev/null
} | sort -u)
# loop: NOT-WORTH — the few hits, one sed each, once per gate run
while IFS= read -r h; do
  [ -n "$h" ] || continue
  f=${h%%:*}
  rest=${h#*:}
  n=${rest%%:*}
  sed -n "$(( n > 1 ? n - 1 : 1 )),${n}p" "$f" | grep -q "gate: shell-ok" || hits="${hits:+$hits
}$h"
done <<< "$shellHits"

if [ -n "$hits" ]; then
  echo "Electron security gate: forbidden setting found"
  echo "$hits"
  exit 1
fi

# the CSP: each directive present, nothing loosening scripts, the plugin on the renderer
cfg=electron.vite.config.ts
missing=""
for d in "\"default-src 'self'\"" "\"script-src 'self'\"" "\"object-src 'none'\"" "\"base-uri 'none'\"" "plugins: [react(), csp()]"; do # loop: NOT-WORTH — five fixed strings
  grep -qF -- "$d" "$cfg" 2>/dev/null || missing="$missing $d"
done
if [ -n "$missing" ] || grep -qE "unsafe-eval|script-src[^\"]*unsafe-inline" "$cfg" 2>/dev/null; then
  echo "Electron security gate: the renderer's Content-Security-Policy ($cfg) is missing or loosened:${missing:- unsafe-eval / unsafe-inline scripts}"
  exit 1
fi

# permissions and navigation
missing=""
src() { grep -rnE "$1" electron --include='*.ts' --include='*.tsx' --include='*.js' 2>/dev/null; }
src 'setPermissionRequestHandler\(' >/dev/null || missing="$missing setPermissionRequestHandler"
src 'setPermissionCheckHandler\(' >/dev/null || missing="$missing setPermissionCheckHandler"
src "[\"']will-navigate[\"'].*preventDefault\(\)" >/dev/null || missing="$missing will-navigate(preventDefault)"
src 'setWindowOpenHandler\(' >/dev/null || missing="$missing setWindowOpenHandler"
allow=$(src "action[[:space:]]*:[[:space:]]*[\"'\`]allow")
if [ -n "$missing" ] || [ -n "$allow" ]; then
  echo "Electron security gate: permissions / navigation:${missing:+ missing$missing}${allow:+ a new window allowed:
$allow}"
  exit 1
fi

# Electron's fuses (electron-builder.yml): each one set as required, under electronFuses
yml=electron-builder.yml
missing=""
grep -q '^electronFuses:' "$yml" 2>/dev/null || missing=" electronFuses:"
for f in "enableNodeOptionsEnvironmentVariable: false" "enableNodeCliInspectArguments: false" "enableEmbeddedAsarIntegrityValidation: true" "onlyLoadAppFromAsar: true"; do # loop: NOT-WORTH — four fixed fuses
  grep -qE "^[[:space:]]+$f[[:space:]]*(#.*)?$" "$yml" 2>/dev/null || missing="$missing $f"
done
n=$(grep -nE '^[[:space:]]+runAsNode:' "$yml" 2>/dev/null | head -1 | cut -d: -f1)
if [ -z "$n" ]; then missing="$missing runAsNode (on unless set)"
elif ! sed -n "${n}p" "$yml" | grep -qE 'runAsNode:[[:space:]]*false' && ! sed -n "$((n > 1 ? n - 1 : 1))p" "$yml" | grep -q "gate: run-as-node-ok"; then
  missing="$missing runAsNode: false (or 'gate: run-as-node-ok — why' on the line above)"
fi
if [ -n "$missing" ]; then
  echo "Electron security gate: the fuses in $yml are missing or loosened:$missing"
  exit 1
fi
exit 0
