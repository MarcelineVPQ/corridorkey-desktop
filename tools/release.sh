#!/usr/bin/env bash
# Cut a release from this PC (Marcy 2026-10-24: build here, upload the release; GitHub doesn't build).
#
#   tools/release.sh            the version in package.json: X.Y.Z (Stable) or X.Y.Z-dev.N (Development)
#   tools/release.sh --feeds    only the feeds of that version, published already (step 5 failed)
#   tools/release.sh --mac DMG  adds the macOS disk image (built from the tag: docs/RELEASING.md "macOS") to that
#                               published version, with the SUMS extended to it and signed again
#
# 1. checks: on main, clean, in step with origin; the version not released yet (no tag, no published release; --feeds:
#    published); package.json and the lock carry the version; a CHANGELOG
#    section for it, the top one, its header not saying draft / unreleased; the signing key is there; THIRD_PARTY_NOTICES.md is
#    current (tools/gen_notices.mjs --check, which needs cargo-about on PATH or CARGO_ABOUT=<path>); the published
#    wiki is docs/wiki/ (a read-only clone of the wiki repository compared by tools/check_wiki.mjs --published;
#    tools/publish_wiki.mjs publishes it); every pinned model set on GitHub as pinned (tools/check_model_sets.mjs)
# 2. the docs-touch gate over the commits since the last release tag, npm run check:engine (which builds the
#    corridorkey the CLI-spec drift check then compares against: never skipped here), npm run check and
#    tools/check_targets.sh (the engine's Linux / Windows / macOS lint), then
#    npm run dist:linux (the engine for glibc 2.28, then the AppImage) and npm run dist:win (the Windows engine
#    cross-built here, then the NSIS installer through Wine), memory-capped; a build that changed a tracked file
#    (the CLI spec) stops here, so what ships is the commit that gets tagged
# 3. SHA256SUMS / SHA512SUMS of both files, signed with the feed key (.sig beside each), and the notes (the CHANGELOG
#    section)
# 4. pushes main, creates the GitHub release as a draft on that commit (no tag yet; a draft left by a failed run is
#    moved to this commit with these notes), uploads, then publishes it, which makes the tag (Development =
#    prerelease, never Latest). A failure anywhere here can simply be rerun.
# 5. the feeds: tools/build-feed.mjs from the published release, signed here with the key in
#    ~/.config/corridorkey-release/feed-signing.pem (read into the environment, never printed),
#    tools/verify-feed.mjs checks them exactly as the app does, then they are committed to main and pushed
# 6. tools/verify-feed.mjs on the released channel's live feed, which must name this version (a few tries)
# Stops at the first failure; nothing is published before step 4. Rerunning after a failure finishes the job:
# a draft release is picked up again; once v$VERSION is published, --feeds redoes only the feeds.
# docs/RELEASING.md.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="$HOME/.config/corridorkey-release/feed-signing.pem"
CAP=(systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=8G -p MemorySwapMax=0 --)

mode="${1:-}"
case "$mode" in "" | --feeds | --mac) ;; *) echo "release: unknown option $mode (--feeds, --mac DMG)" >&2; exit 2 ;; esac
v="$(node -p 'require("./package.json").version')"
if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then dev=false
elif [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+-dev\.[0-9]+$ ]]; then dev=true
else echo "release: version $v is neither X.Y.Z nor X.Y.Z-dev.N" >&2; exit 1; fi
[ "$(node -p 'require("./package-lock.json").version')" = "$v" ] || { echo "release: package-lock.json isn't at $v" >&2; exit 1; }
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "release: not on main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "release: uncommitted changes" >&2; exit 1; }
git fetch -q --tags origin main
[ "$(git rev-list --count HEAD..origin/main)" = 0 ] || { echo "release: origin/main has commits this copy lacks" >&2; exit 1; }
# none = new; true = a draft left by a failed run (finished now); false = published (--feeds: only the feeds redone)
state="$(gh release view "v$v" --json isDraft -q .isDraft 2>/dev/null || echo none)"
# a released version is refused (senior review 2026-10-27 N13: run before the bump, it re-signed the last release's
# feeds); --feeds is only for a published one
[ "$state" = false ] && [ -z "$mode" ] && { echo "release: v$v is released already: bump the version first (docs/RELEASING.md step 1), or tools/release.sh --feeds to redo its feeds" >&2; exit 1; }
[ "$state" != false ] && [ -n "$mode" ] && { echo "release: $mode: v$v isn't published" >&2; exit 1; }
[ "$state" = none ] && git rev-parse -q --verify "refs/tags/v$v" >/dev/null && { echo "release: tag v$v exists without a release: bump the version first" >&2; exit 1; }
[ -r "$KEY" ] || { echo "release: no signing key at $KEY" >&2; exit 1; }
# signs files with the feed key: <file>.sig beside each (tools/sign-feed.mjs; the key never printed)
sign() { CK_FEED_KEY="$(cat "$KEY")" bash -c 'for f in "$@"; do node tools/sign-feed.mjs "$f"; done' _ "$@"; }

# --mac DMG: the published release's SUMS gain the disk image's line (any earlier one replaced), signed again
if [ "$mode" = --mac ]; then
  dmg="${2:?release: --mac needs the disk image: gh run download <run> -n corridorkey-desktop-macos-arm64 -D release/mac}"
  name="CorridorKey-Desktop-$v-arm64.dmg"
  # the file name carries package.json's version at the commit it was built from: the tag's, or it's refused
  [ "$(basename "$dmg")" = "$name" ] || { echo "release: $dmg isn't $name: build it from the tag (gh workflow run macos.yml --ref v$v)" >&2; exit 1; }
  sums="$(mktemp -d)"; trap 'rm -rf "$sums"' EXIT
  gh release download "v$v" -D "$sums" -p SHA256SUMS -p SHA512SUMS
  cp "$dmg" "$sums/$name"
  # loop: NOT-WORTH — the two SUMS files
  for a in 256 512; do
    (cd "$sums" && grep -vF "  $name" "SHA${a}SUMS" > "SHA${a}SUMS.new" || true; "sha${a}sum" "$name" >> "SHA${a}SUMS.new"; mv "SHA${a}SUMS.new" "SHA${a}SUMS")
  done
  sign "$sums/SHA256SUMS" "$sums/SHA512SUMS"
  gh release upload "v$v" "$sums/$name" "$sums"/SHA256SUMS* "$sums"/SHA512SUMS* --clobber
  echo "release: v$v has the macOS disk image; SHA256SUMS / SHA512SUMS cover it, signed"
  exit 0
fi
grep -q "^## $v\( \|$\)" CHANGELOG.md || { echo "release: CHANGELOG.md has no '## $v' section" >&2; exit 1; }
# the top section is this version's (a forgotten bump: the newest notes are another version's; review N13)
[ "$(grep -m1 '^## ' CHANGELOG.md | cut -d' ' -f2)" = "$v" ] || { echo "release: CHANGELOG.md's top section isn't $v: bump the version to the newest section's, or add its section on top" >&2; exit 1; }
grep "^## $v\( \|$\)" CHANGELOG.md | grep -qiE 'draft|unreleased' && { echo "release: CHANGELOG.md's '## $v' header still says draft / unreleased" >&2; exit 1; }
# the published wiki must be docs/wiki/ (docs/RELEASING.md "The wiki"): a read-only shallow clone, compared page by page
wiki="$(mktemp -d)"; trap 'rm -rf "$wiki"' EXIT
git clone -q --depth 1 "$(git remote get-url origin | sed 's/\.git$//').wiki.git" "$wiki"
node tools/check_wiki.mjs --published "$wiki" || { echo "release: publish docs/wiki/ first (node tools/publish_wiki.mjs <wiki clone> --push)" >&2; exit 1; }
# cargo-about 0.9.2 lives with the other release tools (cargo install --locked --features cli cargo-about --root …)
export CARGO_ABOUT="${CARGO_ABOUT:-$HOME/.local/share/corridorkey-release/cargo-about/bin/cargo-about}"
"${CAP[@]}" node tools/gen_notices.mjs --check
# every pinned model set on GitHub as install.ts pins it, with its licence files (online; tools/check_model_sets.mjs)
GITHUB_TOKEN="$(gh auth token)" node tools/check_model_sets.mjs

if [ "$state" != false ]; then
# the docs-touch gate over this release's commits (npm run check reads origin/main..HEAD: nothing once pushed; S6)
node tools/check_docs_touch.mjs "$(git describe --tags --abbrev=0 --match 'v*')..HEAD"
# the engine's own checks (cargo fmt, clippy -D warnings, cargo test), first: cargo test builds target/debug/corridorkey,
# the binary npm run check's CLI-spec drift check compares against (named, so a missing one fails instead of skipping)
systemd-run --user --scope --quiet --collect ${CK_SLICE:+--slice=$CK_SLICE} -p MemoryMax=12G -p MemorySwapMax=0 -- npm run -s check:engine
CK_CLI_BIN="$PWD/engine-rs/target/debug/corridorkey" NODE_OPTIONS=--max-old-space-size=4096 "${CAP[@]}" npm run -s check
# and its macOS / Windows lint (capped inside)
tools/check_targets.sh
NODE_OPTIONS=--max-old-space-size=4096 "${CAP[@]}" npm run -s dist:linux
NODE_OPTIONS=--max-old-space-size=4096 "${CAP[@]}" npm run -s dist:win
# the builds rewrite src/shared/console/cliSpec.json from the engine they built: a change means the checked commit isn't
# what ships (senior review 2026-10-27)
[ -z "$(git status --porcelain)" ] || { echo "release: the build changed tracked files; commit them and rerun:" >&2; git status --short >&2; exit 1; }

file="CorridorKey-Desktop-$v.AppImage"
winfile="CorridorKey-Desktop-$v-Setup.exe"
# loop: NOT-WORTH — the two release files
for f in "$file" "$winfile"; do [ -f "release/$f" ] || { echo "release: release/$f was not built" >&2; exit 1; }; done
(cd release && sha256sum "$file" "$winfile" > SHA256SUMS && sha512sum "$file" "$winfile" > SHA512SUMS)
sign release/SHA256SUMS release/SHA512SUMS
# loop: NOT-WORTH — one pass over CHANGELOG.md for this version's section
awk -v v="$v" '$0 == "## " v || index($0, "## " v " ") == 1 {on=1; next} on && /^## / {exit} on' CHANGELOG.md > release/notes.md
[ -s release/notes.md ] || echo "See CHANGELOG.md." > release/notes.md
if [ "$dev" = true ]; then
  printf '\n**This is a development build**: newer than the stable release and less tested. The app offers it only with Update channel set to Development.\n' >> release/notes.md
fi

git push origin main
flags=(--title "CorridorKey $v" --notes-file release/notes.md)
if [ "$dev" = true ]; then flags+=(--prerelease --latest=false); else flags+=(--latest); fi
# a draft left by a failed run: moved to this commit with these notes, so the tag, files and notes agree (S5)
if [ "$state" = true ]; then gh release edit "v$v" --target "$(git rev-parse HEAD)" "${flags[@]}"
else gh release create "v$v" --draft --target "$(git rev-parse HEAD)" "${flags[@]}"; fi
gh release upload "v$v" "release/$file" "release/$winfile" release/SHA256SUMS release/SHA512SUMS release/SHA256SUMS.sig release/SHA512SUMS.sig --clobber
gh release edit "v$v" --draft=false
git fetch -q origin "refs/tags/v$v:refs/tags/v$v"
else
  echo "release: v$v is published already: redoing the feeds"
fi

# GitHub's release list can lag right after publishing: the released channel's feed must name v$v (a few tries)
channel=stable mine=latest.json; [ "$dev" = true ] && channel=dev mine=latest-dev.json
# loop: SERIAL-REQUIRED — polling until a deadline [bounded: 6 tries, 10 s apart]
for try in 1 2 3 4 5 6; do
  GITHUB_TOKEN="$(gh auth token)" node tools/build-feed.mjs --channel stable --out latest.json || [ $? -eq 2 ]
  GITHUB_TOKEN="$(gh auth token)" node tools/build-feed.mjs --channel dev --out latest-dev.json || [ $? -eq 2 ]
  [ -f "$mine" ] && [ "$(node -p "require('./$mine').version")" = "$v" ] && break
  [ "$try" = 6 ] && { echo "release: $mine doesn't name $v yet; rerun tools/release.sh --feeds to finish them" >&2; exit 1; }
  # loop: SERIAL-REQUIRED — waits between feed tries [bounded: 6 tries, 10 s apart]
  sleep 10
done
feeds=()
# loop: NOT-WORTH — the two feed files
for f in latest.json latest-dev.json; do [ -f "$f" ] && feeds+=("$f"); done
sign "${feeds[@]}"
node tools/verify-feed.mjs "${feeds[@]}"
# loop: NOT-WORTH — adds the feed files and their signatures
for f in "${feeds[@]}"; do git add "$f" "$f.sig"; done
if ! git diff --cached --quiet; then
  git commit -q -m "chore(feed): v$v"
  # someone pushed meanwhile (the laptop): put the feed commit on top and push once more
  git push origin main || { git pull -q --rebase origin main && git push origin main; }
fi
# the released channel's live feed only (the other may not exist yet: no stable release before 1.0), and it must name
# v$v; read through GitHub's contents API (the pushed commit, no CDN lag), a few tries
# loop: SERIAL-REQUIRED — polling until the pushed feed verifies [bounded: 6 tries, 10 s apart]
for try in 1 2 3 4 5 6; do
  GITHUB_TOKEN="$(gh auth token)" node tools/verify-feed.mjs --channel "$channel" --version "$v" && break
  [ "$try" = 6 ] && { echo "release: the live $mine doesn't verify as $v; rerun tools/release.sh --feeds" >&2; exit 1; }
  # loop: SERIAL-REQUIRED — waits between verify tries [bounded: 6 tries, 10 s apart]
  sleep 10
done
echo "release: v$v published"
