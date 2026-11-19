import { contextBridge, ipcRenderer } from 'electron'

// This preload runs sandboxed, so it cannot `require('./origins')` — its
// `require` is a polyfill covering only a few Electron built-ins. The main
// process therefore hands the allow-list over as a process argument, keeping
// exactly one owner for the list. See app/origins.ts for why this matters:
// a hardcoded copy here drifted from main.ts and silently killed all presence.
const ORIGINS_ARGV_PREFIX = '--unrl-allowed-origins='

/** Must stay behaviourally identical to normalizeOrigin() in app/origins.ts. */
function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    // Only the web schemes normalize. `javascript:`, `file:` and friends parse
    // happily and would otherwise yield a comparable string.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (!host) return null
    const port = url.port ? `:${url.port}` : ''
    return `${url.protocol}//${host}${port}`
  } catch {
    return null
  }
}

function readAllowedOrigins(): string[] {
  const arg = process.argv.find((a) => a.startsWith(ORIGINS_ARGV_PREFIX))
  if (arg) {
    try {
      const parsed = JSON.parse(arg.slice(ORIGINS_ARGV_PREFIX.length))
      if (Array.isArray(parsed) && parsed.every((o) => typeof o === 'string')) {
        return parsed
      }
    } catch {
      // fall through to the built-in list
    }
  }
  // Fallback only — reached if main failed to pass the argument at all.
  return ['https://unreleased.world', 'http://localhost:3000']
}

const ALLOWED_ORIGINS = readAllowedOrigins()

function isCurrentOriginAllowed(): boolean {
  const normalized = normalizeOrigin(window.location.origin)
  return normalized !== null && ALLOWED_ORIGINS.includes(normalized)
}

interface PresencePayload {
  context?: 'browsing' | 'artist' | 'track' | 'profile'
  artistName?: string
  artist_name?: string
  artist_id?: string
  artistId?: string
  trackTitle?: string
  track_title?: string
  albumName?: string
  album_name?: string
  albumType?: string
  album_type?: string
  albumTracksCount?: number
  album_tracks_count?: number
  isSingle?: boolean
  is_single?: boolean
  trackImageUrl?: string
  track_image_url?: string
  deepLink?: string
  deep_link?: string
  artist_url?: string
  timestamp?: number
  position_ms?: number
  positionMs?: number
  duration_ms?: number
  durationMs?: number
  is_playing?: boolean
  isPlaying?: boolean
  seek_seq?: number
  seekSeq?: number
  track_id?: string
  trackId?: string
  trace_id?: string
  traceId?: string
}

function isValidDeepLink(link: string | undefined): boolean {
  if (!link) return true
  try {
    const url = new URL(link)
    return ['http:', 'https:', 'spotify:', 'music:', 'unreleasd:'].includes(url.protocol)
  } catch {
    return false
  }
}

function truncateString(str: string | undefined, maxLength: number): string | undefined {
  if (!str) return undefined
  return str.length > maxLength ? str.substring(0, maxLength - 3) + '...' : str
}

const DEBUG_ENABLED = process.env.UNRL_PRESENCE_DEBUG === '1'
let lastDebugLog = 0
const DEBUG_DEBOUNCE_MS = 5000

function debugLog(message: string, data?: unknown): void {
  if (!DEBUG_ENABLED) return
  console.log(`[RP:Preload] ${message}`, data)
}

/** An https link of at most 300 characters, or nothing. */
function httpsOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 300 && value.startsWith('https://') ? value : undefined
}

function normalizePayload(input: any): any {
  // Accept both camelCase and snake_case, normalize to snake_case for main
  const artist_name = input.artist_name || input.artistName
  const artist_id = input.artist_id || input.artistId
  const track_title = input.track_title || input.trackTitle
  const album_name = input.album_name || input.albumName
  const album_type = input.album_type || input.albumType
  const album_tracks_count = input.album_tracks_count !== undefined ? input.album_tracks_count : input.albumTracksCount
  const is_single = input.is_single !== undefined ? input.is_single : input.isSingle
  const track_image_url = input.track_image_url || input.trackImageUrl
  const position_ms = input.position_ms !== undefined ? input.position_ms : input.positionMs
  const duration_ms = input.duration_ms !== undefined ? input.duration_ms : input.durationMs
  const is_playing = input.is_playing !== undefined ? input.is_playing : input.isPlaying
  const seek_seq = input.seek_seq !== undefined ? input.seek_seq : input.seekSeq
  const track_id = input.track_id || input.trackId
  const deep_link = input.deep_link || input.deepLink
  const artist_url = input.artist_url || input.artistUrl
  const trace_id = input.trace_id || input.traceId
  // Alias-resolved Discord asset name + hover text, decided by the web app from
  // the admin-managed alias table.
  const asset_key = input.asset_key || input.assetKey
  const asset_text = input.asset_text || input.assetText

  // CRITICAL: Prioritize explicit context over inference
  // If input.context is explicitly set, use it (including 'artist' and 'track')
  // This prevents losing context when caller explicitly provides it
  let finalContext: 'browsing' | 'artist' | 'track' | 'profile'

  if (input.context) {
    // Explicit context takes absolute priority - trust the caller
    finalContext = input.context
  } else {
    // Infer context only when not explicitly provided
    // Only treat as 'track' if we have track_title or position_ms (strong track signals)
    const hasTrackInfo = track_title || position_ms !== undefined
    finalContext = hasTrackInfo && is_playing !== false ? 'track' : 'browsing'
  }

  // Debounced debug logging when UNRL_PRESENCE_DEBUG=1
  const now = Date.now()
  if (DEBUG_ENABLED && (now - lastDebugLog) >= DEBUG_DEBOUNCE_MS) {
    console.log('[RP:Preload] Normalized →', {
      trace: trace_id ? trace_id.substring(0, 8) : '(none)',
      title: track_title ? `"${track_title.substring(0, 30)}"` : '(none)',
      artist: artist_name ? `"${artist_name.substring(0, 30)}"` : '(none)',
      pos: position_ms !== undefined ? `${Math.floor(position_ms/1000)}s` : '(none)',
      dur: duration_ms !== undefined ? `${Math.floor(duration_ms/1000)}s` : '(none)',
      playing: is_playing !== undefined ? is_playing : '(none)',
      ctx: finalContext,
      explicitCtx: input.context ? 'YES' : 'NO'
    })
    lastDebugLog = now
  }

  // Forward all fields in snake_case to main - never drop artist_name even on browsing
  return {
    context: finalContext,
    artist_name,
    artist_id,
    track_title,
    album_name,
    album_type,
    album_tracks_count,
    is_single,
    track_image_url,
    asset_key,
    asset_text,
    deep_link,
    artist_url,
    timestamp: input.timestamp,
    position_ms,
    duration_ms,
    is_playing,
    seek_seq,
    track_id,
    trace_id,
  }
}

/**
 * Discord asset names are `[a-z0-9_-]`, max 32 chars. Anything else is rejected
 * by the Discord client, which then renders no art at all — so drop a malformed
 * key here and let the main process fall back to its derived key instead.
 */
function sanitizeAssetKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (!trimmed || trimmed.length > 32) return undefined
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : undefined
}

const unrlPresenceAPI = {
  update: (payload: unknown): void => {
    // These fire on every position tick (multiple times a second while
    // playing). Unconditional logging here flooded the console and kept a
    // reference to every payload; gate it behind UNRL_PRESENCE_DEBUG=1.
    debugLog('update() called', payload)
    try {
      if (!isCurrentOriginAllowed()) {
        console.warn('[Presence] Blocked: origin not allowed:', window.location.origin)
        return
      }

      if (!payload || typeof payload !== 'object') {
        console.warn('[Presence] Invalid payload: not an object')
        return
      }

      const data = payload as Partial<PresencePayload>

      if (data.context && !['browsing', 'artist', 'track', 'profile'].includes(data.context)) {
        console.warn('[Presence] Invalid context:', data.context)
        return
      }

      const deepLink = (data as any).deep_link || data.deepLink
      if (deepLink && !isValidDeepLink(deepLink)) {
        console.warn('[Presence] Invalid deep link:', deepLink)
        return
      }

      const normalized = normalizePayload(data)
      debugLog('normalized payload', normalized)

      // Validate track_image_url if present: must be HTTPS and ≤300 chars
      let validatedImageUrl = normalized.track_image_url
      if (validatedImageUrl) {
        if (typeof validatedImageUrl === 'string' && validatedImageUrl.length <= 300 && validatedImageUrl.startsWith('https://')) {
          // Valid HTTPS URL
        } else {
          validatedImageUrl = undefined
        }
      }

      // Forward all snake_case fields to main, truncate strings ≤128, validate URLs
      const sanitized: any = {
        context: normalized.context,
        artist_name: truncateString(normalized.artist_name, 128),
        artist_id: normalized.artist_id,
        track_title: truncateString(normalized.track_title, 128),
        album_name: truncateString(normalized.album_name, 128),
        album_type: truncateString(normalized.album_type, 128),
        album_tracks_count: typeof normalized.album_tracks_count === 'number' ? normalized.album_tracks_count : undefined,
        is_single: typeof normalized.is_single === 'boolean' ? normalized.is_single : undefined,
        track_image_url: validatedImageUrl,
        asset_key: sanitizeAssetKey(normalized.asset_key),
        asset_text: truncateString(normalized.asset_text, 128),
        // The card's click-throughs (presence.ts siteLink decides which are used).
        deep_link: httpsOrUndefined(normalized.deep_link),
        artist_url: httpsOrUndefined(normalized.artist_url),
        timestamp: typeof normalized.timestamp === 'number' ? normalized.timestamp : undefined,
        position_ms: typeof normalized.position_ms === 'number' ? normalized.position_ms : undefined,
        duration_ms: typeof normalized.duration_ms === 'number' ? normalized.duration_ms : undefined,
        is_playing: typeof normalized.is_playing === 'boolean' ? normalized.is_playing : undefined,
        seek_seq: typeof normalized.seek_seq === 'number' ? normalized.seek_seq : undefined,
        track_id: truncateString(normalized.track_id, 128),
        trace_id: normalized.trace_id,
      }

      debugLog('sending to main', sanitized)
      ipcRenderer.send('presence:update', sanitized)
    } catch (error) {
      console.error('[Presence] Error sending update:', error)
    }
  },

  clear: (): void => {
    try {
      if (!isCurrentOriginAllowed()) {
        console.warn('[Presence] Blocked: origin not allowed:', window.location.origin)
        return
      }

      ipcRenderer.send('presence:clear')
    } catch (error) {
      console.error('[Presence] Error clearing presence:', error)
    }
  },

  ping: async (): Promise<{ origin: string; hasDiscord: boolean }> => {
    try {
      const result = await ipcRenderer.invoke('presence:ping')
      return result
    } catch (error) {
      console.error('[Presence] Error pinging:', error)
      return { origin: '', hasDiscord: false }
    }
  },

  /**
   * The Discord builds currently running, for the Privacy section of Settings.
   *
   * `supported: false` means this helper predates multi-client support or was
   * built without a Discord client id — the web app renders nothing rather
   * than an empty list, so an older desktop app degrades quietly.
   */
  listDiscordClients: async (): Promise<{
    supported: boolean
    reason?: string
    clients: Array<{
      pipeId: number
      flavor: 'stable' | 'ptb' | 'canary' | 'unknown'
      label: string
      connected: boolean
      ready: boolean
      username: string | null
      enabled: boolean
    }>
    prefs: Record<string, boolean>
  }> => {
    try {
      if (!isCurrentOriginAllowed()) {
        return { supported: false, reason: 'origin not allowed', clients: [], prefs: {} }
      }
      return await ipcRenderer.invoke('presence:list-clients')
    } catch (error) {
      console.error('[Presence] Error listing Discord clients:', error)
      return { supported: false, reason: 'helper did not respond', clients: [], prefs: {} }
    }
  },

  /** Turn presence on or off for one Discord build, on this computer. */
  setDiscordClientEnabled: async (
    flavor: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string; clients?: unknown; prefs?: Record<string, boolean> }> => {
    try {
      if (!isCurrentOriginAllowed()) {
        return { ok: false, error: 'origin not allowed' }
      }
      if (typeof flavor !== 'string' || typeof enabled !== 'boolean') {
        return { ok: false, error: 'invalid arguments' }
      }
      return await ipcRenderer.invoke('presence:set-client-enabled', flavor, enabled)
    } catch (error: any) {
      console.error('[Presence] Error setting Discord client:', error)
      return { ok: false, error: error?.message || 'helper did not respond' }
    }
  },
}

contextBridge.exposeInMainWorld('unrlPresence', unrlPresenceAPI)

// ---------------------------------------------------------------------------
// Signing in through the browser (1.0.5+; app/deepLink.ts tells the story).
//
// The page (lib/auth/desktopSignIn.ts on the site) subscribes with
// onHandoff(). When the OS hands the app a sign-in link, main holds the
// handoff and nudges ('auth:handoff-ready'); this side then TAKES it
// ('auth:take-handoff'), which main answers once, only for this window's page
// on an allowed origin. Subscribing takes too, so a link that started the app
// reaches the page however late it subscribes. The page gets the handoff and
// the state and nothing else; it redeems them with the verifier it kept.
// `version` lets the site tell this app from 1.0.4 and older, which have no
// unrlAuth at all and keep email and password as the only way in.
// ---------------------------------------------------------------------------

interface AuthHandoff {
  handoff: string
  state: string
}

const handoffListeners = new Set<(link: AuthHandoff) => void>()
let taking = false
let takeAgain = false

async function takeHandoff(): Promise<void> {
  if (handoffListeners.size === 0 || !isCurrentOriginAllowed()) return
  if (taking) {
    // A nudge while a take is in flight: take once more after it, so no link waits for the next one.
    takeAgain = true
    return
  }
  taking = true
  try {
    do {
      takeAgain = false
      const link = await ipcRenderer.invoke('auth:take-handoff')
      if (link && typeof link.handoff === 'string' && typeof link.state === 'string') {
        for (const listener of Array.from(handoffListeners)) {
          try {
            listener({ handoff: link.handoff, state: link.state })
          } catch (error) {
            console.error('[Auth] A sign-in listener failed:', error)
          }
        }
      }
    } while (takeAgain)
  } catch (error) {
    console.error('[Auth] Could not take the sign-in from the browser:', error)
  } finally {
    taking = false
  }
}

ipcRenderer.on('auth:handoff-ready', () => {
  void takeHandoff()
})

const unrlAuthAPI = {
  /** 1: onHandoff exists, and this app opens world.unreleased.aura:// sign-in links. */
  version: 1,

  /** Calls `callback` with each sign-in the browser hands back. Returns the unsubscribe. */
  onHandoff: (callback: (link: AuthHandoff) => void): (() => void) => {
    if (typeof callback !== 'function' || !isCurrentOriginAllowed()) return () => {}
    handoffListeners.add(callback)
    void takeHandoff()
    return () => {
      handoffListeners.delete(callback)
    }
  },
}

contextBridge.exposeInMainWorld('unrlAuth', unrlAuthAPI)

// ---------------------------------------------------------------------------
// Full screen (1.0.12+; app/fullscreen.ts tells the story).
//
// A full-screen window has no title bar on Windows, so the site draws its own
// "Exit full screen" button while the window is in full screen. The page asks
// whether it is (isFullScreen), hears each change (onFullScreenChange: main
// sends 'window:full-screen-changed' as the window enters and leaves full
// screen, F11's or a video's), and asks to leave (exitFullScreen). Only on an
// allowed origin, and main answers only the main window's own page; nothing
// else about the window is exposed. `version` tells this app from 1.0.11 and
// older, which have no unrlWindow (there, only F11 leaves F11's full screen),
// and 1.0.13's window buttons (version 2, below) from 1.0.12.
// ---------------------------------------------------------------------------

const fullScreenListeners = new Set<(fullScreen: boolean) => void>()

ipcRenderer.on('window:full-screen-changed', (_event, value: unknown) => {
  if (typeof value !== 'boolean' || !isCurrentOriginAllowed()) return
  for (const listener of Array.from(fullScreenListeners)) {
    try {
      listener(value)
    } catch (error) {
      console.error('[Window] A full-screen listener failed:', error)
    }
  }
})

// ---------------------------------------------------------------------------
// The window's buttons in the site's top bar (1.0.13+; app/titleBar.ts tells
// the story). Main decides per window, at its creation, between the overlay
// (Windows and macOS draw only their buttons, over the top corner of the page)
// and the frame (exactly as before); the mode arrives as a process argument,
// like the origins. Under the overlay the page asks where the buttons are and
// how much room they take (getTitleBar), hears each change (onTitleBarChange:
// a resize, maximize and restore, full screen, a zoom or a move to a screen
// with another scale), and says which colours sit under them
// (setTitleBarTheme), which is also its word that it is ready for the
// overlay. The box is the overlay's own geometry
// (navigator.windowControlsOverlay), in the page's CSS pixels. Only on an
// allowed origin; anywhere else the page is told "no overlay".
// ---------------------------------------------------------------------------

const TITLE_BAR_ARGV_PREFIX = '--unrl-title-bar='
/** The contract with the site (app/titleBar.ts TITLE_BAR_PROTOCOL). */
const TITLE_BAR_PROTOCOL = 1

function readTitleBarMode(): 'overlay' | 'frame' {
  const arg = process.argv.find((a) => a.startsWith(TITLE_BAR_ARGV_PREFIX))
  return arg && arg.slice(TITLE_BAR_ARGV_PREFIX.length) === 'overlay' ? 'overlay' : 'frame'
}

const TITLE_BAR_MODE = readTitleBarMode()
const PLATFORM = typeof process.platform === 'string' ? process.platform : 'unknown'

interface TitleBarState {
  /** The page is drawn under the window's buttons (false: the window has its normal frame). */
  overlay: boolean
  /** The contract this window speaks (TITLE_BAR_PROTOCOL). */
  protocol: number
  /** Where the buttons are: the right on Windows, the left on a Mac; null without the overlay. */
  side: 'left' | 'right' | null
  /** The buttons are on screen now (not in full screen on a Mac, for one). */
  visible: boolean
  /** The buttons' box, in the page's CSS pixels; all 0 while they are not visible. */
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
  fullScreen: boolean
}

type OverlayRect = { x: number; y: number; width: number; height: number }
type WindowControlsOverlayLike = {
  visible?: boolean
  getTitlebarAreaRect?: () => OverlayRect
  addEventListener?: (type: string, listener: () => void) => void
}

let windowFlags = { maximized: false, fullScreen: false }

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The buttons' box from the overlay: the window's width outside the titlebar area, on the buttons' side. */
function readTitleBar(): TitleBarState {
  const overlay = TITLE_BAR_MODE === 'overlay' && (PLATFORM === 'win32' || PLATFORM === 'darwin') && isCurrentOriginAllowed()
  const state: TitleBarState = {
    overlay,
    protocol: TITLE_BAR_PROTOCOL,
    side: overlay ? (PLATFORM === 'darwin' ? 'left' : 'right') : null,
    visible: false,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    maximized: windowFlags.maximized,
    fullScreen: windowFlags.fullScreen,
  }
  if (!overlay) return state
  try {
    const wco = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike }).windowControlsOverlay
    if (!wco || wco.visible !== true || typeof wco.getTitlebarAreaRect !== 'function') return state
    const area = wco.getTitlebarAreaRect()
    const areaX = finite(area.x)
    const areaRight = areaX + finite(area.width)
    const height = finite(area.y) + finite(area.height)
    const viewport = finite(window.innerWidth)
    const x = state.side === 'left' ? 0 : areaRight
    const width = state.side === 'left' ? areaX : viewport - areaRight
    if (width <= 0 || height <= 0) return state
    return { ...state, visible: true, x, y: 0, width, height }
  } catch {
    return state
  }
}

const titleBarListeners = new Set<(state: TitleBarState) => void>()
let lastTitleBar = ''
let titleBarFrame = 0

/** Reads the box again and tells the page when anything in it changed. Coalesced to one read a frame. */
function titleBarMaybeChanged(): void {
  if (titleBarListeners.size === 0 || titleBarFrame) return
  const run = () => {
    titleBarFrame = 0
    const state = readTitleBar()
    const key = JSON.stringify(state)
    if (key === lastTitleBar) return
    lastTitleBar = key
    for (const listener of Array.from(titleBarListeners)) {
      try {
        listener({ ...state })
      } catch (error) {
        console.error('[Window] A title-bar listener failed:', error)
      }
    }
  }
  titleBarFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number)
}

let titleBarWatching = false
/** The overlay's own events, the window's size and its pixel ratio (a zoom, or another screen's scale). */
function watchTitleBar(): void {
  if (titleBarWatching || TITLE_BAR_MODE !== 'overlay') return
  titleBarWatching = true
  try {
    const wco = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike }).windowControlsOverlay
    wco?.addEventListener?.('geometrychange', titleBarMaybeChanged)
  } catch {
    // No overlay object: the resize below still reads it.
  }
  window.addEventListener('resize', titleBarMaybeChanged)
  const watchRatio = () => {
    try {
      const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      const onChange = () => {
        query.removeEventListener('change', onChange)
        watchRatio()
        titleBarMaybeChanged()
      }
      query.addEventListener('change', onChange)
    } catch {
      // No matchMedia: a zoom still resizes the viewport in CSS pixels.
    }
  }
  watchRatio()
}

ipcRenderer.on('window:title-bar-changed', (_event, value: unknown) => {
  if (!value || typeof value !== 'object') return
  const flags = value as { maximized?: unknown; fullScreen?: unknown }
  windowFlags = { maximized: flags.maximized === true, fullScreen: flags.fullScreen === true }
  titleBarMaybeChanged()
})

const unrlWindowAPI = {
  /**
   * 1: isFullScreen, onFullScreenChange and exitFullScreen exist, and Esc leaves full screen.
   * 2: also platform, getTitleBar, onTitleBarChange and setTitleBarTheme (the buttons in the site's top bar).
   */
  version: 2,

  /** The operating system: 'win32', 'darwin' or 'linux'. */
  platform: PLATFORM,

  /** Where the window's buttons are and how much room they take now (the page draws nothing there). */
  getTitleBar: (): TitleBarState => readTitleBar(),

  /** Calls `callback` with the new box each time it changes. Returns the unsubscribe. */
  onTitleBarChange: (callback: (state: TitleBarState) => void): (() => void) => {
    if (typeof callback !== 'function' || !isCurrentOriginAllowed()) return () => {}
    titleBarListeners.add(callback)
    lastTitleBar = JSON.stringify(readTitleBar())
    watchTitleBar()
    return () => {
      titleBarListeners.delete(callback)
    }
  },

  /**
   * The colours under the buttons, 'dark' or 'light', in the protocol the page speaks. Also the page's word that it
   * is ready for the overlay (its drag band and its room for the buttons are in place). True when main took it.
   */
  setTitleBarTheme: async (theme: unknown, protocol: unknown = TITLE_BAR_PROTOCOL): Promise<boolean> => {
    try {
      if (!isCurrentOriginAllowed()) return false
      if ((theme !== 'dark' && theme !== 'light') || protocol !== TITLE_BAR_PROTOCOL) return false
      return (await ipcRenderer.invoke('window:title-bar-theme', theme, protocol)) === true
    } catch (error) {
      console.error('[Window] Could not set the title bar colours:', error)
      return false
    }
  },

  /** Whether the window is full screen now; false when this page may not ask. */
  isFullScreen: async (): Promise<boolean> => {
    try {
      if (!isCurrentOriginAllowed()) return false
      return (await ipcRenderer.invoke('window:is-full-screen')) === true
    } catch (error) {
      console.error('[Window] Could not tell whether the window is full screen:', error)
      return false
    }
  },

  /** Calls `callback` with true or false each time the window enters or leaves full screen. Returns the unsubscribe. */
  onFullScreenChange: (callback: (fullScreen: boolean) => void): (() => void) => {
    if (typeof callback !== 'function' || !isCurrentOriginAllowed()) return () => {}
    fullScreenListeners.add(callback)
    return () => {
      fullScreenListeners.delete(callback)
    }
  },

  /** Leaves full screen (F11's or a video's). True when the window was full screen. */
  exitFullScreen: async (): Promise<boolean> => {
    try {
      if (!isCurrentOriginAllowed()) return false
      return (await ipcRenderer.invoke('window:exit-full-screen')) === true
    } catch (error) {
      console.error('[Window] Could not leave full screen:', error)
      return false
    }
  },
}

contextBridge.exposeInMainWorld('unrlWindow', unrlWindowAPI)

// ---------------------------------------------------------------------------
// Esc in a text field, in full screen (1.0.14; app/fullscreen.ts tells the
// story). Main takes a plain Esc while the window is full screen, to leave it;
// while a text field has the cursor, that Esc is the field's instead (the full
// player's Search box clears, then lets go of the cursor), and the next one,
// with no field focused, leaves. So this side tells main ('window:typing', a
// boolean and nothing else) each time that changes, and again at every
// full-screen change it hears, since main forgets it on the way out. Only on
// an allowed origin. Nothing is exposed to the page: unrlWindow is unchanged.
//
// A text field is what the site's own isEditableTarget
// (components/player/playerHotkeys.ts) counts, less the inputs that are
// buttons and switches: an input that takes typing, a textarea, a select,
// anything editable (contenteditable with any value, the site's own
// plaintext-only editor included) and role="textbox". Focus inside an open
// shadow root is followed to the element that has it. A closed shadow root
// hides that element, so its host is judged on its own (not a text field,
// unless the host itself is editable) and Esc there leaves full screen, as in
// 1.0.13: never the other way round, since an Esc that cannot leave full
// screen is what this must never cause.
// ---------------------------------------------------------------------------

/** Inputs that are buttons and switches, not typing: Esc on them leaves full screen. */
const NOT_TYPING_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'image', 'file'])

/** The element with the cursor, followed into open shadow roots; a closed one stops at its host. */
function focusedElement(): Element | null {
  let element: Element | null = document.activeElement
  for (let depth = 0; element && depth < 32; depth++) {
    const inner = element.shadowRoot?.activeElement
    if (!inner) break
    element = inner
  }
  return element
}

/** Something that takes typing, whose Esc is its own. */
function isTextField(element: Element | null): boolean {
  if (!element) return false
  const tag = String(element.tagName).toUpperCase()
  if (tag === 'INPUT') return !NOT_TYPING_INPUTS.has(String((element as HTMLInputElement).type).toLowerCase())
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((element as HTMLElement).isContentEditable === true) return true
  return typeof element.getAttribute === 'function' && element.getAttribute('role') === 'textbox'
}

let typingSaid = false

/** Tells main whether a text field has the cursor: when that changed, or regardless (`again`). */
function sayTyping(again = false): void {
  try {
    if (typeof document === 'undefined' || !isCurrentOriginAllowed()) return
    const typing = isTextField(focusedElement())
    if (typing === typingSaid && !again) return
    typingSaid = typing
    ipcRenderer.send('window:typing', typing)
  } catch (error) {
    console.error('[Window] Could not tell main whether a text field has the cursor:', error)
  }
}

try {
  // The cursor arriving is decided at once; leaving, once it has landed, so
  // Tab from one field to the next says nothing.
  window.addEventListener('focusin', () => sayTyping(), true)
  window.addEventListener('focusout', () => setTimeout(() => sayTyping(), 0), true)
  // After each Esc the page hears, once the page has acted on it: a field that
  // lost the cursor without a focusout (taken off the page with the cursor in
  // it, say) is noticed then, so at worst one Esc is the page's before the
  // next one leaves full screen.
  window.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTimeout(() => sayTyping(), 0)
    },
    true,
  )
} catch (error) {
  // No way to watch the cursor: main never hears true, and Esc leaves full screen as in 1.0.13.
  console.error('[Window] Could not watch for text fields:', error)
}

// Main forgets on the way out of full screen: say it again at every change.
ipcRenderer.on('window:full-screen-changed', () => sayTyping(true))

// Kept unconditional: one line at load, and it's the first thing to check when
// someone reports "presence isn't showing up".
console.log(
  `[RP:Preload] Bridge exposed on window.unrlPresence — origin ${window.location.origin} ` +
    `is ${isCurrentOriginAllowed() ? 'allowed' : 'BLOCKED'} (allowed: ${ALLOWED_ORIGINS.join(', ')})`,
)

declare global {
  interface Window {
    unrlPresence: typeof unrlPresenceAPI
    unrlAuth: typeof unrlAuthAPI
    unrlWindow: typeof unrlWindowAPI
  }
}
