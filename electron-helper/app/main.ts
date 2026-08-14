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
import { collectResourceMetrics } from './metrics'
import { createPresenceActivity } from './presence'
import { createTray } from './tray'
import { buildAllowedOrigins, isOriginAllowed, normalizeOrigin, ORIGINS_ARGV_PREFIX } from './origins'
import { z } from 'zod'

const START_URL = process.env.ELECTRON_APP_URL || 'https://unreleased.world'

// Apex and www are the same site. Comparing raw origin strings is what broke
// presence before — see app/origins.ts for the full story.
const ALLOWED_ORIGINS = buildAllowedOrigins(START_URL)

let mainWindow: BrowserWindow | null = null
let rpc: DiscordRPC | null = null
let lastSeekSeq = -1
let lastTrackId: string | undefined
let lastPosition = -1
let lastIsPlaying: boolean | undefined
const debugEnabled = process.env.UNRL_PRESENCE_LOG === '1'
let seq = 0

// Diagnostics for `presence:ping`. Without these, "presence isn't working" is
// unanswerable: there is no way to tell whether the web app never called, the
// origin gate rejected it, or Discord refused the activity.
const diagnostics = {
  updatesReceived: 0,
  updatesRejectedOrigin: 0,
  updatesRejectedSchema: 0,
  activitiesBuilt: 0,
  lastPayloadAt: null as number | null,
  lastActivity: null as { details?: string; largeImageKey?: string } | null,
  lastRejection: null as string | null,
}

/**
 * Presence updates arrive on every position tick — several times a second while
 * a track plays. Logging them unconditionally flooded the console and kept a
 * reference to every payload, so the whole IPC path is gated behind
 * UNRL_PRESENCE_LOG=1.
 */
function debugLog(message: string, data?: unknown): void {
  if (!debugEnabled) return
  if (data === undefined) console.log(message)
  else console.log(message, data)
}

// A zod object strips keys it doesn't declare. This schema used to omit
// `album_type`, `album_tracks_count`, `is_single` and `track_image_url`, so
// every single one of those fields was silently deleted between the preload
// (which forwards them correctly) and `createPresenceActivity` (which needs
// them to tell a single apart from an album). Single/album art selection
// therefore always fell through to the weak "album title == track title"
// heuristic. Every field the preload sends must be declared here.
const presencePayloadSchema = z.object({
  context: z.enum(['browsing', 'artist', 'track', 'profile']).optional(),
  artist_name: z.string().max(128).optional(),
  artist_id: z.string().optional(),
  track_title: z.string().max(128).optional(),
  album_name: z.string().max(128).optional(),
  album_type: z.string().max(128).optional(),
  album_tracks_count: z.number().optional(),
  is_single: z.boolean().optional(),
  track_image_url: z.string().max(300).optional(),
  // Resolved server-side from the admin-managed alias table. When present it
  // wins over any key this process would derive from the artist/album name —
  // that is the whole point of aliases (Discord rejects a lot of real titles).
  asset_key: z.string().max(32).optional(),
  asset_text: z.string().max(128).optional(),
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
      // The sandboxed preload cannot import ./origins (its `require` is a
      // polyfill limited to a few Electron built-ins), so the allow-list
      // travels as a process argument. One list, one owner, no drift.
      additionalArguments: [ORIGINS_ARGV_PREFIX + JSON.stringify(ALLOWED_ORIGINS)],
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required' as any,
      // Deliberately left at Chromium's default (throttling ENABLED).
      //
      // This used to be `false`, and that one line is what let a listening
      // session heat up a fanless MacBook until the whole machine slowed down.
      // Electron implements the flag by setting `disable_hidden_`, which turns
      // `RenderWidgetHostImpl::WasHidden()` into a no-op — permanently. That is
      // the function that tells the renderer to stop producing frames when the
      // window is occluded, and it is also what drops the process off
      // foreground priority. With it disabled, a window sitting behind another
      // app kept painting and kept the GPU compositing a surface nobody could
      // see, at foreground QoS, for as long as the app was open.
      //
      // Nothing here needed it. Presence is pushed by the site, and the site
      // ticks off the `<audio>` element's `timeupdate` plus a heartbeat
      // interval — no requestAnimationFrame anywhere in that path. Media events
      // are dispatched by the media pipeline, not a throttled task queue, and
      // Chromium exempts audible pages from intensive timer throttling and from
      // page freezing entirely; a background tab plays music indefinitely under
      // the default. The worst case is that the heartbeat is aligned to one
      // wake-up per second, and the RPC layer already throttles to 1000ms.
      //
      // If App Nap ever needs defeating, that is a different subsystem — use
      // powerSaveBlocker('prevent-app-suspension'), which does not disable
      // renderer visibility throttling.
    },
    backgroundColor: '#000000',
    title: 'Aura'
  })

  // Apex and www must both be listed: the site may redirect between them, and a
  // CSP naming only one would block the other's scripts and styles outright.
  const cspOrigins = ALLOWED_ORIGINS.flatMap((origin) => {
    const withWww = origin.replace(/^(https?:\/\/)/, '$1www.')
    return origin === withWww ? [origin] : [origin, withWww]
  }).join(' ')

  // Scoped to the app's own documents.
  //
  // This used to be registered with no filter, so it fired for every response
  // the app ever received — every script, image, XHR, and every audio range
  // request while a track streamed. Each one pauses the response in the
  // network service, serializes all its headers into a JS object, IPCs them to
  // the main process, rebuilds the object, and IPCs back, purely to attach a
  // CSP that only means anything on an HTML document from our own origin.
  // Media chunks now bypass the round trip entirely.
  const cspUrlPatterns = ALLOWED_ORIGINS.flatMap((origin) => {
    const withWww = origin.replace(/^(https?:\/\/)/, '$1www.')
    const origins = origin === withWww ? [origin] : [origin, withWww]
    return origins.map((o) => `${o}/*`)
  })

  mainWindow.webContents.session.webRequest.onHeadersReceived({ urls: cspUrlPatterns }, (details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'self' ${cspOrigins}; ` +
          `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${cspOrigins}; ` +
          `style-src 'self' 'unsafe-inline' ${cspOrigins}; ` +
          `img-src 'self' data: https: blob:; ` +
          `connect-src 'self' https: ws: wss: data:; ` +
          `font-src 'self' data: ${cspOrigins}; ` +
          `media-src 'self' https: data: blob:;`
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
    if (!isOriginAllowed(url, ALLOWED_ORIGINS)) {
      event.preventDefault()
      // Only hand genuine web URLs to the OS; never shell out on a parse failure.
      if (normalizeOrigin(url)?.startsWith('http')) {
        shell.openExternal(url)
      }
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
      // `senderFrame` is nullable in Electron 30+ (the frame can be gone by the
      // time the message is processed); fail closed if it is.
      diagnostics.updatesReceived++
      diagnostics.lastPayloadAt = Date.now()

      const senderOrigin = event.senderFrame?.url
      if (!isOriginAllowed(senderOrigin, ALLOWED_ORIGINS)) {
        diagnostics.updatesRejectedOrigin++
        diagnostics.lastRejection = `origin not allowed: ${senderOrigin}`
        console.warn('[IPC] Presence update from disallowed origin:', senderOrigin)
        return
      }

      const validated = presencePayloadSchema.safeParse(payload)
      if (!validated.success) {
        diagnostics.updatesRejectedSchema++
        diagnostics.lastRejection = `schema: ${validated.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`
        console.warn('[IPC] Invalid presence payload:', diagnostics.lastRejection)
        return
      }

      if (!rpc) {
        diagnostics.lastRejection = 'Discord RPC not initialized (missing DISCORD_CLIENT_ID?)'
        console.warn('[IPC] RPC not initialized')
        return
      }

      const payloadWithConvertedTimestamp = {
        ...validated.data,
        timestamp: validated.data.timestamp ? Math.floor(validated.data.timestamp / 1000) : undefined
      }

      const traceId = validated.data.trace_id
      debugLog(`[IPC:${traceId}] Received presence payload:`, {
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
        diagnostics.activitiesBuilt++
        diagnostics.lastActivity = {
          details: activity.details,
          largeImageKey: activity.largeImageKey,
        }
        debugLog(`[IPC:${traceId}] Created Discord activity:`, {
          name: activity.name,
          details: activity.details,
          largeImageKey: activity.largeImageKey,
          largeImageText: activity.largeImageText,
          hasTimestamp: !!activity.startTimestamp
        })
      } else {
        debugLog(`[IPC:${traceId}] Nothing to show — clearing presence`, {
          context: validated.data.context,
          is_playing: validated.data.is_playing,
        })
      }

      // Bookkeeping runs for EVERY payload, including the ones that show
      // nothing. It used to sit inside `if (activity)`, which was harmless
      // while a pause still produced a card — now a pause produces none, and
      // skipping the update would leave `lastIsPlaying` stuck on `true`, so
      // pressing play again would not read as a play-state change and the card
      // would come back throttled instead of instantly.
      {
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
          debugLog(
            `[IPC] Track change detected, bypassing throttle ${traceId ? `[${traceId}]` : ''}`
          )
          lastTrackId = currentTrackId
          lastSeekSeq = validated.data.seek_seq ?? -1
          lastPosition = validated.data.position_ms ?? -1
          bypassThrottle = true
        } else if (isTrackEnd) {
          debugLog(
            `[IPC] Track end detected, bypassing throttle for next track or browsing ${
              traceId ? `[${traceId}]` : ''
            }`
          )
          lastTrackId = undefined
          lastSeekSeq = -1
          lastPosition = -1
          bypassThrottle = true
        } else if (isBrowsingTransition) {
          debugLog(
            `[IPC] Browsing transition detected, bypassing throttle to clear timestamps ${
              traceId ? `[${traceId}]` : ''
            }`
          )
          lastTrackId = undefined
          lastSeekSeq = -1
          lastPosition = -1
          bypassThrottle = true
        } else if (isSeek && validated.data.seek_seq !== undefined) {
          debugLog(
            `[IPC] Seek detected, bypassing throttle ${traceId ? `[${traceId}]` : ''}`
          )
          lastSeekSeq = validated.data.seek_seq
          lastPosition = validated.data.position_ms ?? -1
          bypassThrottle = true
        } else if (isSignificantJump) {
          debugLog(
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
            debugLog(
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

        if (activity) {
          rpc.setActivity(activity, bypassThrottle)
        } else {
          // The other half of the contract in presence.ts: a null activity
          // means "show nothing", so the previous card has to come DOWN. Doing
          // nothing here is what would leave a paused track frozen on screen.
          rpc.clearActivity()
        }
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
      // Kept for compatibility with older web builds.
      origin: START_URL,
      hasDiscord: !!rpc && rpc.isReady(),

      allowedOrigins: ALLOWED_ORIGINS,
      discord: rpc
        ? rpc.getStatus()
        : { connected: false, reason: 'RPC not initialized — DISCORD_CLIENT_ID missing from the build' },
      bridge: { ...diagnostics },
      resources: collectResourceMetrics(),
      appVersion: app.getVersion(),
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
        title: 'Aura',
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

    createTray(() => mainWindow, rpc)

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
