#!/usr/bin/env bash
# Cut a release from this PC (Marcy 2026-10-24: build here, upload the release; GitHub doesn't build).
#
#   tools/release.sh            the version in package.json: X.Y.Z (Stable) or X.Y.Z-dev.N (Development)
#
# 1. checks: on main, clean, in step with origin; package.json and the lock carry the version; a CHANGELOG
#    section for it; the signing key is there
# 2. npm run check, then npm run dist:linux (the engine for glibc 2.28, then the AppImage), memory-capped
# 3. SHA256SUMS / SHA512SUMS and the notes (the CHANGELOG section)
# 4. tags vVERSION, pushes main + the tag, publishes the GitHub release (Development = prerelease, never Latest)
# 5. the feeds: tools/build-feed.mjs from the published release, signed here with the key in
#    ~/.config/corridorkey-release/feed-signing.pem (read into the environment, never printed),
#    tools/verify-feed.mjs checks them exactly as the app does, then they are committed to main and pushed
# 6. tools/verify-feed.mjs on the live feeds
# Stops at the first failure; nothing is published before step 4. docs/RELEASING.md.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="$HOME/.config/corridorkey-release/feed-signing.pem"
CAP=(systemd-run --user --scope --quiet --collect -p MemoryMax=8G -p MemorySwapMax=0 --)

v="$(node -p 'require("./package.json").version')"
if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then dev=false
elif [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+-dev\.[0-9]+$ ]]; then dev=true
else echo "release: version $v is neither X.Y.Z nor X.Y.Z-dev.N" >&2; exit 1; fi
[ "$(node -p 'require("./package-lock.json").version')" = "$v" ] || { echo "release: package-lock.json isn't at $v" >&2; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "release: not on main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "release: uncommitted changes" >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-list --count HEAD..origin/main)" = 0 ] || { echo "release: origin/main has commits this copy lacks" >&2; exit 1; }
! git rev-parse -q --verify "refs/tags/v$v" >/dev/null || { echo "release: tag v$v exists" >&2; exit 1; }
grep -q "^## $v\( \|$\)" CHANGELOG.md || { echo "release: CHANGELOG.md has no '## $v' section" >&2; exit 1; }
[ -r "$KEY" ] || { echo "release: no signing key at $KEY" >&2; exit 1; }

NODE_OPTIONS=--max-old-space-size=4096 "${CAP[@]}" npm run -s check
NODE_OPTIONS=--max-old-space-size=4096 "${CAP[@]}" npm run -s dist:linux

file="CorridorKey-Desktop-$v.AppImage"
[ -f "release/$file" ] || { echo "release: release/$file was not built" >&2; exit 1; }
(cd release && sha256sum "$file" > SHA256SUMS && sha512sum "$file" > SHA512SUMS)
# loop: NOT-WORTH — one pass over CHANGELOG.md for this version's section
awk -v v="$v" '$0 == "## " v || index($0, "## " v " ") == 1 {on=1; next} on && /^## / {exit} on' CHANGELOG.md > release/notes.md
[ -s release/notes.md ] || echo "See CHANGELOG.md." > release/notes.md
if [ "$dev" = true ]; then
  printf '\n**This is a development build**: newer than the stable release and less tested. The app offers it only with Update channel set to Development.\n' >> release/notes.md
fi

git tag "v$v"
git push origin main "v$v"
flags=(--verify-tag --title "CorridorKey $v" --notes-file release/notes.md)
if [ "$dev" = true ]; then flags+=(--prerelease --latest=false); else flags+=(--latest); fi
gh release create "v$v" --draft "${flags[@]}"
gh release upload "v$v" "release/$file" release/SHA256SUMS release/SHA512SUMS
gh release edit "v$v" --draft=false

GITHUB_TOKEN="$(gh auth token)" node tools/build-feed.mjs --channel stable --out latest.json || [ $? -eq 2 ]
GITHUB_TOKEN="$(gh auth token)" node tools/build-feed.mjs --channel dev --out latest-dev.json || [ $? -eq 2 ]
feeds=()
# loop: NOT-WORTH — the two feed files
for f in latest.json latest-dev.json; do [ -f "$f" ] && feeds+=("$f"); done
CK_FEED_KEY="$(cat "$KEY")" bash -c 'for f in "$@"; do node tools/sign-feed.mjs "$f"; done' _ "${feeds[@]}"
node tools/verify-feed.mjs "${feeds[@]}"
# loop: NOT-WORTH — adds the feed files and their signatures
for f in "${feeds[@]}"; do git add "$f" "$f.sig"; done
if ! git diff --cached --quiet; then
  git commit -q -m "chore(feed): v$v"
  git push origin main
fi
node tools/verify-feed.mjs
echo "release: v$v published"
