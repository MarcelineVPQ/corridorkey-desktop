; CorridorKey's uninstaller asks whether to remove what the app downloaded and keeps (Marcy 2026-10-24: clean up
; after itself): the GPU runtime, the models and the cache in %LOCALAPPDATA%\corridorkey-desktop (about 6 GB), and
; the settings in %APPDATA%\corridorkey-desktop. An update (the uninstall run by a newer installer) never asks and keeps them;
; a silent uninstall keeps them too (/SD IDNO).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${If} ${FileExists} "$LOCALAPPDATA\corridorkey-desktop\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION "Also remove CorridorKey's downloaded GPU runtime, models and cache (about 6 GB) and its settings?$\r$\n$\r$\n$LOCALAPPDATA\corridorkey-desktop$\r$\n$APPDATA\corridorkey-desktop$\r$\n$\r$\nYour clips and results are not touched." /SD IDNO IDNO ck_keep_data
        RMDir /r "$LOCALAPPDATA\corridorkey-desktop"
        RMDir /r "$APPDATA\corridorkey-desktop"
      ck_keep_data:
    ${EndIf}
  ${endIf}
!macroend
