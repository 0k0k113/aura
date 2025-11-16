// app/tray.ts
import { app, Tray, Menu, BrowserWindow, nativeImage, Notification } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { DiscordRPC } from './rpc'

function resolveFirstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

function loadTrayImage(): Electron.NativeImage {
  // Prefer platform-appropriate tray assets from the packaged resources first, then local build/, then legacy assets/
  const candidates: string[] = []

  // Packaged resources path
  const resBuild = path.join(process.resourcesPath, 'build')
  const resCandidates =
    process.platform === 'darwin'
      ? [path.join(resBuild, 'trayTemplate.png'), path.join(resBuild, 'tray.png'), path.join(resBuild, 'icon.png')]
      : process.platform === 'win32'
      ? [path.join(resBuild, 'tray.png'), path.join(resBuild, 'icon.png'), path.join(resBuild, 'icon.ico')]
      : [path.join(resBuild, 'tray.png'), path.join(resBuild, 'icon.png')]

  candidates.push(...resCandidates)

  // Dev build folder next to compiled files
  const localBuild = path.join(__dirname, '../build')
  const devCandidates =
    process.platform === 'darwin'
      ? [path.join(localBuild, 'trayTemplate.png'), path.join(localBuild, 'tray.png'), path.join(localBuild, 'icon.png')]
      : process.platform === 'win32'
      ? [path.join(localBuild, 'tray.png'), path.join(localBuild, 'icon.png'), path.join(localBuild, 'icon.ico')]
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
  tray.setToolTip('Unreleasd Presence')

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Unreleasd Presence', enabled: false },
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
            title: 'Unreleasd Presence',
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
              storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'cachestorage', 'serviceworkers', 'filesystem']
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
              title: 'Unreleasd Presence',
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

  tray.setContextMenu(contextMenu)

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
