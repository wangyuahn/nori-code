; Refresh only the web assets. Deleting all of $INSTDIR walks the language-server
; tree in resources\server-runtime, which is tens of thousands of files and makes
; an upgrade sit on "installing" for many minutes before NSIS copies anything.
; User data is outside the install directory and is not touched here.
!macro customInit
  RMDir /r "$INSTDIR\resources\nori-web"
!macroend
