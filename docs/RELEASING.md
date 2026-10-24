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
2. `tools/release.sh`. It checks the version shape (`X.Y.Z` = Stable, `X.Y.Z-dev.N` = Development), the lock, a
   clean `main` in step with GitHub, the CHANGELOG section and the signing key; runs `npm run check` and
   `npm run dist:linux` (memory-capped; the engine is linked for glibc 2.28 with cargo-zigbuild, Zig in
   `~/.local/share/corridorkey-release/zig/venv`); writes `SHA256SUMS` / `SHA512SUMS`; pushes `main`; creates the
   release as a draft on that commit, uploads, and publishes it, which makes the `vX.Y.Z…` tag (Development as a
   **prerelease**, never *Latest*; Stable as *Latest*); then `tools/build-feed.mjs` picks the release per channel
   from GitHub's release list (retried until the released channel names the new version), downloads and hashes
   the AppImage and writes the feed, `tools/sign-feed.mjs` signs it, `tools/verify-feed.mjs` checks it exactly as
   the app does, and the changed feeds are committed to `main` and pushed.
3. It ends with `node tools/verify-feed.mjs` on the live feeds, which must say OK for the channel you released.
4. If it fails partway, run it again: a draft release is picked up and finished, and once the release is
   published only the feeds are redone.

Development builds ship one feature at a time on the Development channel; a stable release goes out when its
planned set is done and Marcy has done her QC (the DS5 rhythm).

**Never edit the feeds by hand.** They are only ever written by `tools/release.sh` (build, sign, verify).

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
