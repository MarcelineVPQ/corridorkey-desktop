; CorridorKey's uninstaller asks whether to remove what the app downloaded and keeps (Marcy 2026-10-24: clean up
; after itself): the GPU runtime, the models and the cache in %LOCALAPPDATA%\corridorkey-desktop (about 6 GB), and
; the settings in %APPDATA%\corridorkey-desktop. An update (the uninstall run by a newer installer) never asks and keeps them;
; a silent uninstall keeps them too (/SD IDNO).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; the installer's own copy that electron-builder keeps there (125 MB, found left behind in the Windows VM
    ; 2026-10-24): not the user's, so it always goes
    RMDir /r "$LOCALAPPDATA\corridorkey-desktop-updater"
    ; either folder: the settings and Electron's own data exist after one start even when nothing was downloaded
    ; (found left behind in the Windows VM 2026-10-24, 2.8 MB)
    StrCpy $R9 ""
    ${If} ${FileExists} "$LOCALAPPDATA\corridorkey-desktop\*.*"
      StrCpy $R9 "1"
    ${EndIf}
    ${If} ${FileExists} "$APPDATA\corridorkey-desktop\*.*"
      StrCpy $R9 "1"
    ${EndIf}
    ${If} $R9 == "1"
      MessageBox MB_YESNO|MB_ICONQUESTION "Also remove CorridorKey's downloaded GPU runtime, models and cache (up to about 6 GB) and its settings?$\r$\n$\r$\n$LOCALAPPDATA\corridorkey-desktop$\r$\n$APPDATA\corridorkey-desktop$\r$\n$\r$\nYour clips and results are not touched." /SD IDNO IDNO ck_keep_data
        RMDir /r "$LOCALAPPDATA\corridorkey-desktop"
        RMDir /r "$APPDATA\corridorkey-desktop"
      ck_keep_data:
    ${EndIf}
  ${endIf}
!macroend
