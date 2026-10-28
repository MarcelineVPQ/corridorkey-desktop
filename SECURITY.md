# Security

## Getting CorridorKey Desktop safely

- Download it only from this repository's [releases](https://github.com/MarcelineVPQ/corridorkey-desktop/releases).
- The Linux app updates itself only from this repository's signed feed (Ed25519 signature, size and SHA-512 checked
  before anything is kept; docs/RELEASING.md).
- The macOS disk image is signed (Developer ID) and notarized by Apple. The Windows installer isn't code-signed yet;
  each release lists the SHA-256 of the AppImage and the installer in `SHA256SUMS`.
- The runtime and models the app downloads come from their original sources (PyPI, this repository's releases),
  pinned by size and SHA-256 and checked before they are used.

## Known limits (accepted risks)

- **macOS: `corridorkey run` and the app's file permissions.** `corridorkey run FILE.ckcmd` starts the app itself with
  no window (its `--ck-headless` start), so on a Mac the script's reads can count against CorridorKey's permissions
  (Desktop, Documents, external and network drives you allowed it). The app refuses that start when launchd or
  LaunchServices started it (`open -a`, a LaunchAgent), and it runs nothing but the app's own Console script runner: no
  code of the caller's, Node and inspector switches off. A program that is already running on the Mac could still
  start the app's executable while disclaiming responsibility for it (a private macOS call some tools use), and so read
  with CorridorKey's permissions what the Console's read commands reach: text files up to 1 MB and folder listings. It
  can't run code through it, and writes stay inside the folders the app allows. Closing it fully would need a headless
  runner that isn't the app; until then this is accepted (review 2026-10-28).

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository, not in a public
issue. Include what you found, how to reproduce it, and the version. You'll get an answer as soon as possible; this is a
free project, so please allow some days.
