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
        deep_link: normalized.deep_link,
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
  }
}

contextBridge.exposeInMainWorld('unrlPresence', unrlPresenceAPI)

// Kept unconditional: one line at load, and it's the first thing to check when
// someone reports "presence isn't showing up".
console.log(
  `[RP:Preload] Bridge exposed on window.unrlPresence — origin ${window.location.origin} ` +
    `is ${isCurrentOriginAllowed() ? 'allowed' : 'BLOCKED'} (allowed: ${ALLOWED_ORIGINS.join(', ')})`,
)

declare global {
  interface Window {
    unrlPresence: typeof unrlPresenceAPI
  }
}
