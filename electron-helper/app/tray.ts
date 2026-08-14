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

/**
 * `getWindow` is a getter, not a window.
 *
 * On macOS closing the window does not quit the app — `app.on('activate')`
 * builds a NEW BrowserWindow. A captured reference would still point at the
 * destroyed one, so every tray action ("Open unreleasd.world", "Clear All
 * Data") silently targeted a window that no longer existed for the rest of
 * the session. Resolving it per click always finds the live window.
 */
export function createTray(
  getWindow: () => BrowserWindow | null,
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
  let lastStatus = ''

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
          url: getWindow()?.webContents?.getURL() ?? null,
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
        const window = getWindow()
        if (window && !window.isDestroyed()) {
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
        const window = getWindow()
        if (window && !window.isDestroyed() && window.webContents) {
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

  lastStatus = describeStatus()
  tray.setContextMenu(buildMenu())
  tray.setToolTip(`Unreleased Presence — ${lastStatus}`)

  // Keep the status line honest — but ONLY redraw when it actually changed.
  //
  // This used to rebuild unconditionally every five seconds, constructing a
  // fresh native menu (on macOS an NSMenu plus one NSMenuItem per entry) and
  // handing it to the OS — ~480 times over a 40-minute session, for a menu
  // nobody had open. Skipping the no-op rebuilds is worth doing on its own.
  //
  // It is NOT, however, why the app made a MacBook slow, and this comment used
  // to claim it was. One native menu every five seconds is nowhere near a
  // thermal load, and the user reproduced the slowdown on a build that already
  // contained this fix. The real cause was elsewhere: the window was created
  // with `backgroundThrottling: false` (see main.ts), which kept the renderer
  // painting and the GPU compositing an invisible surface for the whole
  // session. Left here as a caution — the fact that a fix is real does not
  // make it the fix for the symptom you were chasing.
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
    const window = getWindow()
    if (window && !window.isDestroyed()) {
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
