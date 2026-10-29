# Releasing CorridorKey Desktop

CorridorKey updates itself from a **signed feed**, the same design as Marcy's DS5 app and Sonata.

| File (on `main` of [MarcelineVPQ/corridorkey-desktop](https://github.com/MarcelineVPQ/corridorkey-desktop)) | Channel | Lists |
|---|---|---|
| `latest.json` + `latest.json.sig` | Stable | the newest published `vX.Y.Z` release |
| `latest-dev.json` + `latest-dev.json.sig` | Development | the newest of the `vX.Y.Z-dev.N` releases and the stable releases (told apart by the tag) |

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
   published wiki that differs. Then push that commit and run Windows CI on it (`git push origin main`,
   `gh workflow run windows.yml --ref main`, `gh run watch`): the release refuses a commit without a green
   `windows.yml` run (`gh run list --workflow windows.yml --commit <it> --status success`), since the engine's
   Windows-only code runs nowhere else. After a pull, `npx -y npm@10.9.2 ci`: the release refuses a `node_modules`
   that isn't `package-lock.json` (`tools/check_node_modules.mjs`: each locked package at its version, nothing extra).
2. `tools/release.sh`. It checks the version shape (`X.Y.Z` = Stable, `X.Y.Z-dev.N` = Development), that it isn't
   released yet (no tag, no published release: run before step 1 it refuses), the lock, a
   clean `main` in step with GitHub, the CHANGELOG section (the top one; its header must not say draft or unreleased), the
   signing key, THIRD_PARTY_NOTICES.md (`tools/gen_notices.mjs --check`, cargo-about 0.9.2 from
   `~/.local/share/corridorkey-release/cargo-about`; Linux CI runs it on every push too), `node_modules` against the lock
   and the green Windows CI run; runs the docs-touch gate over the
   commits since the last `v*` tag, `npm run check:engine` (its
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
   starts the packaged Linux build (`release/linux-unpacked`) in an isolated copy (`tools/isolated.sh --packaged`:
   own HOME, private D-Bus, headless KWin, never the desktop) and stops unless `tools/drive.mjs` finds its first page
   rendered, then runs its `resources/engine/corridorkey run` on a two-line script (`version`, `echo ck-run-check`)
   under the same HOME with no display or D-Bus of this session, and stops unless it prints both and exits 0 (the
   folder, with `app.log`, `run.out` / `run.err` and a screenshot, is kept on a failure). On Linux this proves only that
   the package starts: Electron checks `app.asar` against its integrity hash on Windows and macOS only;
   writes `SHA256SUMS` / `SHA512SUMS` of the AppImage and the `-Setup.exe`, each signed with the feed key
   (`SHA256SUMS.sig`, below), uploads them; the update feeds name the AppImage only (Windows and macOS read the same feeds for the notice, and Download opens the release page there);
   pushes `main`; creates the
   release as a draft on that commit, uploads, checks GitHub's sha256 digest of every upload against the signed
   `SHA256SUMS` (nothing is published on a difference), and **stops with the release a draft**: nothing is public yet.
3. Start the Windows installer in the VM (The Windows installer, below). Only when it passes:
   `tools/release.sh --publish`, which checks the draft is on this commit and the digests again, then publishes it,
   which makes the `vX.Y.Z…` tag (every release a full release marked *Latest*, dev builds too: Marcy 2026-10-28);
   then `tools/build-feed.mjs` picks the release per channel
   from GitHub's release list (retried until the released channel names the new version), downloads and hashes
   the AppImage and writes the feed, `tools/sign-feed.mjs` signs it, `tools/verify-feed.mjs` checks it exactly as
   the app does, and the changed feeds are committed to `main` and pushed.
4. It ends with `node tools/verify-feed.mjs --channel <the released channel> --version <it>` (read through GitHub's
   contents API, so no CDN copy lags behind the push; a few tries): only the released channel, since the other may
   not exist yet (no Stable feed before 1.0).
5. If it fails partway, run it again: a draft release is picked up, moved to the current commit with the current
   notes, and uploaded again (then the VM start and `--publish` as above); once the release is published, `tools/release.sh --feeds` redoes only the feeds.

**Checking a download** (the SUMS are signed with the feed key, whose public half is in `TRUSTED_KEYS`):

```bash
printf -- '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAuUIsZgGZQ7RSvVoCGijbgkuw/TsHnSxRLke55eRhbnk=\n-----END PUBLIC KEY-----\n' > ck-release.pub
base64 -d SHA256SUMS.sig > SHA256SUMS.sig.bin
openssl pkeyutl -verify -pubin -inkey ck-release.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig.bin
sha256sum --ignore-missing -c SHA256SUMS
```

**GitHub's "Latest" badge** is on the newest app release, dev builds included (Marcy 2026-10-28, from 1.0.0-dev.2):
`tools/release.sh` publishes every release as a full release with `--latest`, and the feeds tell Stable from
Development by the tag (`updateFeed.ts` `selectRelease`), never by GitHub's prerelease flag. The model-set releases
(`models-…`) are prereleases, so they never take the badge (`tools/upload_model_set.sh` creates them so). Links
point at the releases page, never `releases/latest`.

**Release-only gates** (online, so not in `npm run gates`; `tools/release.sh` runs them in step 1):
`tools/check_model_sets.mjs` checks every model set `install.ts` pins against its GitHub release `models-<set>`:
each pinned file there at its size and SHA-256, and the licence files (LICENSE, NOTICE, ATTRIBUTION.md, and the
base set's LICENSE-* on every derived set).

**CI on every push (BACKLOG row 170):** `.github/workflows/windows.yml`, `macos.yml` and `linux.yml` run by
themselves on every push to main, and by hand (`gh workflow run <file> --ref main`). Windows runs the engine's checks
(cargo fmt, clippy, cargo test) on GitHub's Windows runner, the only place its Windows-only code runs, and builds the
app as a package there: the first page, and `corridorkey run` within a time limit (the unit tests run on macOS and Linux:
most were written for POSIX, BACKLOG row 176). macOS builds, signs,
installs and starts the app and runs its `corridorkey run`; Linux checks THIRD_PARTY_NOTICES.md is exactly what
`tools/gen_notices.mjs` writes (`--check`, with cargo-about 0.9.2 built on the runner; BACKLOG row 179), then builds the
package and runs its `corridorkey run`.
Each run is reported the moment it finishes. Measurement runs (speed, TensorRT, matte parity) are never part of CI or
of a dev build: only when Marcy asks a question that needs one, on one clip, with a time estimate first.
`tools/release.sh` refuses to tag a commit without a green Windows run (step 1). Until a run passes, nothing Windows-only in the engine counts as run on Windows (the
CHANGELOG says "not yet run on Windows").

**The Windows installer, once per release, by hand, before `--publish`:** `tools/release.sh` starts only the Linux
build (the Windows one is built through Wine and can't start here), and leaves the release a draft until this passes
(release re-review 2026-10-28 #2). Install `release/CorridorKey-Desktop-<version>-Setup.exe`
in the `win11-test` VM (libvirt, test-only) and start it once: it must reach its first page (the packaged app's
Electron fuses check `app.asar` against its integrity hash at start on Windows). Then, in a terminal there,
`resources\engine\corridorkey.exe run` the same two-line script as on Linux (`version`, `echo ck-run-check`): it must
print the version and `ck-run-check` and exit 0, and Ctrl+C
during a long line must stop it with exit 130 (the app's `--ck-headless` start, since the `runAsNode` fuse is off:
review 2026-10-28 #3). A build that fails gets a fix and a new version: the draft is never published, then deleted
(`gh release delete vX.Y.Z… --yes`, nothing public was made).

**Windows Defender** (until the Windows builds are signed): its machine-learning heuristic quarantined the unsigned
`resources\engine\corridorkey.exe` as `Trojan:Win32/Bearfoos.A!ml` in the 2026-10-27 VM run, a false positive. Both
files submitted on 2026-10-28 came back "no positive detection, no telemetry indicators" (closed), and 1.0.0-dev.4 ran
clean on 2026-10-29 with real-time protection on and that day's definitions. So the VM run is the trigger, not every
build (Marcy 2026-10-29): the VM check reads Defender's recent detections (`Get-MpThreatDetection`, no exclusion for
CorridorKey); only when it flags a file, submit that file to Microsoft as incorrectly detected
(https://www.microsoft.com/en-us/wdsi/filesubmission) with its SHA-256, the repository URL and "open source, not yet
code-signed", and hold the release until the verdict.

### macOS (Apple Silicon)

There is no Mac here and no cross-build from Linux without Apple's SDK, so the macOS disk image is built on
GitHub's macOS runner (on every push to main, and by hand). For a release, build it from the release's tag, once
`tools/release.sh` has published it: `gh workflow run macos.yml --ref vX.Y.Z…` (the workflow refuses a tag that
isn't package.json's version); any other run, `--ref main`, is a check, not a release file. It runs the
app's and the engine's checks on macOS, builds the engine for `aarch64-apple-darwin` and the arm64 `.dmg`
(`npm run dist:mac`), installs it as a user does (a quarantined download into /Applications, Gatekeeper's answers
recorded), starts it and screenshots every page. The image and the screenshots are the run's artifacts. Add the image
to the release with the run's id (`gh run list --workflow macos.yml`):

```bash
tools/release.sh --mac <run id>
```

which refuses a run that isn't a green `macOS` run of the tag's own commit (`gh run view <id> --json headSha` against
`git rev-parse vX.Y.Z…^{commit}`: a run of `main` after the release builds an image of the same name from other code),
downloads the image from it, refuses one named for another version, adds its lines to the release's `SHA256SUMS` / `SHA512SUMS`,
signs them again and uploads the image with them. The runner is a virtual Mac without
the GPU or the Neural Engine: it proves the build and the app, not keying speed.

**The real Mac, before `--mac` (BACKLOG row 174):** `tools/mac_app_gate.sh --host mac --run <the release's macos.yml run>`
installs that image on the Mac mini as a download (Gatekeeper's verdicts on the image and the app recorded), runs the
setup's download when it needs one (over an older Core ML set: only the new files), keys one clip through the
installed app's queue and passes only when the job finished on Core ML (report in
`~/.cache/claude-scratch/mac-app-gate/`). First run 2026-10-28 (7588521): image and app accepted as notarized, the
upgrade from dev.2's set 982.6 MB, 04_5d at 1920×1080 120/120 frames on Core ML in 157 s.

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
same script publishes TensorRT sets, e.g. `2.0.0-onnx.5-trt`), with Marcy's OK.

From 1.0.0-dev.2 every system pins `2.0.0-onnx.5` (install.ts `MODEL_SET`), TensorRT dev.1's `2.0.0-onnx.4-trt` and the Mac
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
  `Troubleshooting.md`; a wiki link, an anchor, or a link into this repository (`…/blob/main/<file>#anchor`)
  doesn't resolve; or a page calls package.json's version "the next development build" (the wiki goes live with
  it). Tests: `tests/unit/checkWiki.test.ts` (a fixture failing each rule).
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
