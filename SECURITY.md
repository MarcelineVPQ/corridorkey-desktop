# Security

## Getting CorridorKey Desktop safely

- Download it only from this repository's [releases](https://github.com/MarcelineVPQ/corridorkey-desktop/releases).
- The Linux app updates itself only from this repository's signed feed (Ed25519 signature, size and SHA-512 checked
  before anything is kept; docs/RELEASING.md).
- The macOS disk image is signed (Developer ID) and notarized by Apple. The Windows installer isn't code-signed yet;
  each release lists the SHA-256 of the AppImage and the installer in `SHA256SUMS`.
- The runtime and models the app downloads come from their original sources (PyPI, this repository's releases),
  pinned by size and SHA-256 and checked before they are used.

## Reporting a vulnerability

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository, not in a public
issue. Include what you found, how to reproduce it, and the version. You'll get an answer as soon as possible; this is a
free project, so please allow some days.
