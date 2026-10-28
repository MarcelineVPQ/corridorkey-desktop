# Releasing CorridorKey Desktop

CorridorKey updates itself from a **signed feed**, the same design as Marcy's DS5 app and Sonata.

| File (on `main` of [MarcelineVPQ/corridorkey-desktop](https://github.com/MarcelineVPQ/corridorkey-desktop)) | Channel | Lists |
|---|---|---|
| `latest.json` + `latest.json.sig` | Stable | the newest published `vX.Y.Z` release |
| `latest-dev.json` + `latest-dev.json.sig` | Development | the newest of the `vX.Y.Z-dev.N` prereleases and the stable releases |

The repository is one constant, `REPO` in `electron/main/updateFeed.ts`; every feed and download URL comes from it.

## What the app does

- **Checks**: with *Check automatically* on, 20 s after start and every 2 hours; and whenever the user asks
  (`check(true)`). With it off, the app goes online for updates only when asked: no timer, no check at start,
  none on a channel switch. A check the user asks for reads the feed through GitHub's contents API (raw
  bytes, no CDN cache; falls back to raw.githubusercontent.com if the API refuses), so a check right after a
  release sees it (Sonata measured raw.githubusercontent.com caching for 5 minutes).
- **Refuses** anything not exactly right: the `.sig` must be an Ed25519 signature over the feed's exact bytes
  by a key in `TRUSTED_KEYS`; the feed's `channel` must be the one asked for; Stable never takes a `-dev`
  version; `file` must be `CorridorKey-Desktop-<version>.AppImage` and `url` this repository's release
  download for that tag; then the download's size and SHA-512 must match (streamed, checked before anything
  is kept). Every refusal is shown verbatim (`UpdateState.error`).
- **Never downgrades**: only strictly newer versions are offered
  (`0.2.0-dev.2 < 0.2.0 < 0.2.1-dev.1`). Switching Development → Stable installs nothing until Stable passes
  the build you have. **Back to stable** (`backToStable()`, confirmed in the page) is the one path to an older
  version: the newest stable release; the offer stays until installed or Development is picked again.
- **Installs beside the running AppImage**: the download goes to `CorridorKey-Desktop-<v>.AppImage.part` in the
  same folder, is verified, made executable and renamed; `CorridorKey-Desktop.AppImage` (a symlink) is
  repointed at it (a real file with that name is never replaced). The running file is never touched (it is
  FUSE-mounted). The previous version stays for rollback; at the next start, cut-short `.part` files and
  versions older than the previous one are removed.
- **Restart now** (`restart()`, gated by the main process while the queue runs) first starts a small helper that
  holds the AppImage mount until this copy's processes are gone (DS5's `appImageQuit.ts`), then starts the new
  version through `systemd-run --user` with only the session's variables and PATH without AppImage mounts
  (Sonata's relaunch), then quits normally (the engine is stopped by `before-quit`). Without systemd the new copy
  starts from a detached shell (bash) that first closes every descriptor it inherited (one is the running
  AppImage's keepalive pipe: kept open, the old mount lived as long as the new copy) and waits for this copy to
  end (at most 15 s). Measured with `tools/update_e2e.sh` (docs/BUG_HUNT_2026-10.md, U1-U3).
- **Unsupported** (`status: "unsupported"`, the reason in `error`): running from source, not as an AppImage,
  or a build without a trusted key. Nothing goes online.
- The channel and *Check automatically* are kept in `<userData>/updates.json` (atomic write). A development
  build starts on Development, a release on Stable.

Code: `electron/main/updateFeed.ts` (feed rules, pure), `updateFlow.ts` (the flow, pure), `download.ts`,
`relaunch.ts`, `appImageQuit.ts`, `updatePrefs.ts`, and `updater.ts` (the Electron binding). Tests:
`tests/unit/updateFeed.test.ts`, `updateFlow.test.ts` (a whole update against a local signed feed),
`relaunch.test.ts`.

Feed format (written by `feedText` in `updateFeed.ts`, used by `tools/build-feed.mjs`):

```json
{
  "channel": "stable",
  "version": "0.2.0",
  "file": "CorridorKey-Desktop-0.2.0.AppImage",
  "url": "https://github.com/MarcelineVPQ/corridorkey-desktop/releases/download/v0.2.0/CorridorKey-Desktop-0.2.0.AppImage",
  "sha512": "<128 hex>",
  "size": 129378893,
  "date": "<release published_at>",
  "notes_url": "<release page>",
  "notes": "<release notes, Markdown>"
}
```

## Signing key

- Private key: `~/.config/corridorkey-release/feed-signing.pem` on Marcy's PC (folder 700, file 600). Never
  committed, never printed. Keep an offline backup: losing it means installed apps stop accepting updates
  until a release that trusts a new key reaches them.
- Public key (base64 SPKI) in `TRUSTED_KEYS`, `electron/main/updateFeed.ts`:
  `MCowBQYDK2VwAyEAuUIsZgGZQ7RSvVoCGijbgkuw/TsHnSxRLke55eRhbnk=`
  (SHA-256 of the DER: `8c92245161ae36c9d3db3f819f5a09762b90a027e984a7c15483df40d52f21a0`).
- `tools/release.sh` signs with it on this PC (read into `CK_FEED_KEY` for `tools/sign-feed.mjs`, never
  printed). Without it the script stops before anything is published; an unsigned feed is never published.
- Rotation: add the new public key to `TRUSTED_KEYS` and release; once that release is out, sign with the new
  key; drop the old key in a later release.

## Cutting a release

Releases are built on this PC and uploaded (Marcy 2026-10-24: GitHub doesn't build them; a CI Linux build once
spent 29 minutes waiting on a package mirror).

1. Set the version (package.json and the lock together):
   `npx -y npm@10.9.2 version X.Y.Z-dev.N --no-git-tag-version` (Development) or `… X.Y.Z …` (Stable).
   Add its `## X.Y.Z-dev.N` section to `CHANGELOG.md` (the release notes are that section). Commit on `main`.
   Publish the wiki if `docs/wiki/` changed since it was last published (The wiki, below): the release refuses a
   published wiki that differs.
2. `tools/release.sh`. It checks the version shape (`X.Y.Z` = Stable, `X.Y.Z-dev.N` = Development), that it isn't
   released yet (no tag, no published release: run before step 1 it refuses), the lock, a
   clean `main` in step with GitHub, the CHANGELOG section (the top one; its header must not say draft or unreleased) and the
   signing key; runs the docs-touch gate over the commits since the last `v*` tag, `npm run check:engine` (its
   `cargo test` builds `engine-rs/target/debug/corridorkey`), `npm run check` with `CK_CLI_BIN` set to that binary
   (so the Console's CLI-spec drift check runs, never skips) and `tools/check_targets.sh` (the engine's macOS and
   Windows lint), then `npm run dist:linux` (memory-capped; the engine is linked for glibc 2.28 with cargo-zigbuild, Zig in
   `~/.local/share/corridorkey-release/zig/venv`; then `tools/build_trt_builder.sh` builds TensorRT's engine builder
   `ck-trt-build` with Zig's C++ for glibc 2.28 and the AppImage ships it next to the engine. It links against
   libnvinfer / libnvonnxparser from NVIDIA's pinned `tensorrt-cu13-libs` 10.16.1.11 wheel, the one the app's
   TensorRT download uses, cached and SHA-256-checked in `~/.local/share/corridorkey-release/tensorrt` (3.7 GB,
   downloaded once; only the two libraries are unpacked)) and `npm run dist:win` (the Windows engine cross-built with
   MinGW-w64, the NSIS installer through Wine); stops if the builds changed a tracked file (they rewrite
   `src/shared/console/cliSpec.json` from the engine they built: what ships must be the commit that gets tagged);
   writes `SHA256SUMS` / `SHA512SUMS` of the AppImage and the `-Setup.exe`, each signed with the feed key
   (`SHA256SUMS.sig`, below), uploads them; the update feeds name the AppImage only (Windows updates from the releases page);
   pushes `main`; creates the
   release as a draft on that commit, uploads, and publishes it, which makes the `vX.Y.Z…` tag (Development as a
   **prerelease**, never *Latest*; Stable as *Latest*); then `tools/build-feed.mjs` picks the release per channel
   from GitHub's release list (retried until the released channel names the new version), downloads and hashes
   the AppImage and writes the feed, `tools/sign-feed.mjs` signs it, `tools/verify-feed.mjs` checks it exactly as
   the app does, and the changed feeds are committed to `main` and pushed.
3. It ends with `node tools/verify-feed.mjs --channel <the released channel> --version <it>` (read through GitHub's
   contents API, so no CDN copy lags behind the push; a few tries): only the released channel, since the other may
   not exist yet (no Stable feed before 1.0).
4. If it fails partway, run it again: a draft release is picked up, moved to the current commit with the current
   notes, and finished; once the release is published, `tools/release.sh --feeds` redoes only the feeds.

**Checking a download** (the SUMS are signed with the feed key, whose public half is in `TRUSTED_KEYS`):

```bash
printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAuUIsZgGZQ7RSvVoCGijbgkuw/TsHnSxRLke55eRhbnk=\n-----END PUBLIC KEY-----\n' > ck-release.pub
base64 -d SHA256SUMS.sig > SHA256SUMS.sig.bin
openssl pkeyutl -verify -pubin -inkey ck-release.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig.bin
sha256sum --ignore-missing -c SHA256SUMS
```

**GitHub's "Latest" badge** sits on a model set's release (`models-2.0.0-onnx.4`) until the first Stable release:
GitHub gives it to the newest release that isn't a prerelease, and every Development build is one. The first Stable
release takes it (`--latest`); a new model set is created with `--latest=false` (`tools/upload_model_set.sh` does).
Links point at the releases page, never `releases/latest`.

**Release-only gates** (online, so not in `npm run gates`; `tools/release.sh` runs them in step 1):
`tools/check_model_sets.mjs` checks every model set `install.ts` pins against its GitHub release `models-<set>`:
each pinned file there at its size and SHA-256, and the licence files (LICENSE, NOTICE, ATTRIBUTION.md, and the
base set's LICENSE-* on every derived set).

**On demand:** `.github/workflows/windows.yml` (`gh workflow run windows.yml`) runs the engine's checks (cargo fmt,
clippy, cargo test) on GitHub's Windows runner, the only place its Windows-only code runs; worth a run before a
stable release or after a change to that code. It hasn't passed yet (its one run, 2026-10-27, failed): until it does,
nothing Windows-only in the engine counts as run on Windows (the CHANGELOG says "not yet run on Windows").

**Windows Defender** (until the Windows builds are signed): its machine-learning heuristic quarantined the unsigned
`resources\engine\corridorkey.exe` as `Trojan:Win32/Bearfoos.A!ml` in the 2026-10-27 VM run, a false positive. After
each `npm run dist:win`, submit the new `release/win-unpacked/resources/engine/corridorkey.exe` and
`corridorkey-engine.exe` to Microsoft as incorrectly detected (https://www.microsoft.com/en-us/wdsi/filesubmission),
with their SHA-256, the repository URL and "open source, not yet code-signed".

### macOS (Apple Silicon)

There is no Mac here and no cross-build from Linux without Apple's SDK, so the macOS disk image is built on
GitHub's macOS runner (on demand only, never on every push). For a release, build it from the release's tag, once
`tools/release.sh` has published it: `gh workflow run macos.yml --ref vX.Y.Z…` (the workflow refuses a tag that
isn't package.json's version); any other run, `--ref main`, is a check, not a release file. It runs the
app's and the engine's checks on macOS, builds the engine for `aarch64-apple-darwin` and the arm64 `.dmg`
(`npm run dist:mac`), installs it as a user does (a quarantined download into /Applications, Gatekeeper's answers
recorded), starts it and screenshots every page. The image and the screenshots are the run's artifacts. Add the image
to the release:

```bash
gh run download <run id> -n corridorkey-desktop-macos-arm64 -D release/mac
tools/release.sh --mac release/mac/CorridorKey-Desktop-X.Y.Z…-arm64.dmg
```

which refuses an image named for another version, adds its lines to the release's `SHA256SUMS` / `SHA512SUMS`,
signs them again and uploads the image with them. The runner is a virtual Mac without
the GPU or the Neural Engine: it proves the build and the app, not keying speed.

Signing (since 2026-10-24): the image is signed with Marcy's Developer ID Application certificate (team
FTQ95W942L, valid to 2027-11-23) with the hardened runtime (`build/entitlements.mac.plist`: V8's JIT, and
disable-library-validation so the engine can load ONNX Runtime's library from PyPI), notarized with an App Store
Connect API key (Developer role) and stapled. The workflow's build step is the only one that gets the secrets
(`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`); the next step
fails unless codesign, stapler and Gatekeeper accept the app as a notarized Developer ID app. The keys' originals
are in `~/.config/corridorkey-release/apple/` and Marcy's vault; the certificate is renewed before it expires
(a new .p12 into `MAC_CSC_LINK`). Without the variables (a local `npm run dist:mac`) the image is unsigned.

The Core ML model set the Mac setup downloads (`models-2.0.0-onnx.5-coreml` from dev.2, docs/ONNX_EXPORT.md "Core ML set") is
published once, before the first Mac build that pins it: `tools/upload_model_set.sh DIR 2.0.0-onnx.5-coreml` (the
same script publishes the TensorRT set, `2.0.0-onnx.5-trt`), with Marcy's OK.

From 1.0.0-dev.2 every system pins `2.0.0-onnx.5` (install.ts `MODEL_SET`), TensorRT `2.0.0-onnx.5-trt` and the Mac
`2.0.0-onnx.5-coreml`. `models-2.0.0-onnx.5` (at least the files
install.ts pins, and LICENSE, NOTICE and ATTRIBUTION.md, which the model-set gate asks of a base set) is published before the
build that pins it; `upload_model_set.sh` publishes only `-trt` and `-coreml` sets, so the base set goes up by hand
(`gh release create models-2.0.0-onnx.5 --latest=false`), then `tools/upload_model_set.sh DIR 2.0.0-onnx.5-trt`
(it takes the licence files from the base release), and the same for `2.0.0-onnx.5-coreml`; `tools/check_model_sets.mjs` checks them all.

Development builds ship one feature at a time on the Development channel; a stable release goes out when its
planned set is done and Marcy has done her QC (the DS5 rhythm).

**Never edit the feeds by hand.** They are only ever written by `tools/release.sh` (build, sign, verify).

## The wiki

The wiki ([github.com/MarcelineVPQ/corridorkey-desktop/wiki](https://github.com/MarcelineVPQ/corridorkey-desktop/wiki)) is
written in this repository, `docs/wiki/` (one `.md` per page, named as the wiki names them, `_Sidebar.md` and
`_Footer.md` included), and changes in the same piece of work as what it describes (Marcy 2026-10-26: "keep the wiki
up to date — make that a gate", "especially important for the command line").

- **The gate** (`npm run gates`, offline): `tools/check_wiki.mjs` fails when a `corridorkey` command or flag (from
  `src/shared/console/cliSpec.json`, the CLI's own `__spec --json`) is missing from `Command-Line.md` or no example
  of a command that takes it uses it; an exit code (ck-cli's `exit.rs`) has no row there; a progress format is
  missing there; a Console built-in (`registry.ts`) is missing from `Console.md`; one of the engine's messages
  written for people (ck-core's errors that start with a capital letter, and the no-GPU reason) is missing from
  `Troubleshooting.md`; or a wiki link, an anchor, or a link into this repository (`…/blob/main/<file>#anchor`)
  doesn't resolve. Tests: `tests/unit/checkWiki.test.ts` (a fixture failing each rule).
- **Publishing is Marcy's step** (public words get her OK first). `node tools/publish_wiki.mjs <wiki clone>` runs the
  gate, pulls the clone, copies `docs/wiki/` into it (a page removed here is removed there), stages it and prints the
  diff: nothing is committed or pushed. Read it, then `node tools/publish_wiki.mjs <wiki clone> --push` commits
  ("The wiki from corridorkey-desktop <commit>") and pushes; it refuses while `docs/wiki/` has uncommitted changes.
  A clone, once: `git clone https://github.com/MarcelineVPQ/corridorkey-desktop.wiki.git <folder>`.
- **The release gate**: `tools/release.sh` clones the wiki read-only (shallow, into a temporary folder) and runs
  `node tools/check_wiki.mjs --published <it>`, which refuses the release while any page differs from `docs/wiki/`
  (added, removed or changed; line ends don't count). It is the only network part; the everyday gate needs none.

## A local signed test feed

To run a whole update before anything is published:

```bash
# a throwaway key pair; the public key only goes to the test app's environment
node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');require('fs').writeFileSync('test-key.pem',k.privateKey.export({format:'pem',type:'pkcs8'}));console.log(k.publicKey.export({format:'der',type:'spki'}).toString('base64'))" > test-key.pub
# latest.json with url http://127.0.0.1:8765/vX.Y.Z/CorridorKey-Desktop-X.Y.Z.AppImage, its sha512 and size, signed like CI:
CK_FEED_KEY="$(cat test-key.pem)" node tools/sign-feed.mjs latest.json
python3 -m http.server 8765 --bind 127.0.0.1   # serves latest.json(.sig) and vX.Y.Z/<file>
CK_UPDATE_MANIFEST=http://127.0.0.1:8765/latest.json CK_UPDATE_PUBKEY="$(cat test-key.pub)" ./CorridorKey-Desktop-<older>.AppImage
```

`CK_UPDATE_MANIFEST` is honoured only for loopback `http://` (127.0.0.1 / localhost); downloads must then come
from the same server, and the test key is trusted only together with it. Run a test AppImage from a scratch
folder (it repoints the symlink and prunes old versions beside itself), in an isolated copy (own HOME, headless
KWin, private D-Bus), never on Marcy's screen: `tools/update_e2e.sh --dir DIR --old OLD.AppImage --new
NEW.AppImage --version X.Y.Z-dev.N` does the whole update that way (memory-capped) and dumps each test process's
state on a failure. `tests/unit/updateFlow.test.ts` runs the same flow automatically.
