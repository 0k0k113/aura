"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiscordRPC = void 0;
const discord_rpc_1 = require("@xhayper/discord-rpc");
class DiscordRPC {
    client;
    connected = false;
    reconnectTimeout = null;
    lastActivity = null;
    updateThrottle = null;
    lastUpdateTime = 0;
    THROTTLE_MS = 1000;
    RECONNECT_DELAY = 5000;
    constructor(clientId) {
        this.client = new discord_rpc_1.Client({ clientId });
        this.client.on('ready', () => {
            console.log('[RPC] Connected to Discord');
            this.connected = true;
            if (this.lastActivity) {
                this.setActivity(this.lastActivity);
            }
        });
        this.client.on('disconnected', () => {
            console.log('[RPC] Disconnected from Discord');
            this.connected = false;
            this.scheduleReconnect();
        });
    }
    async login() {
        try {
            await this.client.login();
            this.connected = true;
        }
        catch (error) {
            console.warn('[RPC] Failed to connect:', error);
            this.scheduleReconnect();
            throw error;
        }
    }
    scheduleReconnect() {
        if (this.reconnectTimeout) {
            return;
        }
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            console.log('[RPC] Attempting to reconnect...');
            this.login().catch(err => {
                console.warn('[RPC] Reconnect failed:', err);
            });
        }, this.RECONNECT_DELAY);
    }
    setActivity(presence, bypassThrottle = false) {
        this.lastActivity = presence;
        if (!this.connected) {
            console.warn('[RPC] Not connected, activity will be set when connected');
            return;
        }
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastUpdateTime;
        if (bypassThrottle) {
            console.log('[RPC] Bypassing throttle for immediate update');
            if (this.updateThrottle) {
                clearTimeout(this.updateThrottle);
                this.updateThrottle = null;
            }
            this.lastUpdateTime = now;
            this.client.user?.setActivity(presence).catch(error => {
                console.warn('[RPC] Failed to set activity:', error);
                if (error.message?.includes('connection')) {
                    this.connected = false;
                    this.scheduleReconnect();
                }
            });
            return;
        }
        if (timeSinceLastUpdate < this.THROTTLE_MS) {
            if (this.updateThrottle) {
                clearTimeout(this.updateThrottle);
            }
            this.updateThrottle = setTimeout(() => {
                this.updateThrottle = null;
                this.setActivity(presence);
            }, this.THROTTLE_MS - timeSinceLastUpdate);
            return;
        }
        if (this.updateThrottle) {
            clearTimeout(this.updateThrottle);
            this.updateThrottle = null;
        }
        this.lastUpdateTime = now;
        this.client.user?.setActivity(presence).catch(error => {
            console.warn('[RPC] Failed to set activity:', error);
            if (error.message?.includes('connection')) {
                this.connected = false;
                this.scheduleReconnect();
            }
        });
    }
    clearActivity() {
        this.lastActivity = null;
        if (!this.connected) {
            return;
        }
        this.client.user?.clearActivity().catch(error => {
            console.warn('[RPC] Failed to clear activity:', error);
        });
    }
    isConnected() {
        return this.connected;
    }
    isReady() {
        return this.connected;
    }
    destroy() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.updateThrottle) {
            clearTimeout(this.updateThrottle);
            this.updateThrottle = null;
        }
        this.clearActivity();
        if (this.connected) {
            this.client.destroy().catch(error => {
                console.warn('[RPC] Error destroying client:', error);
            });
        }
        this.connected = false;
    }
}
exports.DiscordRPC = DiscordRPC;
//# sourceMappingURL=rpc.js.map