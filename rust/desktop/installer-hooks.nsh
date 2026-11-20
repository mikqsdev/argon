; Argon installer hooks (Tauri NSIS): put the `argon` CLI on the user's PATH, clean up on uninstall.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Adding the Argon CLI to PATH…"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\bin\path.ps1" add "$INSTDIR\bin"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Updates reinstall over the same folder: keep PATH and data in that case.
  ${If} $UpdateMode <> 1
    DetailPrint "Removing the Argon CLI from PATH…"
    nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\bin\path.ps1" remove "$INSTDIR\bin"'
    IfSilent skip_data
    MessageBox MB_YESNO|MB_ICONQUESTION "Delete Argon data too? (sessions, settings and saved credentials in $PROFILE\.argon)$\r$\n$\r$\nEliminare anche i dati di Argon? (sessioni, impostazioni e credenziali)" IDNO skip_data
      RMDir /r "$PROFILE\.argon"
    skip_data:
  ${EndIf}
!macroend
