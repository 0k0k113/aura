// app/tray.ts
import { Tray, Menu, BrowserWindow, nativeImage, Notification, clipboard } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { DiscordRPC } from './rpc'
import { collectResourceMetrics } from './metrics'

function resolveFirstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

function loadTrayImage(): Electron.NativeImage {
  // Prefer platform-appropriate tray assets from the packaged resources first,
  // then the project-root build/, then legacy assets/
  const candidates: string[] = []

  // Packaged resources path (when built)
  const resBuild = path.join(process.resourcesPath, 'build')
  const resCandidates =
    process.platform === 'darwin'
      ? [
          path.join(resBuild, 'trayTemplate.png'),
          path.join(resBuild, 'tray.png'),
          path.join(resBuild, 'icon.png')
        ]
      : process.platform === 'win32'
      ? [
          path.join(resBuild, 'tray.png'),
          path.join(resBuild, 'icon.png'),
          path.join(resBuild, 'icon.ico')
        ]
      : [path.join(resBuild, 'tray.png'), path.join(resBuild, 'icon.png')]

  candidates.push(...resCandidates)

  // Dev build folder at project root (sibling to app/)
  // dist/app/tray.js -> ../../build -> <projectRoot>/build
  const localBuild = path.join(__dirname, '../../build')
  const devCandidates =
    process.platform === 'darwin'
      ? [
          path.join(localBuild, 'trayTemplate.png'),
          path.join(localBuild, 'tray.png'),
          path.join(localBuild, 'icon.png')
        ]
      : process.platform === 'win32'
      ? [
          path.join(localBuild, 'tray.png'),
          path.join(localBuild, 'icon.png'),
          path.join(localBuild, 'icon.ico')
        ]
      : [path.join(localBuild, 'tray.png'), path.join(localBuild, 'icon.png')]

  candidates.push(...devCandidates)

  // Legacy fallback (old path)
  candidates.push(path.join(__dirname, '../assets/tray-icon.png'))

  const chosen = resolveFirstExisting(candidates)
  let img = chosen ? nativeImage.createFromPath(chosen) : nativeImage.createEmpty()

  if (img.isEmpty()) {
    // Absolute fallback
    return nativeImage.createEmpty()
  }

  // macOS: template images auto-adapt to light/dark menu bar
  if (process.platform === 'darwin') {
    try {
      img.setTemplateImage(true)
    } catch {}
    return img
  }

  // Windows/Linux prefer small explicit size
  return img.resize({ width: 16, height: 16 })
}

export function createTray(
  window: BrowserWindow | null,
  rpc: DiscordRPC | null
): Tray {
  let icon: Electron.NativeImage

  try {
    icon = loadTrayImage()
  } catch (error) {
    console.warn('[Tray] Failed to load tray icon, using empty image:', error)
    icon = nativeImage.createEmpty()
  }

  const tray = new Tray(icon)
  tray.setToolTip('Unreleased Presence')

  // Presence failing used to be entirely invisible — no window, no devtools,
  // no indicator. The status line below is the one place a user can look.
  //
  // It deliberately describes a STATE and nothing that ticks. It used to end
  // with `(${activitiesSent} updates sent)`, and that counter is why the tray
  // rebuilt its entire native menu every five seconds for an entire listening
  // session: the label changed on essentially every refresh, so the "has
  // anything changed" question could never be answered with "no". The exact
  // count is still available under "Copy diagnostics", where reading it does
  // not cost a menu rebuild.
  const describeStatus = (): string => {
    if (!rpc) return 'Discord: unavailable (build is missing DISCORD_CLIENT_ID)'
    const status = rpc.getStatus()
    if (!status.connected) return 'Discord: not connected — is Discord running?'
    if (!status.hasUser) return 'Discord: connected, but not identified — restart Discord'
    if (status.activitiesSent === 0) return 'Discord: connected — waiting for the site to send'
    return 'Discord: active'
  }

  const buildMenu = () => Menu.buildFromTemplate([
    { label: 'Unreleased Presence', enabled: false },
    { label: describeStatus(), enabled: false },
    {
      label: 'Copy diagnostics',
      click: () => {
        const report = {
          appVersion: require('electron').app.getVersion(),
          url: window?.webContents?.getURL() ?? null,
          discord: rpc ? rpc.getStatus() : { connected: false, reason: 'RPC not initialized' },
          // CPU and memory per process, with uptime. A slowdown report is
          // otherwise unfalsifiable once the app has been quit.
          resources: collectResourceMetrics(),
        }
        clipboard.writeText(JSON.stringify(report, null, 2))
        new Notification({
          title: 'Unreleased Presence',
          body: 'Diagnostics copied to the clipboard',
        }).show()
      },
    },
    { type: 'separator' },
    {
      label: 'Open unreleasd.world',
      click: () => {
        if (window) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
      }
    },
    {
      label: 'Clear Presence Cache',
      click: () => {
        try {
          if (rpc) rpc.clearActivity()
          new Notification({
            title: 'Unreleased Presence',
            body: 'Presence cache cleared'
          }).show()
        } catch (e) {
          console.error('[Tray] Failed to clear presence cache:', e)
        }
      }
    },
    {
      label: 'Clear All Data',
      click: async () => {
        if (window && window.webContents) {
          try {
            await window.webContents.executeJavaScript(
              `
              try {
                localStorage.removeItem('rp_user');
                localStorage.removeItem('rp_sid');
              } catch (e) {
                console.error('Failed to clear localStorage:', e);
              }
            `,
              true
            )

            const session = window.webContents.session
            await session.clearStorageData({
              storages: [
                'cookies',
                'localstorage',
                'indexdb',
                'websql',
                'cachestorage',
                'serviceworkers',
                'filesystem'
              ]
            })
            await session.clearCache()
            await session.clearCodeCaches({})
            await session.clearAuthCache()
            await session.clearHostResolverCache()

            window.webContents.clearHistory()

            if (rpc) {
              rpc.clearActivity()
            }

            window.reload()

            new Notification({
              title: 'Unreleased Presence',
              body: 'All app data cleared'
            }).show()
          } catch (error) {
            console.error('[Tray] Failed to clear all data:', error)
          }
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' }
  ])

  let lastStatus = describeStatus()
  tray.setContextMenu(buildMenu())
  tray.setToolTip(`Unreleased Presence — ${lastStatus}`)

  // Keep the status line honest — but ONLY redraw when it actually changed.
  //
  // This used to rebuild unconditionally every five seconds. Menu.buildFromTemplate
  // constructs a fresh native menu (on macOS an NSMenu and one NSMenuItem per
  // entry) and setContextMenu hands it to the OS, so a 40-minute listening
  // session spent ~480 of them — continuously, in the main process, for a menu
  // nobody had open. Steady native allocation like that shows up as the whole
  // machine getting slower the longer the app runs, and as the machine feeling
  // instantly better the moment it quits.
  //
  // The status is a handful of states that change perhaps a few times a
  // session, so the comparison below turns those ~480 rebuilds into roughly
  // the number of times something genuinely happened.
  const statusTimer = setInterval(() => {
    if (tray.isDestroyed()) {
      clearInterval(statusTimer)
      return
    }
    try {
      const status = describeStatus()
      if (status === lastStatus) return
      lastStatus = status
      tray.setContextMenu(buildMenu())
      tray.setToolTip(`Unreleased Presence — ${status}`)
    } catch {
      clearInterval(statusTimer)
    }
  }, 5000)

  tray.on('click', () => {
    if (window) {
      if (window.isVisible()) {
        window.hide()
      } else {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      }
    }
  })

  return tray
}
