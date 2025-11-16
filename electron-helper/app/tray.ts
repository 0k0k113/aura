import { Tray, Menu, BrowserWindow, nativeImage, Notification } from 'electron'
import * as path from 'path'
import { DiscordRPC } from './rpc'

export function createTray(
  window: BrowserWindow | null,
  rpc: DiscordRPC | null
): Tray {
  const iconPath = path.join(__dirname, '../assets/tray-icon.png')
  let icon: Electron.NativeImage

  try {
    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty()
    } else {
      icon = icon.resize({ width: 16, height: 16 })
    }
  } catch (error) {
    console.warn('[Tray] Failed to load icon, using empty image:', error)
    icon = nativeImage.createEmpty()
  }

  const tray = new Tray(icon)
  tray.setToolTip('Unreleasd Presence')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Unreleasd Presence',
      enabled: false
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
      label: 'Clear All Data',
      click: async () => {
        if (window && window.webContents) {
          try {
            await window.webContents.executeJavaScript(`
              localStorage.removeItem('rp_user');
              localStorage.removeItem('rp_sid');
            `, true)

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
    {
      label: 'Quit',
      role: 'quit'
    }
  ])

  tray.setContextMenu(contextMenu)

  tray.on('click', () => {
    if (window) {
      if (window.isVisible()) {
        window.hide()
      } else {
        window.show()
        window.focus()
      }
    }
  })

  return tray
}
