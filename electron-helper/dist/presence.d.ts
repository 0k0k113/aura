import type { SetActivity } from '@xhayper/discord-rpc';
interface PresencePayload {
    context?: 'browsing' | 'artist' | 'track' | 'profile';
    artist_name?: string;
    artist_id?: string;
    track_title?: string;
    album_name?: string;
    album_type?: string;
    album_tracks_count?: number;
    is_single?: boolean;
    track_image_url?: string;
    deep_link?: string;
    timestamp?: number;
    position_ms?: number;
    duration_ms?: number;
    is_playing?: boolean;
    seek_seq?: number;
    track_id?: string;
    trace_id?: string;
}
export declare function createPresenceActivity(currentUrl: string, payload?: PresencePayload): SetActivity | null;
export {};
//# sourceMappingURL=presence.d.ts.map