#!/usr/bin/env bash
# Cut a release from this PC (Marcy 2026-10-24: build here, upload the release; GitHub doesn't build).
#
#   tools/release.sh            the version in package.json: X.Y.Z (Stable) or X.Y.Z-dev.N (Development)
#
# 1. checks: on main, clean, in step with origin; package.json and the lock carry the version; a CHANGELOG
#    section for it, its header not saying draft / unreleased; the signing key is there; THIRD_PARTY_NOTICES.md is
#    current (tools/gen_notices.mjs --check, which needs cargo-about on PATH or CARGO_ABOUT=<path>); the published
#    wiki is docs/wiki/ (a read-only clone of the wiki repository compared by tools/check_wiki.mjs --published;
#    tools/publish_wiki.mjs publishes it)
# 2. npm run check, npm run check:engine and tools/check_targets.sh (the engine's macOS / Windows lint), then
#    npm run dist:linux (the engine for glibc 2.28, then the AppImage) and npm run dist:win (the Windows engine
#    cross-built here, then the NSIS installer through Wine), memory-capped
# 3. SHA256SUMS / SHA512SUMS of both files and the notes (the CHANGELOG section)
# 4. pushes main, creates the GitHub release as a draft on that commit (no tag yet), uploads, then publishes it,
#    which makes the tag (Development = prerelease, never Latest). A failure anywhere here can simply be rerun.
# 5. the feeds: tools/build-feed.mjs from the published release, signed here with the key in
#    ~/.config/corridorkey-release/feed-signing.pem (read into the environment, never printed),
#    tools/verify-feed.mjs checks them exactly as the app does, then they are committed to main and pushed
# 6. tools/verify-feed.mjs on the live feeds
# Stops at the first failure; nothing is published before step 4. Rerunning after a failure finishes the job:
# a draft release is picked up again, and with v$VERSION already published only the feeds are redone.
# docs/RELEASING.md.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="$HOME/.config/corridorkey-release/feed-signing.pem"
CAP=(systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=8G -p MemorySwapMax=0 --)

v="$(node -p 'require("./package.json").version')"
if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then dev=false
elif [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+-dev\.[0-9]+$ ]]; then dev=true
else echo "release: version $v is neither X.Y.Z nor X.Y.Z-dev.N" >&2; exit 1; fi
[ "$(node -p 'require("./package-lock.json").version')" = "$v" ] || { echo "release: package-lock.json isn't at $v" >&2; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "release: not on main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "release: uncommitted changes" >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-list --count HEAD..origin/main)" = 0 ] || { echo "release: origin/main has commits this copy lacks" >&2; exit 1; }
# none = new; true = a draft left by a failed run (finished now); false = published (only the feeds are redone)
state="$(gh release view "v$v" --json isDraft -q .isDraft 2>/dev/null || echo none)"
grep -q "^## $v\( \|$\)" CHANGELOG.md || { echo "release: CHANGELOG.md has no '## $v' section" >&2; exit 1; }
grep "^## $v\( \|$\)" CHANGELOG.md | grep -qiE 'draft|unreleased' && { echo "release: CHANGELOG.md's '## $v' header still says draft / unreleased" >&2; exit 1; }
# the published wiki must be docs/wiki/ (docs/RELEASING.md "The wiki"): a read-only shallow clone, compared page by page
wiki="$(mktemp -d)"; trap 'rm -rf "$wiki"' EXIT
git clone -q --depth 1 "$(git remote get-url origin | sed 's/\.git$//').wiki.git" "$wiki"
node tools/check_wiki.mjs --published "$wiki" || { echo "release: publish docs/wiki/ first (node tools/publish_wiki.mjs <wiki clone> --push)" >&2; exit 1; }
[ -r "$KEY" ] || { echo "release: no signing key at $KEY" >&2; exit 1; }
# cargo-about 0.9.2 lives with the other release tools (cargo install --locked --features cli cargo-about --root …)
export CARGO_ABOUT="${CARGO_ABOUT:-$HOME/.local/share/corridorkey-release/cargo-about/bin/cargo-about}"
"${CAP[@]}" node tools/gen_notices.mjs --check

if [ "$state" != false ]; then
NODE_OPTIONS=--max-old-space-size=4096 "${CAP[@]}" npm run -s check
# the engine's own checks (cargo fmt, clippy -D warnings, cargo test) and its macOS / Windows lint (capped inside)
systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=12G -p MemorySwapMax=0 -- npm run -s check:engine
tools/check_targets.sh
NODE_OPTIONS=--max-old-space-size=4096 "${CAP[@]}" npm run -s dist:linux
NODE_OPTIONS=--max-old-space-size=4096 "${CAP[@]}" npm run -s dist:win

file="CorridorKey-Desktop-$v.AppImage"
winfile="CorridorKey-Desktop-$v-Setup.exe"
# loop: NOT-WORTH — the two release files
for f in "$file" "$winfile"; do [ -f "release/$f" ] || { echo "release: release/$f was not built" >&2; exit 1; }; done
(cd release && sha256sum "$file" "$winfile" > SHA256SUMS && sha512sum "$file" "$winfile" > SHA512SUMS)
# loop: NOT-WORTH — one pass over CHANGELOG.md for this version's section
awk -v v="$v" '$0 == "## " v || index($0, "## " v " ") == 1 {on=1; next} on && /^## / {exit} on' CHANGELOG.md > release/notes.md
[ -s release/notes.md ] || echo "See CHANGELOG.md." > release/notes.md
if [ "$dev" = true ]; then
  printf '\n**This is a development build**: newer than the stable release and less tested. The app offers it only with Update channel set to Development.\n' >> release/notes.md
fi

git push origin main
flags=(--title "CorridorKey $v" --notes-file release/notes.md)
if [ "$dev" = true ]; then flags+=(--prerelease --latest=false); else flags+=(--latest); fi
[ "$state" = true ] || gh release create "v$v" --draft --target "$(git rev-parse HEAD)" "${flags[@]}"
gh release upload "v$v" "release/$file" "release/$winfile" release/SHA256SUMS release/SHA512SUMS --clobber
gh release edit "v$v" --draft=false
git fetch -q origin "refs/tags/v$v:refs/tags/v$v"
else
  echo "release: v$v is published already: redoing the feeds"
fi

# GitHub's release list can lag right after publishing: the released channel's feed must name v$v (a few tries)
mine=latest.json; [ "$dev" = true ] && mine=latest-dev.json
# loop: SERIAL-REQUIRED — polling until a deadline [bounded: 6 tries, 10 s apart]
for try in 1 2 3 4 5 6; do
  GITHUB_TOKEN="$(gh auth token)" node tools/build-feed.mjs --channel stable --out latest.json || [ $? -eq 2 ]
  GITHUB_TOKEN="$(gh auth token)" node tools/build-feed.mjs --channel dev --out latest-dev.json || [ $? -eq 2 ]
  [ -f "$mine" ] && [ "$(node -p "require('./$mine').version")" = "$v" ] && break
  [ "$try" = 6 ] && { echo "release: $mine doesn't name $v yet; rerun tools/release.sh to finish the feeds" >&2; exit 1; }
  # loop: SERIAL-REQUIRED — waits between feed tries [bounded: 6 tries, 10 s apart]
  sleep 10
done
feeds=()
# loop: NOT-WORTH — the two feed files
for f in latest.json latest-dev.json; do [ -f "$f" ] && feeds+=("$f"); done
CK_FEED_KEY="$(cat "$KEY")" bash -c 'for f in "$@"; do node tools/sign-feed.mjs "$f"; done' _ "${feeds[@]}"
node tools/verify-feed.mjs "${feeds[@]}"
# loop: NOT-WORTH — adds the feed files and their signatures
for f in "${feeds[@]}"; do git add "$f" "$f.sig"; done
if ! git diff --cached --quiet; then
  git commit -q -m "chore(feed): v$v"
  # someone pushed meanwhile (the laptop): put the feed commit on top and push once more
  git push origin main || { git pull -q --rebase origin main && git push origin main; }
fi
node tools/verify-feed.mjs
echo "release: v$v published"
