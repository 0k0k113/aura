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
    this.client = new Client({ clientId })

    this.client.on('ready', () => {
      console.log('[RPC] Connected to Discord')
      this.connected = true
      if (this.lastActivity) {
        this.setActivity(this.lastActivity)
      }
    })

    this.client.on('disconnected', () => {
      console.log('[RPC] Disconnected from Discord')
      this.connected = false
      this.scheduleReconnect()
    })
  }

  async login(): Promise<void> {
    try {
      await this.client.login()
      this.connected = true
    } catch (error) {
      console.warn('[RPC] Failed to connect:', error)
      this.scheduleReconnect()
      throw error
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      console.log('[RPC] Attempting to reconnect...')
      this.login().catch(err => {
        console.warn('[RPC] Reconnect failed:', err)
      })
    }, this.RECONNECT_DELAY)
  }

  setActivity(presence: SetActivity, bypassThrottle: boolean = false): void {
    this.lastActivity = presence

    if (!this.connected) {
      console.warn('[RPC] Not connected, activity will be set when connected')
      return
    }

    const now = Date.now()
    const timeSinceLastUpdate = now - this.lastUpdateTime

    if (bypassThrottle) {
      console.log('[RPC] Bypassing throttle for immediate update')
      if (this.updateThrottle) {
        clearTimeout(this.updateThrottle)
        this.updateThrottle = null
      }
      this.lastUpdateTime = now

      this.client.user?.setActivity(presence).catch(error => {
        console.warn('[RPC] Failed to set activity:', error)
        if (error.message?.includes('connection')) {
          this.connected = false
          this.scheduleReconnect()
        }
      })
      return
    }

    if (timeSinceLastUpdate < this.THROTTLE_MS) {
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

    this.client.user?.setActivity(presence).catch(error => {
      console.warn('[RPC] Failed to set activity:', error)
      if (error.message?.includes('connection')) {
        this.connected = false
        this.scheduleReconnect()
      }
    })
  }

  clearActivity(): void {
    this.lastActivity = null

    if (!this.connected) {
      return
    }

    this.client.user?.clearActivity().catch(error => {
      console.warn('[RPC] Failed to clear activity:', error)
    })
  }

  isConnected(): boolean {
    return this.connected
  }

  isReady(): boolean {
    return this.connected
  }

  destroy(): void {
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
        console.warn('[RPC] Error destroying client:', error)
      })
    }

    this.connected = false
  }
}
