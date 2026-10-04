!macro customInit
  ReadEnvStr $1 "ISLAND_DESKTOP_TEST"
  ${If} $1 != "1"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\Island"
  ${EndIf}
!macroend

!macro customInstall
  DetailPrint "Preparing bundled Node and shared Island Hub (existing identities are retained)..."
  ReadEnvStr $1 "ISLAND_DESKTOP_TEST"
  ${If} $1 == "1"
    ExecWait '"$INSTDIR\Island.exe" --prepare-client --smoke-test' $0
  ${Else}
    ExecWait '"$INSTDIR\Island.exe" --prepare-client' $0
  ${EndIf}
  ${If} $0 != 0
    SetErrorLevel 1
    MessageBox MB_OK|MB_ICONSTOP "Island client preparation failed. Existing identities were not replaced. Please check the client integrity and available disk space." /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Keeping .island-node identities, runtime and workspaces."
!macroend
