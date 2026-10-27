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
#                                imported whole (namespace, default, require), so every use is a named import.
#
# Requires the renderer's Content-Security-Policy (electron.vite.config.ts, injected into index.html at build):
#   default-src 'self', script-src 'self' (never 'unsafe-inline' or 'unsafe-eval'), object-src 'none',
#   base-uri 'none', and the csp() plugin on the renderer.
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
exit 0
