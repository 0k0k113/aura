"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPresenceActivity = createPresenceActivity;
const FALLBACK_ASSET_KEY = 'unreleasd_logo';
const BASE_URL = 'https://unreleasedworld.netlify.app';
const APP_NAME = 'unreleased.world';
// Transliteration map for special characters to readable ASCII
const TRANSLITERATION_MAP = {
    '$': 's',
    '€': 'e',
    '£': 'l',
    '¥': 'y',
    '¢': 'c',
    '&': 'and',
    '+': 'plus',
};
const LOG_ENABLED = process.env.UNRL_PRESENCE_LOG === '1';
let lastLogTime = 0;
const LOG_DEBOUNCE_MS = 5000;
function logActivity(msg, fields, traceId) {
    if (!LOG_ENABLED)
        return;
    const now = Date.now();
    if (now - lastLogTime < LOG_DEBOUNCE_MS)
        return;
    lastLogTime = now;
    const prefix = traceId ? `[RP:Main][${traceId}]` : '[RP:Main]';
    console.log(`${prefix} ${msg}`, fields);
}
function truncate(str, maxLength) {
    if (!str)
        return undefined;
    return str.length > maxLength ? str.substring(0, maxLength) : str;
}
function cleanArtistName(rawName) {
    if (!rawName)
        return undefined;
    let cleaned = rawName;
    try {
        cleaned = decodeURIComponent(cleaned);
    }
    catch {
        // Invalid URI encoding, use as-is
    }
    // Strip page-context prefixes when paired with artist slug
    cleaned = cleaned.replace(/^(exploring|explorting|artist|profile)\s+/i, '');
    // Replace hyphens and underscores with spaces
    cleaned = cleaned.replace(/[-_]/g, ' ');
    // Collapse whitespace
    cleaned = cleaned.trim().replace(/\s+/g, ' ');
    // Title case with exceptions
    const words = cleaned.split(' ');
    const titleCased = words.map((word) => {
        const lower = word.toLowerCase();
        if (['feat', 'vs', 'pt', 'feat.', 'vs.', 'pt.'].includes(lower)) {
            return lower;
        }
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
    return titleCased.join(' ');
}
function artistAssetKey(artistName) {
    if (!artistName)
        return FALLBACK_ASSET_KEY;
    const cleaned = cleanArtistName(artistName);
    if (!cleaned)
        return FALLBACK_ASSET_KEY;
    // Apply transliteration for special characters
    let transliterated = cleaned;
    for (const [char, replacement] of Object.entries(TRANSLITERATION_MAP)) {
        transliterated = transliterated.replace(new RegExp('\\' + char, 'g'), replacement);
    }
    // Convert to slug: lowercase, non-alphanumeric → underscore, collapse
    const slug = transliterated
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    return slug ? `artist_${slug}` : FALLBACK_ASSET_KEY;
}
function isSingleTrack(payload) {
    // Classification order (first match wins):
    if (payload.is_single === true)
        return true;
    if (payload.is_single === false)
        return false;
    if (payload.album_type?.toLowerCase() === 'single')
        return true;
    if (payload.album_tracks_count === 1)
        return true;
    if (payload.album_name && payload.track_title) {
        const albumTrim = payload.album_name.trim().toLowerCase();
        const trackTrim = payload.track_title.trim().toLowerCase();
        if (albumTrim === trackTrim)
            return true;
    }
    return false;
}
function albumAssetSlug(albumName) {
    if (!albumName)
        return FALLBACK_ASSET_KEY;
    let transliterated = albumName;
    for (const [char, replacement] of Object.entries(TRANSLITERATION_MAP)) {
        transliterated = transliterated.replace(new RegExp('\\' + char, 'g'), replacement);
    }
    const slug = transliterated
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    return slug ? `album_${slug}` : FALLBACK_ASSET_KEY;
}
function getTrackImageFallback(payload) {
    if (payload.album_name) {
        const albumKey = albumAssetSlug(payload.album_name);
        if (albumKey !== FALLBACK_ASSET_KEY)
            return albumKey;
    }
    if (payload.artist_name) {
        return artistAssetKey(payload.artist_name);
    }
    return FALLBACK_ASSET_KEY;
}
function getTrackImageKey(payload) {
    const isSingle = isSingleTrack(payload);
    if (isSingle) {
        if (payload.artist_name) {
            return artistAssetKey(payload.artist_name);
        }
    }
    else {
        const albumKey = albumAssetSlug(payload.album_name);
        if (albumKey !== FALLBACK_ASSET_KEY) {
            return albumKey;
        }
    }
    return getTrackImageFallback(payload);
}
function extractContextFromUrl(url) {
    try {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname.toLowerCase();
        const artistMatch = pathname.match(/\/(?:.*\/)?artist\/([^\/]+)\/?$/i);
        if (artistMatch && artistMatch[1]) {
            try {
                const artist_name = decodeURIComponent(artistMatch[1]);
                return { context: 'artist', artist_name, deep_link: url };
            }
            catch {
                console.warn('[Presence] Failed to decode artist slug');
            }
        }
        const profilePatterns = [
            /^\/profiles?\/([^\/]+)\/?$/i,
            /^\/users?\/([^\/]+)\/?$/i,
            /^\/@([^\/]+)\/?$/i,
            /^\/u\/([^\/]+)\/?$/i,
            /^\/account\/?$/i,
        ];
        for (const pattern of profilePatterns) {
            if (pattern.test(pathname))
                return { context: 'profile', deep_link: url };
        }
        if (pathname === '/home' || pathname === '/library' || pathname === '/') {
            return { context: 'browsing' };
        }
        return { context: 'browsing' };
    }
    catch (error) {
        console.error('[Presence] Error parsing URL:', error);
        return { context: 'browsing' };
    }
}
function createPresenceActivity(currentUrl, payload) {
    try {
        const urlContext = extractContextFromUrl(currentUrl);
        const merged = { ...urlContext, ...payload };
        let context;
        if (payload?.context && payload.context !== 'track') {
            context = payload.context;
        }
        else {
            const hasTrackInfo = merged.track_title || merged.artist_name;
            const isPlaying = merged.is_playing === true;
            if (hasTrackInfo && !isPlaying && merged.artist_name) {
                context = 'artist';
            }
            else if (hasTrackInfo && isPlaying) {
                context = 'track';
            }
            else {
                context = merged.context || 'browsing';
            }
        }
        const { track_title, deep_link, position_ms, duration_ms, is_playing, trace_id } = merged;
        const artist_name = context === 'track' && payload?.artist_name
            ? payload.artist_name
            : (context === 'artist' ? merged.artist_name : undefined);
        let details;
        let state;
        let largeImageKey;
        let largeImageText;
        const cleanedArtist = cleanArtistName(artist_name);
        switch (context) {
            case 'browsing':
                details = 'Browsing';
                state = APP_NAME;
                largeImageKey = FALLBACK_ASSET_KEY;
                largeImageText = undefined; // avoid duplicate "unreleased.world"
                break;
            case 'artist':
                if (!artist_name) {
                    details = 'Browsing';
                    state = undefined;
                    largeImageKey = FALLBACK_ASSET_KEY;
                    largeImageText = undefined;
                }
                else {
                    details = 'Browsing';
                    state = undefined;
                    largeImageKey = artistAssetKey(artist_name);
                    largeImageText = cleanedArtist || APP_NAME;
                }
                break;
            case 'profile':
                details = 'Profile';
                state = undefined;
                largeImageKey = FALLBACK_ASSET_KEY;
                largeImageText = APP_NAME;
                break;
            case 'track':
                if (!track_title && !artist_name) {
                    console.warn('[Presence] Track context but no metadata - this indicates a bug');
                    details = 'Browsing';
                    state = undefined;
                    largeImageKey = FALLBACK_ASSET_KEY;
                    largeImageText = APP_NAME;
                }
                else {
                    details = truncate(track_title || 'Untitled', 128);
                    state = undefined;
                    largeImageKey = getTrackImageKey(payload);
                    largeImageText = cleanedArtist || APP_NAME;
                }
                break;
            default:
                return null;
        }
        if (!details || details.trim().length === 0)
            return null;
        // Always show "Listening to unreleased.world"
        const topName = APP_NAME;
        const activityType = 2;
        const presence = {
            name: topName,
            type: activityType,
            details: truncate(details, 128),
            state: state ? truncate(state, 128) : undefined,
            largeImageKey,
            largeImageText: truncate(largeImageText, 128)
        };
        if (context === 'track') {
            presence.buttons = undefined;
        }
        else if (context === 'artist') {
            presence.buttons = undefined;
        }
        else if (context === 'profile') {
            if (deep_link && (deep_link.startsWith('http://') || deep_link.startsWith('https://'))) {
                presence.buttons = [{ label: 'View profile', url: deep_link }];
            }
        }
        else {
            presence.buttons = [{ label: 'unreleased.world', url: BASE_URL }];
        }
        if (context === 'track' && is_playing === true && position_ms !== undefined && position_ms >= 0) {
            const nowMs = Date.now();
            const startTimestampMs = nowMs - position_ms;
            presence.startTimestamp = Math.floor(startTimestampMs / 1000);
            if (duration_ms !== undefined && duration_ms > 0) {
                const endTimestampMs = startTimestampMs + duration_ms;
                presence.endTimestamp = Math.floor(endTimestampMs / 1000);
            }
        }
        else {
            delete presence.startTimestamp;
            delete presence.endTimestamp;
        }
        logActivity('SetActivity', {
            name: presence.name,
            details: presence.details,
            state: presence.state || '(empty)',
            img: presence.largeImageKey,
            imgTxt: presence.largeImageText,
            hasTimer: !!presence.startTimestamp
        }, trace_id);
        return presence;
    }
    catch (error) {
        console.error('[Presence] Error creating activity:', error);
        return null;
    }
}
//# sourceMappingURL=presence.js.map