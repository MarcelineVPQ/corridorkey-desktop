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

You don't have to open App settings to see an update. When there's something to do, it shows above every page and as
a dot on **App settings** in the rail (a press opens Updates):

| Step | What it says | Buttons |
| --- | --- | --- |
| Available | "1.0.0 Dev 2 is available, 45.3 MB." | **Download**, **Not now** |
| Downloading | "Downloading 1.0.0 Dev 2…" and its progress | **Not now** |
| Ready | "1.0.0 Dev 2 is ready: restart to use it." | **Restart now**, **Not now** |
| Install failed | the reason, as it is | **Dismiss** |

- **Restart now** waits while the queue, the Console's corridorkey, a download, a cache folder move or a TensorRT
  build runs, and says which.
- **Not now** hides that step of that version, also after a restart. The next step, or a newer version, shows again.
  The dot on App settings stays while the update waits for you (to download, to restart, or after a failed install).
- A failed install shows its reason until you dismiss it, and again if it fails again. A check that fails on its own
  (no network) says so only in App settings → Updates.
- With **Check automatically** off nothing changes: the app goes online for updates only when you press Check now.

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

## On Windows and macOS: the app tells you, you install it

From 1.0.0-dev.4 the app checks the same signed update information as on Linux, on the same channels and schedule
(App settings → Updates: **Channel**, **Check automatically**, **Check now**), and shows the same notice above every
page and the dot on **App settings**: "1.0.0 Dev 4 is available." with **Download** and **Not now**. **Download**
opens that version's page on GitHub in your browser; the app itself downloads and installs nothing there. **Not
now** hides that version's notice, as on Linux. On a Development build with the channel set to Stable, **Back to
stable** offers the newest Stable release the same way.

On Windows, download the new `CorridorKey-Desktop-<version>-Setup.exe` from the
[releases page](https://github.com/MarcelineVPQ/corridorkey-desktop/releases) and run it. Development builds are
marked **Pre-release** there. An update keeps your downloaded runtime, models, cache and settings; the uninstaller
only offers to remove them when you uninstall for good (see [Uninstall](Uninstall)).

On a Mac, download the new disk image from that page and drag the app to Applications over the old one.

What changed in each version is in the [CHANGELOG](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/CHANGELOG.md)
and on each release's page.
