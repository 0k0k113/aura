"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const ALLOWED_ORIGIN = 'https://unreleasedworld.netlify.app';
function isValidDeepLink(link) {
    if (!link)
        return true;
    try {
        const url = new URL(link);
        return ['http:', 'https:', 'spotify:', 'music:', 'unreleasd:'].includes(url.protocol);
    }
    catch {
        return false;
    }
}
function truncateString(str, maxLength) {
    if (!str)
        return undefined;
    return str.length > maxLength ? str.substring(0, maxLength - 3) + '...' : str;
}
const DEBUG_ENABLED = process.env.UNRL_PRESENCE_DEBUG === '1';
let lastDebugLog = 0;
const DEBUG_DEBOUNCE_MS = 5000;
function normalizePayload(input) {
    // Accept both camelCase and snake_case, normalize to snake_case for main
    const artist_name = input.artist_name || input.artistName;
    const artist_id = input.artist_id || input.artistId;
    const track_title = input.track_title || input.trackTitle;
    const album_name = input.album_name || input.albumName;
    const album_type = input.album_type || input.albumType;
    const album_tracks_count = input.album_tracks_count !== undefined ? input.album_tracks_count : input.albumTracksCount;
    const is_single = input.is_single !== undefined ? input.is_single : input.isSingle;
    const track_image_url = input.track_image_url || input.trackImageUrl;
    const position_ms = input.position_ms !== undefined ? input.position_ms : input.positionMs;
    const duration_ms = input.duration_ms !== undefined ? input.duration_ms : input.durationMs;
    const is_playing = input.is_playing !== undefined ? input.is_playing : input.isPlaying;
    const seek_seq = input.seek_seq !== undefined ? input.seek_seq : input.seekSeq;
    const track_id = input.track_id || input.trackId;
    const deep_link = input.deep_link || input.deepLink;
    const trace_id = input.trace_id || input.traceId;
    // CRITICAL: Prioritize explicit context over inference
    // If input.context is explicitly set, use it (including 'artist' and 'track')
    // This prevents losing context when caller explicitly provides it
    let finalContext;
    if (input.context) {
        // Explicit context takes absolute priority - trust the caller
        finalContext = input.context;
    }
    else {
        // Infer context only when not explicitly provided
        // Only treat as 'track' if we have track_title or position_ms (strong track signals)
        const hasTrackInfo = track_title || position_ms !== undefined;
        finalContext = hasTrackInfo && is_playing !== false ? 'track' : 'browsing';
    }
    // Debounced debug logging when UNRL_PRESENCE_DEBUG=1
    const now = Date.now();
    if (DEBUG_ENABLED && (now - lastDebugLog) >= DEBUG_DEBOUNCE_MS) {
        console.log('[RP:Preload] Normalized →', {
            trace: trace_id ? trace_id.substring(0, 8) : '(none)',
            title: track_title ? `"${track_title.substring(0, 30)}"` : '(none)',
            artist: artist_name ? `"${artist_name.substring(0, 30)}"` : '(none)',
            pos: position_ms !== undefined ? `${Math.floor(position_ms / 1000)}s` : '(none)',
            dur: duration_ms !== undefined ? `${Math.floor(duration_ms / 1000)}s` : '(none)',
            playing: is_playing !== undefined ? is_playing : '(none)',
            ctx: finalContext,
            explicitCtx: input.context ? 'YES' : 'NO'
        });
        lastDebugLog = now;
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
        deep_link,
        timestamp: input.timestamp,
        position_ms,
        duration_ms,
        is_playing,
        seek_seq,
        track_id,
        trace_id,
    };
}
const unrlPresenceAPI = {
    update: (payload) => {
        console.log('[RP:Preload] ========== UPDATE CALLED ==========');
        console.log('[RP:Preload] Payload received:', payload);
        try {
            const currentOrigin = window.location.origin;
            console.log('[RP:Preload] Current origin:', currentOrigin);
            console.log('[RP:Preload] Allowed origin:', ALLOWED_ORIGIN);
            if (currentOrigin !== ALLOWED_ORIGIN) {
                console.warn('[Presence] Blocked: Origin not allowed:', currentOrigin);
                return;
            }
            if (!payload || typeof payload !== 'object') {
                console.warn('[Presence] Invalid payload: not an object');
                return;
            }
            const data = payload;
            if (data.context && !['browsing', 'artist', 'track', 'profile'].includes(data.context)) {
                console.warn('[Presence] Invalid context:', data.context);
                return;
            }
            const deepLink = data.deep_link || data.deepLink;
            if (deepLink && !isValidDeepLink(deepLink)) {
                console.warn('[Presence] Invalid deep link:', deepLink);
                return;
            }
            const normalized = normalizePayload(data);
            console.log('[RP:Preload] Normalized payload:', normalized);
            // Validate track_image_url if present: must be HTTPS and ≤300 chars
            let validatedImageUrl = normalized.track_image_url;
            if (validatedImageUrl) {
                if (typeof validatedImageUrl === 'string' && validatedImageUrl.length <= 300 && validatedImageUrl.startsWith('https://')) {
                    // Valid HTTPS URL
                }
                else {
                    validatedImageUrl = undefined;
                }
            }
            // Forward all snake_case fields to main, truncate strings ≤128, validate URLs
            const sanitized = {
                context: normalized.context,
                artist_name: truncateString(normalized.artist_name, 128),
                artist_id: normalized.artist_id,
                track_title: truncateString(normalized.track_title, 128),
                album_name: truncateString(normalized.album_name, 128),
                album_type: truncateString(normalized.album_type, 128),
                album_tracks_count: typeof normalized.album_tracks_count === 'number' ? normalized.album_tracks_count : undefined,
                is_single: typeof normalized.is_single === 'boolean' ? normalized.is_single : undefined,
                track_image_url: validatedImageUrl,
                deep_link: normalized.deep_link,
                timestamp: typeof normalized.timestamp === 'number' ? normalized.timestamp : undefined,
                position_ms: typeof normalized.position_ms === 'number' ? normalized.position_ms : undefined,
                duration_ms: typeof normalized.duration_ms === 'number' ? normalized.duration_ms : undefined,
                is_playing: typeof normalized.is_playing === 'boolean' ? normalized.is_playing : undefined,
                seek_seq: typeof normalized.seek_seq === 'number' ? normalized.seek_seq : undefined,
                track_id: truncateString(normalized.track_id, 128),
                trace_id: normalized.trace_id,
            };
            console.log('[RP:Preload] Sending to main process:', sanitized);
            electron_1.ipcRenderer.send('presence:update', sanitized);
            console.log('[RP:Preload] Successfully sent to IPC');
        }
        catch (error) {
            console.error('[Presence] Error sending update:', error);
        }
    },
    clear: () => {
        try {
            const currentOrigin = window.location.origin;
            if (currentOrigin !== ALLOWED_ORIGIN) {
                console.warn('[Presence] Blocked: Origin not allowed:', currentOrigin);
                return;
            }
            electron_1.ipcRenderer.send('presence:clear');
        }
        catch (error) {
            console.error('[Presence] Error clearing presence:', error);
        }
    },
    ping: async () => {
        try {
            const result = await electron_1.ipcRenderer.invoke('presence:ping');
            return result;
        }
        catch (error) {
            console.error('[Presence] Error pinging:', error);
            return { origin: '', hasDiscord: false };
        }
    }
};
electron_1.contextBridge.exposeInMainWorld('unrlPresence', unrlPresenceAPI);
console.log('[RP:Preload] ✅ Electron bridge exposed to window.unrlPresence');
console.log('[RP:Preload] Allowed origin:', ALLOWED_ORIGIN);
console.log('[RP:Preload] Bridge API methods:', Object.keys(unrlPresenceAPI));
//# sourceMappingURL=preload.js.map