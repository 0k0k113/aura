import { Client } from '@xhayper/discord-rpc'
import type { SetActivity } from '@xhayper/discord-rpc'

export class DiscordRPC {
  private client: Client
  private connected = false
  private reconnectTimeout: NodeJS.Timeout | null = null
  private lastActivity: SetActivity | null = null
  private updateThrottle: NodeJS.Timeout | null = null
  private lastUpdateTime = 0
  private readonly THROTTLE_MS = 1000
  private readonly RECONNECT_DELAY = 5000

  constructor(clientId: string) {
    console.log('[RP:Discord] Creating Discord RPC client with clientId:', clientId.substring(0, 8) + '...')
    this.client = new Client({ clientId })

    this.client.on('ready', () => {
      console.log('[RP:Discord] ✅ Connected to Discord successfully')
      console.log('[RP:Discord] User:', this.client.user?.username || 'unknown')
      this.connected = true
      if (this.lastActivity) {
        console.log('[RP:Discord] Replaying cached activity after connection')
        this.setActivity(this.lastActivity)
      }
    })

    this.client.on('disconnected', () => {
      console.log('[RP:Discord] ❌ Disconnected from Discord')
      this.connected = false
      this.scheduleReconnect()
    })
  }

  async login(): Promise<void> {
    console.log('[RP:Discord] Attempting to connect to Discord...')
    try {
      await this.client.login()
      console.log('[RP:Discord] ✅ Login successful')
      this.connected = true
    } catch (error) {
      console.error('[RP:Discord] ❌ Failed to connect:', error)
      this.scheduleReconnect()
      throw error
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return
    }

    console.log(`[RP:Discord] Scheduling reconnect in ${this.RECONNECT_DELAY}ms`)
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      console.log('[RP:Discord] Attempting to reconnect...')
      this.login().catch(err => {
        console.warn('[RP:Discord] Reconnect failed:', err)
      })
    }, this.RECONNECT_DELAY)
  }

  setActivity(presence: SetActivity, bypassThrottle: boolean = false): void {
    this.lastActivity = presence

    if (!this.connected) {
      console.warn('[RP:Discord] Not connected - activity cached for when connected')
      return
    }

    const now = Date.now()
    const timeSinceLastUpdate = now - this.lastUpdateTime

    if (bypassThrottle) {
      console.log('[RP:Discord] Bypassing throttle for immediate update')
      if (this.updateThrottle) {
        clearTimeout(this.updateThrottle)
        this.updateThrottle = null
      }
      this.lastUpdateTime = now

      console.log('[RP:Discord] setActivity:', {
        details: presence.details,
        state: presence.state,
        largeImageKey: presence.largeImageKey,
        largeImageText: presence.largeImageText,
        startTimestamp: (presence as any).startTimestamp,
        endTimestamp: (presence as any).endTimestamp
      })

      this.client.user?.setActivity(presence).then(() => {
        console.log('[RP:Discord] ✅ Activity set successfully')
      }).catch(error => {
        console.error('[RP:Discord] ❌ Failed to set activity:', error)
        if (error.message?.includes('connection')) {
          this.connected = false
          this.scheduleReconnect()
        }
      })
      return
    }

    if (timeSinceLastUpdate < this.THROTTLE_MS) {
      console.log(`[RP:Discord] Throttling activity update (${timeSinceLastUpdate}ms since last update)`)
      if (this.updateThrottle) {
        clearTimeout(this.updateThrottle)
      }

      this.updateThrottle = setTimeout(() => {
        this.updateThrottle = null
        this.setActivity(presence)
      }, this.THROTTLE_MS - timeSinceLastUpdate)

      return
    }

    if (this.updateThrottle) {
      clearTimeout(this.updateThrottle)
      this.updateThrottle = null
    }

    this.lastUpdateTime = now

    console.log('[RP:Discord] setActivity:', {
      details: presence.details,
      state: presence.state,
      largeImageKey: presence.largeImageKey,
      largeImageText: presence.largeImageText,
      startTimestamp: (presence as any).startTimestamp,
      endTimestamp: (presence as any).endTimestamp
    })

    this.client.user?.setActivity(presence).then(() => {
      console.log('[RP:Discord] ✅ Activity set successfully')
    }).catch(error => {
      console.error('[RP:Discord] ❌ Failed to set activity:', error)
      if (error.message?.includes('connection')) {
        this.connected = false
        this.scheduleReconnect()
      }
    })
  }

  clearActivity(): void {
    console.log('[RP:Discord] clearActivity called')
    this.lastActivity = null

    if (!this.connected) {
      console.warn('[RP:Discord] Not connected, cannot clear activity')
      return
    }

    console.log('[RP:Discord] Clearing Discord activity')
    this.client.user?.clearActivity().then(() => {
      console.log('[RP:Discord] ✅ Activity cleared successfully')
    }).catch(error => {
      console.error('[RP:Discord] ❌ Failed to clear activity:', error)
    })
  }

  isConnected(): boolean {
    return this.connected
  }

  isReady(): boolean {
    return this.connected
  }

  destroy(): void {
    console.log('[RP:Discord] Destroying Discord RPC client')
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    if (this.updateThrottle) {
      clearTimeout(this.updateThrottle)
      this.updateThrottle = null
    }

    this.clearActivity()

    if (this.connected) {
      this.client.destroy().catch(error => {
        console.warn('[RP:Discord] Error destroying client:', error)
      })
    }

    this.connected = false
    console.log('[RP:Discord] Client destroyed')
  }
}
