// app/presence.ts
import type { SetActivity } from '@xhayper/discord-rpc'

interface PresencePayload {
  context?: 'browsing' | 'artist' | 'track' | 'profile'
  artist_name?: string
  artist_id?: string
  track_title?: string
  album_name?: string
  album_type?: string
  album_tracks_count?: number
  is_single?: boolean
  track_image_url?: string
  /**
   * Discord asset name resolved by the web app from the admin-managed alias
   * table. Wins over anything derived here — Discord rejects a great many real
   * album titles as asset names (length, punctuation, explicit wording), so
   * admins upload the art under a safe key and alias the real title to it.
   */
  asset_key?: string
  /** Hover text override that travels with the alias. */
  asset_text?: string
  deep_link?: string
  timestamp?: number
  position_ms?: number
  duration_ms?: number
  is_playing?: boolean
  seek_seq?: number
  track_id?: string
  trace_id?: string
}

const FALLBACK_ASSET_KEY = 'unreleasd_logo'
const APP_NAME = 'unreleased.world'

// Transliteration map for special characters to readable ASCII
const TRANSLITERATION_MAP: Record<string, string> = {
  '$': 's',
  '€': 'e',
  '£': 'l',
  '¥': 'y',
  '¢': 'c',
  '&': 'and',
  '+': 'plus',
}

const LOG_ENABLED = process.env.UNRL_PRESENCE_LOG === '1'
let lastLogTime = 0
const LOG_DEBOUNCE_MS = 5000

function logActivity(msg: string, fields: any, traceId?: string): void {
  if (!LOG_ENABLED) return
  const now = Date.now()
  if (now - lastLogTime < LOG_DEBOUNCE_MS) return
  lastLogTime = now
  const prefix = traceId ? `[RP:Main][${traceId}]` : '[RP:Main]'
  console.log(`${prefix} ${msg}`, fields)
}

function truncate(str: string | undefined, maxLength: number): string | undefined {
  if (!str) return undefined
  return str.length > maxLength ? str.substring(0, maxLength) : str
}

function cleanArtistName(rawName: string | undefined): string | undefined {
  if (!rawName) return undefined

  let cleaned = rawName

  try {
    cleaned = decodeURIComponent(cleaned)
  } catch {
    // Invalid URI encoding, use as-is
  }

  // Strip page-context prefixes when paired with artist slug
  cleaned = cleaned.replace(/^(exploring|explorting|artist|profile)\s+/i, '')

  // Replace hyphens and underscores with spaces
  cleaned = cleaned.replace(/[-_]/g, ' ')

  // Collapse whitespace
  cleaned = cleaned.trim().replace(/\s+/g, ' ')

  // Title case with exceptions
  const words = cleaned.split(' ')
  const titleCased = words.map((word) => {
    const lower = word.toLowerCase()
    if (['feat', 'vs', 'pt', 'feat.', 'vs.', 'pt.'].includes(lower)) {
      return lower
    }
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  })

  return titleCased.join(' ')
}

function artistAssetKey(artistName: string | undefined): string {
  if (!artistName) return FALLBACK_ASSET_KEY

  const cleaned = cleanArtistName(artistName)
  if (!cleaned) return FALLBACK_ASSET_KEY

  // Apply transliteration for special characters
  let transliterated = cleaned
  for (const [char, replacement] of Object.entries(TRANSLITERATION_MAP)) {
    transliterated = transliterated.replace(new RegExp('\\' + char, 'g'), replacement)
  }

  // Convert to slug: lowercase, non-alphanumeric → underscore, collapse
  const slug = transliterated
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')

  return slug ? `artist_${slug}` : FALLBACK_ASSET_KEY
}

/**
 * The album, for the cover-art tooltip.
 *
 * An alias's `asset_text` wins — it exists precisely because Discord refused
 * the real album title as an asset NAME while still displaying it happily.
 * Singles get nothing: their "album" is the track title, already printed
 * directly above, so a tooltip repeating it is noise.
 */
function albumHoverText(payload: PresencePayload): string | undefined {
  if (isSingleTrack(payload)) return undefined
  const aliased = payload.asset_text?.trim()
  if (aliased) return aliased
  const album = payload.album_name?.trim()
  return album || undefined
}

function isSingleTrack(payload: PresencePayload): boolean {
  // Classification order (first match wins):
  if (payload.is_single === true) return true
  if (payload.is_single === false) return false
  if (payload.album_type?.toLowerCase() === 'single') return true
  if (payload.album_tracks_count === 1) return true

  if (payload.album_name && payload.track_title) {
    const albumTrim = payload.album_name.trim().toLowerCase()
    const trackTrim = payload.track_title.trim().toLowerCase()
    if (albumTrim === trackTrim) return true
  }
  return false
}

function albumAssetSlug(albumName: string | undefined): string {
  if (!albumName) return FALLBACK_ASSET_KEY

  let transliterated = albumName
  for (const [char, replacement] of Object.entries(TRANSLITERATION_MAP)) {
    transliterated = transliterated.replace(new RegExp('\\' + char, 'g'), replacement)
  }

  const slug = transliterated
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')

  return slug ? `album_${slug}` : FALLBACK_ASSET_KEY
}

function getTrackImageFallback(payload: PresencePayload): string {
  if (payload.album_name) {
    const albumKey = albumAssetSlug(payload.album_name)
    if (albumKey !== FALLBACK_ASSET_KEY) return albumKey
  }
  if (payload.artist_name) {
    return artistAssetKey(payload.artist_name)
  }
  return FALLBACK_ASSET_KEY
}

/**
 * Discord asset names are `[a-z0-9_-]`, max 32 chars. A key outside that shape
 * makes Discord render no art at all, so treat it as absent and let the derived
 * key take over.
 */
function validAssetKey(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim().toLowerCase()
  if (!trimmed || trimmed.length > 32) return undefined
  return /^[a-z0-9_-]+$/.test(trimmed) ? trimmed : undefined
}

function getTrackImageKey(payload: PresencePayload): string {
  const aliased = validAssetKey(payload.asset_key)
  if (aliased) return aliased

  const isSingle = isSingleTrack(payload)

  if (isSingle) {
    if (payload.artist_name) {
      return artistAssetKey(payload.artist_name)
    }
  } else {
    const albumKey = albumAssetSlug(payload.album_name)
    if (albumKey !== FALLBACK_ASSET_KEY) {
      return albumKey
    }
  }
  return getTrackImageFallback(payload)
}

function extractContextFromUrl(url: string): PresencePayload {
  try {
    const parsedUrl = new URL(url)
    const pathname = parsedUrl.pathname.toLowerCase()

    const artistMatch = pathname.match(/\/(?:.*\/)?artist\/([^\/]+)\/?$/i)
    if (artistMatch && artistMatch[1]) {
      try {
        const artist_name = decodeURIComponent(artistMatch[1])
        return { context: 'artist', artist_name, deep_link: url }
      } catch {
        console.warn('[Presence] Failed to decode artist slug')
      }
    }

    const profilePatterns = [
      /^\/profiles?\/([^\/]+)\/?$/i,
      /^\/users?\/([^\/]+)\/?$/i,
      /^\/@([^\/]+)\/?$/i,
      /^\/u\/([^\/]+)\/?$/i,
      /^\/account\/?$/i,
    ]
    for (const pattern of profilePatterns) {
      if (pattern.test(pathname)) return { context: 'profile', deep_link: url }
    }

    if (pathname === '/home' || pathname === '/library' || pathname === '/') {
      return { context: 'browsing' }
    }
    return { context: 'browsing' }
  } catch (error) {
    console.error('[Presence] Error parsing URL:', error)
    return { context: 'browsing' }
  }
}

/**
 * Build the Discord activity for a presence payload — or nothing at all.
 *
 * There is exactly one card: a track that is PLAYING. Everything else returns
 * `null` — paused, browsing, an artist page, a profile, the moment a track
 * ends, a payload with no metadata. `null` is not an error here; it means
 * "show nothing", and the caller answers it by CLEARING the activity rather
 * than leaving the previous card on screen.
 *
 * That last part is the whole contract: a builder that returns null while the
 * caller only ever calls setActivity would freeze the last card in place
 * forever, which looks exactly like a paused track that never went away.
 */
export function createPresenceActivity(
  currentUrl: string,
  payload?: PresencePayload
): SetActivity | null {
  try {
    const urlContext = extractContextFromUrl(currentUrl)
    const merged: PresencePayload = { ...urlContext, ...payload }

    // ── The gate ────────────────────────────────────────────────────────────
    // Not playing → nothing. `!== true` rather than `=== false` on purpose:
    // a browsing or artist payload carries no `is_playing` at all, and those
    // must show nothing too.
    if (merged.is_playing !== true) return null

    // The display artist comes from the PAYLOAD only. `merged` would fall back
    // to the artist parsed out of the current URL, which is the page you are
    // looking at rather than the track you are hearing — those differ the
    // moment you browse elsewhere mid-song.
    const artist_name = payload?.artist_name
    const { track_title, position_ms, duration_ms, trace_id } = merged

    // A "playing" payload with no metadata would render an empty card.
    if (!track_title && !artist_name) return null

    const cleanedArtist = cleanArtistName(artist_name)

    const albumText = albumHoverText(merged)

    const details = truncate(track_title || 'Untitled', 128)
    if (!details || details.trim().length === 0) return null

    const presence: SetActivity = {
      // The card header stays "Listening to unreleased.world".
      name: APP_NAME,
      type: 2,
      details,
      // The artist doubles as the MEMBER LIST line — see statusDisplayType
      // below. Discord reads that line from a real activity field, so the
      // artist has to travel in `state`; it also renders under the track title
      // in the expanded card, the way every music app shows it.
      //
      // Lowercased, always: it matches the wordmark, and it is the ONE field
      // this applies to — the track title keeps its own casing, and so does
      // "unreleased.world" in the header.
      state: truncate(cleanedArtist?.toLowerCase(), 128),
      // Resolved against `merged`, not the raw payload: URL-derived context
      // carries the artist when the caller omitted it, and the ART is allowed
      // to fall back that way even though the printed name is not.
      largeImageKey: getTrackImageKey(merged),
      // Empty, and it has to stay empty.
      //
      // `large_text` is documented as the cover art's hover tooltip, and it is
      // — but this Discord client ALSO paints it as a line in the card, between
      // the track title and the artist. Both behaviours come from this one
      // field; there is no second field for image text, so "album on hover but
      // not as a line" is not expressible. Setting it was tried and produced
      // exactly that unwanted line, so the line wins and the hover is the cost.
      // ── The album goes on the SMALL image, not the large one ──────────────
      //
      // Discord documents `large_text` as "text displayed when hovering over
      // the large image" — official docs and the reverse-engineered client
      // docs agree. This client does not: it renders large_text as a LINE in
      // the card, between the track title and the artist, AND as the tooltip.
      // Setting it gave the hover back but dragged that line along with it.
      //
      // `small_text` is a separate field with its own hover target, and it has
      // never been part of any card line layout. So the album moves there, and
      // the small image exists to give it something to hover: the site logo,
      // badged on the corner of the artwork the way Spotify badges its own.
      // Large text stays empty, which is what keeps the line away.
      largeImageText: undefined,
      smallImageKey: albumText ? FALLBACK_ASSET_KEY : undefined,
      smallImageText: truncate(albumText, 128),
      // No buttons on the now-playing card.
      buttons: undefined,
    }

    // Member list, next to the 🎵 — the one line Discord shows when the card
    // is collapsed. It defaults to the activity NAME, which made everyone
    // playing anything read "unreleased.world"; pointing it at STATE shows the
    // artist instead, the way Spotify shows who you're listening to. Only when
    // there IS an artist: Discord falls back to the name when the chosen field
    // is empty, so a track with no artist keeps the old behaviour rather than
    // rendering blank.
    if (presence.state) {
      presence.statusDisplayType = 1 // StatusDisplayType.STATE
    }

    // The elapsed/remaining timer. Anchored to `position_ms` so it stays
    // correct across seeks; a track only ever reaches here while playing.
    if (position_ms !== undefined && position_ms >= 0) {
      const startTimestampMs = Date.now() - position_ms
      ;(presence as any).startTimestamp = Math.floor(startTimestampMs / 1000)

      if (duration_ms !== undefined && duration_ms > 0) {
        ;(presence as any).endTimestamp = Math.floor((startTimestampMs + duration_ms) / 1000)
      }
    }

    logActivity('SetActivity', {
      name: presence.name,
      details: presence.details,
      state: presence.state || '(empty)',
      img: presence.largeImageKey,
      imgTxt: presence.largeImageText,
      smallTxt: presence.smallImageText,
      memberList: presence.statusDisplayType === 1 ? presence.state : presence.name,
      hasTimer: !!(presence as any).startTimestamp
    }, trace_id)

    return presence
  } catch (error) {
    console.error('[Presence] Error creating activity:', error)
    return null
  }
}
