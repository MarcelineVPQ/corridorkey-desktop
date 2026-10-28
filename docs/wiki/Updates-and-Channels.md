# Updates and channels

## Two channels

| Channel | What it gets |
| --- | --- |
| **Stable** | Stable releases only (`1.0.0`, `1.0.1`, …). |
| **Development** | New features first, as `X.Y.Z-dev.N` builds; they may have rough edges. It also gets the stable releases. |

New features ship one at a time as Development builds; a Stable release comes when its planned set is done and
checked. A Development build starts on the Development channel, a Stable release on Stable.

The first builds are Development builds (1.0.0-dev.1 is the first). Until a Stable release is published, the Stable
channel has nothing to offer.

## On Linux: the app updates itself

Everything is in **App settings → Updates**:

- **Channel:** Stable or Development.
- **Check automatically:** at start and every few hours. Off, the app only goes online for updates when you ask.
- **Check now**, then **Download** when a new version is available, then **Restart now** when it's ready (disabled
  while the queue runs: "After the queue finishes"; while the Console's corridorkey or a download runs it says so and
  waits).

How it works, so nothing surprises you:

- The update information is signed, and the download's size and checksum are checked before it's kept. Anything
  that doesn't match is refused, and the refusal is shown as it is.
- The new version is downloaded **next to the AppImage you're running**, as `CorridorKey-Desktop-<version>.AppImage`,
  and a `CorridorKey-Desktop.AppImage` link next to it is pointed at the newest one (so a launcher or shortcut aimed
  at that link always starts the newest version). The running file is never touched. The previous version is kept for
  going back; older ones the updater downloaded are cleaned up at the next start. An AppImage you downloaded or put
  there yourself is never removed.
- It **never downgrades**: only newer versions are offered. Switching from Development to Stable installs nothing
  until a Stable release is newer than the build you have.

### Back to stable

On a Development build with the channel set to Stable, **Back to stable** appears: it installs the newest Stable
release over the Development build. It's the one way to go to an older version, and it asks first.

Updates work only in the AppImage. A copy run from source says "Updates come with the AppImage build; this copy runs
from source."

## On Windows: from the releases page

Self-update is Linux-only for now. App settings → Updates says so: "On Windows, new versions are on GitHub:
github.com/MarcelineVPQ/corridorkey-desktop/releases (self-update is Linux only for now)."

To update, download the new `CorridorKey-Desktop-<version>-Setup.exe` from the
[releases page](https://github.com/MarcelineVPQ/corridorkey-desktop/releases) and run it. Development builds are
marked **Pre-release** there. An update keeps your downloaded runtime, models, cache and settings; the uninstaller
only offers to remove them when you uninstall for good (see [Uninstall](Uninstall)).

What changed in each version is in the [CHANGELOG](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/CHANGELOG.md)
and on each release's page.
