# Uninstall

CorridorKey writes only to its own folders, plus the results you ask for (next to your clips, or in the folder you
chose). Your clips and results are never removed by any of the steps below.

## What it keeps, and where

| What | Linux | Windows | macOS |
| --- | --- | --- | --- |
| The app | the AppImage you downloaded (and, after updates, the previous version and a `CorridorKey-Desktop.AppImage` link next to it) | the install folder (Apps & features) | `CorridorKey.app` in Applications |
| GPU runtime and models (and TensorRT's libraries and models, Linux) | `~/.local/share/corridorkey-desktop` | `%LOCALAPPDATA%\corridorkey-desktop` | `~/Library/Application Support/corridorkey-desktop` |
| Thumbnails, result stills, TensorRT engines built for your card | `~/.cache/corridorkey-desktop` | `%LOCALAPPDATA%\corridorkey-desktop\cache` | `~/Library/Caches/corridorkey-desktop` |
| Settings (a few KB), and from 1.0.0-dev.2 the Console's history (`console-history.jsonl`, the newest 5000 lines) and its log of `sudo` commands (`console-audit.jsonl`, never pruned) | `~/.config/corridorkey-desktop` | `%APPDATA%\corridorkey-desktop` | `~/Library/Application Support/corridorkey-desktop` (with the data) |

On Linux, `~/.local/share` and `~/.cache` are `$XDG_DATA_HOME` and `$XDG_CACHE_HOME` if you set those. How big each
part is: the engineering notes' [Uninstall](https://github.com/MarcelineVPQ/corridorkey-desktop/blob/main/ENGINEERING.md#uninstall)
section, or **App settings → Storage** on your own PC.

If you moved the cache folder (**App settings → Storage → Change…**), the cache is in a `corridorkey-desktop`
folder inside the location you picked instead.

## Freeing space without uninstalling

**App settings → Storage** shows each folder's real size, with **Open** (shows it in your file manager) and
**Remove…** (it asks first). You can remove the runtime, the models or the cache; the setup downloads them again
when needed. On Linux, TensorRT is its own item: its libraries and models, and the engines built for your card. Your
settings and results are never touched there.

The cache also looks after itself: result stills older than 30 days go, and it never grows past 500 MB. Each job's
working files are removed when the job ends, and anything a crash left behind at the next start.

## Linux

1. Quit CorridorKey.
2. Delete the AppImage (and, if it updated itself, the other `CorridorKey-Desktop-*.AppImage` files and the
   `CorridorKey-Desktop.AppImage` link in the same folder).
3. Delete the three folders:

   ```
   rm -rf ~/.local/share/corridorkey-desktop ~/.cache/corridorkey-desktop ~/.config/corridorkey-desktop
   ```

   (and the `corridorkey-desktop` folder in your own cache location, if you moved it).

## Windows

1. Open **Settings → Apps → Installed apps** (or **Apps & features**), find **CorridorKey** and choose **Uninstall**.
2. The uninstaller asks whether to also remove the downloaded GPU runtime, models and cache, and the settings:

   > Also remove CorridorKey's downloaded GPU runtime, models and cache (up to about 6 GB) and its settings?

   Choose **Yes** to remove `%LOCALAPPDATA%\corridorkey-desktop` and `%APPDATA%\corridorkey-desktop` too, or **No**
   to keep them (for example to reinstall later without downloading again). Your clips and results are not touched.
3. If you moved the cache folder somewhere else, delete the `corridorkey-desktop` folder there yourself.

Installing a newer version over an old one never asks and keeps everything.

## macOS

1. Quit CorridorKey.
2. Move `CorridorKey.app` from Applications to the Bin.
3. Delete its two folders (Finder: **Go → Go to Folder…**): `~/Library/Application Support/corridorkey-desktop` and
   `~/Library/Caches/corridorkey-desktop` (and the `corridorkey-desktop` folder in your own cache location, if you
   moved it).
