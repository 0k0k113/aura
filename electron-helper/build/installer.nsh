; build/installer.nsh - included by electron-builder's NSIS installer (its default
; `nsis.include`). Since 1.0.5 the app registers the world.unreleased.aura:// scheme
; for the browser's sign-in hand-off itself, in the user's registry, at every start
; (app.setAsDefaultProtocolClient, app/main.ts). Uninstalling removes it again, so no
; scheme is left pointing at an app that is gone. An update runs the old uninstaller
; too; the new version registers the scheme again when it starts.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\world.unreleased.aura"
!macroend
