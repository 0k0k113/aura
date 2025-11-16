import type { SetActivity } from '@xhayper/discord-rpc';
export declare class DiscordRPC {
    private client;
    private connected;
    private reconnectTimeout;
    private lastActivity;
    private updateThrottle;
    private lastUpdateTime;
    private readonly THROTTLE_MS;
    private readonly RECONNECT_DELAY;
    constructor(clientId: string);
    login(): Promise<void>;
    private scheduleReconnect;
    setActivity(presence: SetActivity, bypassThrottle?: boolean): void;
    clearActivity(): void;
    isConnected(): boolean;
    isReady(): boolean;
    destroy(): void;
}
//# sourceMappingURL=rpc.d.ts.map