// app/main.ts
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

function loadEnvironment(): void {
  const envPaths = [
    path.join(__dirname, '../.env'),
    path.join(__dirname, '../../.env'),
    path.join(process.resourcesPath || '', '.env')
  ]

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath })
      break
    }
  }
}

loadEnvironment()

import { app, BrowserWindow, ipcMain, shell, Notification } from 'electron'
import { DiscordRPC } from './rpc'
import { createPresenceActivity } from './presence'
import { createTray } from './tray'
import { z } from 'zod'

const START_URL = process.env.ELECTRON_APP_URL || 'https://unreleasedworld.netlify.app'
const ALLOWED_ORIGIN = START_URL

let mainWindow: BrowserWindow | null = null
let rpc: DiscordRPC | null = null
let lastSeekSeq = -1
let lastTrackId: string | undefined
let lastPosition = -1
let lastIsPlaying: boolean | undefined
const debugEnabled = process.env.UNRL_PRESENCE_LOG === '1'
let seq = 0

const presencePayloadSchema = z.object({
  context: z.enum(['browsing', 'artist', 'track', 'profile']).optional(),
  artist_name: z.string().max(128).optional(),
  artist_id: z.string().optional(),
  track_title: z.string().max(128).optional(),
  album_name: z.string().max(128).optional(),
  deep_link: z.string().optional(),
  timestamp: z.number().optional(),
  position_ms: z.number().optional(),
  duration_ms: z.number().optional(),
  is_playing: z.boolean().optional(),
  seek_seq: z.number().optional(),
  track_id: z.string().optional(),
  trace_id: z.string().optional()
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required' as any,
      backgroundThrottling: false
    },
    backgroundColor: '#000000',
    title: 'Unreleasd Presence'
  })

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self' ${START_URL}; ` +
          `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${START_URL}; ` +
          `style-src 'self' 'unsafe-inline' ${START_URL}; ` +
          `img-src 'self' data: https: blob:; ` +
          `connect-src 'self' https: ws: wss: data: https://unreleasedworld.netlify.app; ` +
          `font-src 'self' data: ${START_URL}; ` +
          `media-src 'self' https: data: blob: https://unreleasedworld.netlify.app;`
        ]
      }
    })
  })

  // Set Chrome-like User Agent for better compatibility
  const chromeVersion = process.versions.chrome || '120.0.0.0'
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  mainWindow.webContents.setUserAgent(ua)

  // Debug: Range header instrumentation (MEDIA_DEBUG=1)
  if (process.env.MEDIA_DEBUG === '1') {
    let lastRangeLog = 0
    const RANGE_LOG_DEBOUNCE_MS = 2000

    mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['*://*/api/media/*'] },
      (details, callback) => {
        const now = Date.now()
        if (now - lastRangeLog >= RANGE_LOG_DEBOUNCE_MS) {
          const hasRange = !!details.requestHeaders['Range']
          console.log('[MediaDebug] Request to /api/media/* - Range header:', hasRange ? 'present' : 'absent')
          lastRangeLog = now
        }
        callback({ requestHeaders: details.requestHeaders })
      }
    )
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsedUrl = new URL(url)
      const allowedUrl = new URL(ALLOWED_ORIGIN)

      if (parsedUrl.origin !== allowedUrl.origin) {
        event.preventDefault()
        shell.openExternal(url)
      }
    } catch (error) {
      console.error('[Main] Invalid URL in navigation:', error)
      event.preventDefault()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.loadURL(START_URL).catch(err => {
    console.error('[Main] Failed to load URL:', err)
  })

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools()
  }
}

function setupIPC(): void {
  ipcMain.on('presence:update', (event, payload) => {
    try {
      const senderOrigin = event.senderFrame.url
      const allowedUrl = new URL(ALLOWED_ORIGIN)
      const senderUrl = new URL(senderOrigin)

      if (senderUrl.origin !== allowedUrl.origin) {
        console.warn('[IPC] Presence update from disallowed origin:', senderOrigin)
        return
      }

      const validated = presencePayloadSchema.safeParse(payload)
      if (!validated.success) {
        console.warn('[IPC] Invalid presence payload:', validated.error)
        return
      }

      if (!rpc) {
        console.warn('[IPC] RPC not initialized')
        return
      }

      const payloadWithConvertedTimestamp = {
        ...validated.data,
        timestamp: validated.data.timestamp ? Math.floor(validated.data.timestamp / 1000) : undefined
      }

      // Enhanced logging for debugging
      const traceId = validated.data.trace_id
      console.log(`[IPC:${traceId}] Received presence payload:`, {
        context: payloadWithConvertedTimestamp.context,
        track_title: payloadWithConvertedTimestamp.track_title,
        artist_name: payloadWithConvertedTimestamp.artist_name,
        artist_id: payloadWithConvertedTimestamp.artist_id,
        is_playing: payloadWithConvertedTimestamp.is_playing,
        position_ms: payloadWithConvertedTimestamp.position_ms
      })

      const currentUrl = mainWindow?.webContents.getURL() || ''
      const activity = createPresenceActivity(currentUrl, payloadWithConvertedTimestamp)

      if (activity) {
        console.log(`[IPC:${traceId}] Created Discord activity:`, {
          name: activity.name,
          details: activity.details,
          largeImageKey: activity.largeImageKey,
          largeImageText: activity.largeImageText,
          hasTimestamp: !!activity.startTimestamp
        })
      }

      if (activity) {
        let bypassThrottle = false

        const currentTrackId = validated.data.track_id || `${validated.data.track_title}_${validated.data.artist_name}`
        const hasTrackInfo =
          validated.data.track_title || validated.data.artist_name || validated.data.position_ms !== undefined
        const isTrackChange =
          hasTrackInfo && currentTrackId !== lastTrackId && currentTrackId !== '_undefined'
        const isSeek = validated.data.seek_seq !== undefined && validated.data.seek_seq > lastSeekSeq

        const positionDeviation =
          validated.data.position_ms !== undefined && lastPosition >= 0
            ? Math.abs(validated.data.position_ms - lastPosition)
            : 0
        const isSignificantJump = positionDeviation >= 1500

        const isTrackEnd =
          validated.data.position_ms !== undefined &&
          validated.data.duration_ms !== undefined &&
          validated.data.duration_ms > 0 &&
          validated.data.position_ms >= validated.data.duration_ms - 500 &&
          validated.data.is_playing === false

        // Detect transition from playing to browsing (for timestamp clearing)
        const wasPreviouslyPlaying = lastTrackId !== undefined
        const isNowBrowsing =
          validated.data.context === 'browsing' || (!hasTrackInfo && validated.data.is_playing !== true)
        const isBrowsingTransition = wasPreviouslyPlaying && isNowBrowsing

        // Detect pause/play transitions (for artist-browsing fallback)
        const isPlayStateChange =
          validated.data.is_playing !== lastIsPlaying && lastIsPlaying !== undefined

        if (isTrackChange) {
          console.log(
            `[IPC] Track change detected, bypassing throttle ${traceId ? `[${traceId}]` : ''}`
          )
          lastTrackId = currentTrackId
          lastSeekSeq = validated.data.seek_seq ?? -1
          lastPosition = validated.data.position_ms ?? -1
          bypassThrottle = true
        } else if (isTrackEnd) {
          console.log(
            `[IPC] Track end detected, bypassing throttle for next track or browsing ${
              traceId ? `[${traceId}]` : ''
            }`
          )
          lastTrackId = undefined
          lastSeekSeq = -1
          lastPosition = -1
          bypassThrottle = true
        } else if (isBrowsingTransition) {
          console.log(
            `[IPC] Browsing transition detected, bypassing throttle to clear timestamps ${
              traceId ? `[${traceId}]` : ''
            }`
          )
          lastTrackId = undefined
          lastSeekSeq = -1
          lastPosition = -1
          bypassThrottle = true
        } else if (isSeek && validated.data.seek_seq !== undefined) {
          console.log(
            `[IPC] Seek detected, bypassing throttle ${traceId ? `[${traceId}]` : ''}`
          )
          lastSeekSeq = validated.data.seek_seq
          lastPosition = validated.data.position_ms ?? -1
          bypassThrottle = true
        } else if (isSignificantJump) {
          console.log(
            `[IPC] Significant position jump detected, bypassing throttle ${
              traceId ? `[${traceId}]` : ''
            }`
          )
          lastPosition = validated.data.position_ms ?? -1
          bypassThrottle = true
        } else if (validated.data.position_ms !== undefined) {
          lastPosition = validated.data.position_ms
        }

        // Detect and bypass on pause/play transitions
        if (isPlayStateChange) {
          if (debugEnabled) {
            console.log(
              `[IPC:${traceId}#${++seq}] Play state changed (${String(
                lastIsPlaying
              )} → ${String(validated.data.is_playing)}), bypassing throttle`
            )
          }
          bypassThrottle = true
        }

        // Update last play state
        lastIsPlaying = validated.data.is_playing

        // Clear track ID when transitioning to browsing
        if (isNowBrowsing) {
          lastTrackId = undefined
        }

        rpc.setActivity(activity, bypassThrottle)
      }
    } catch (error) {
      console.error('[IPC] Error handling presence update:', error)
    }
  })

  ipcMain.on('presence:clear', () => {
    if (rpc) {
      rpc.clearActivity()
    }
  })

  ipcMain.handle('presence:ping', () => {
    return {
      origin: START_URL,
      hasDiscord: !!rpc && rpc.isReady()
    }
  })

  ipcMain.handle('presence:clear-all-data', async () => {
    try {
      if (!mainWindow) {
        return { success: false, error: 'Window not available' }
      }

      await mainWindow.webContents.executeJavaScript(`
        try {
          localStorage.removeItem('rp_user');
          localStorage.removeItem('rp_sid');
        } catch (e) {
          console.error('Failed to clear localStorage:', e);
        }
      `)

      const session = mainWindow.webContents.session
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

      mainWindow.webContents.clearHistory()

      if (rpc) {
        rpc.clearActivity()
      }

      mainWindow.reload()

      new Notification({
        title: 'Unreleasd Presence',
        body: 'All app data cleared'
      }).show()

      return { success: true }
    } catch (error: any) {
      console.error('[IPC] Error clearing data:', error)
      return { success: false, error: error.message }
    }
  })
}

function initializeRPC(): void {
  const clientId = process.env.DISCORD_CLIENT_ID
  const hasClientId = !!clientId
  console.log(`[RPC] Environment loaded - DISCORD_CLIENT_ID present: ${hasClientId}`)

  if (!hasClientId) {
    console.warn(
      '[RPC] DISCORD_CLIENT_ID is not set. Discord Rich Presence will be disabled. ' +
        'Ensure a .env with DISCORD_CLIENT_ID is bundled or set in the environment.'
    )
    return
  }

  try {
    rpc = new DiscordRPC(clientId)
    rpc.login().catch(err => {
      console.warn('[RPC] Failed to initialize Discord RPC:', err)
    })
  } catch (error) {
    console.warn('[RPC] Error creating Discord RPC client:', error)
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    createWindow()
    initializeRPC()
    setupIPC()

    createTray(mainWindow, rpc)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    if (rpc) {
      rpc.clearActivity()
      rpc.destroy()
    }
  })
}
