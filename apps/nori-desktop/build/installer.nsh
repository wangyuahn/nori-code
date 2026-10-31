; Refresh only the web assets. Deleting all of $INSTDIR walks the language-server
; tree in resources\server-runtime, which is tens of thousands of files and makes
; an upgrade sit on "installing" for many minutes before NSIS copies anything.
; User data is outside the install directory and is not touched here.
!macro customInit
  RMDir /r "$INSTDIR\resources\nori-web"
!macroend

; electron-builder's default app-running check force-kills only the top-level
; NoriWork.exe. The desktop app spawns a server worker (node) that keeps DLLs and
; server-runtime files locked, so the default kill leaves the tree half-deleted
; and the upgrade fails with "cannot be closed". Kill the whole process tree and
; give the worker a moment to release file locks before uninstall/copy proceeds.
!macro customCheckAppRunning
  DetailPrint `Closing running "${PRODUCT_NAME}" (process tree)...`
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"`
  Sleep 3000
!macroend

; The stock handleUninstallResult hard-quits (SetErrorLevel 2) when the previous
; version's uninstaller returns non-zero, so one broken old uninstaller blocks
; every upgrade (silent runs exit 2; the wizard shows "Failed to uninstall old
; application files"). The new install overwrites the app files anyway, so a
; failed old uninstall must not abort the upgrade; leftover files from the old
; version are preferable to a dead install.
!macro customUnInstallCheck
  DetailPrint `Previous uninstaller reported failure; continuing install anyway.`
!macroend

; Assisted uninstallers (oneClick: false) never reach electron-builder's
; ONE_CLICK-gated quitSuccess, so on a perfectly clean uninstall they still exit
; with error level 2 — and the next version's installer reads that as "uninstall
; failed" and hard-quits every upgrade. Force error level 0 on the way out so
; our own uninstallers report success. (This macro is only inserted into the
; uninstaller build.)
!macro customUnInstall
  !insertmacro quitSuccess
!macroend
