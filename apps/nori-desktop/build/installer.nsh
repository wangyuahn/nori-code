; Replace the complete installed application before the new files are copied.
; Nori user data lives outside the install directory (~/.nori-code and the
; Electron userData directory), so removing $INSTDIR does not remove settings
; or sessions. This also clears stale web/native resources left by older builds.
!macro customInit
  RMDir /r "$INSTDIR"
  CreateDirectory "$INSTDIR"
!macroend
