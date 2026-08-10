import { Client } from '@xhayper/discord-rpc'
import type { SetActivity } from '@xhayper/discord-rpc'

/** Snapshot of the RPC link, surfaced in the tray and over `presence:ping`. */
export interface RpcStatus {
  /** Transport is connected to the local Discord client. */
  connected: boolean
  /** Discord told us who the user is — required before an activity can be set. */
  hasUser: boolean
  /** Activities successfully handed to Discord. */
  activitiesSent: number
  /** Activities dropped, with the reason. */
  activitiesDropped: number
  lastActivityAt: number | null
  lastError: string | null
  clientIdPresent: boolean
}

export class DiscordRPC {
  private client: Client
  private connected = false
  private reconnectTimeout: NodeJS.Timeout | null = null
  private lastActivity: SetActivity | null = null
  private updateThrottle: NodeJS.Timeout | null = null
  private lastUpdateTime = 0
  private readonly THROTTLE_MS = 1000
  private readonly RECONNECT_DELAY = 5000

  // Diagnostics. Presence failing used to be completely invisible: the only
  // signal was a console.log nobody could see, in a window with no devtools.
  private activitiesSent = 0
  private activitiesDropped = 0
  private lastActivityAt: number | null = null
  private lastError: string | null = null
  private readonly clientIdPresent: boolean

  constructor(clientId: string) {
    this.clientIdPresent = Boolean(clientId)
    this.client = new Client({ clientId })

    this.client.on('ready', () => {
      console.log('[RPC] Connected to Discord')
      this.connected = true
      this.lastError = null
      if (this.lastActivity) {
        this.setActivity(this.lastActivity, true)
      }
    })

    this.client.on('disconnected', () => {
      console.warn('[RPC] Disconnected from Discord — will retry')
      this.connected = false
      this.scheduleReconnect()
    })
  }

  async login(): Promise<void> {
    try {
      await this.client.login()
      this.connected = true
      console.log(
        `[RPC] Logged in. Discord user available: ${this.client.user ? 'yes' : 'NO'}`,
      )
    } catch (error: any) {
      this.lastError = error?.message || String(error)
      console.warn('[RPC] Failed to connect:', this.lastError)
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
        console.warn('[RPC] Reconnect failed:', err?.message || err)
      })
    }, this.RECONNECT_DELAY)
  }

  /**
   * Hand an activity to Discord.
   *
   * `client.user` is populated from Discord's READY payload and is what
   * actually carries `setActivity`. The previous code wrote
   * `this.client.user?.setActivity(...)`, so whenever Discord had not supplied
   * a user the call became a silent no-op — presence would appear completely
   * dead with nothing logged anywhere. Missing state is now reported instead
   * of swallowed.
   */
  private dispatch(presence: SetActivity): void {
    const user = this.client.user

    if (!user) {
      this.activitiesDropped++
      this.lastError =
        'Discord connected but never identified the user, so activities cannot be set. ' +
        'Restart Discord, then restart Unreleased Presence.'
      console.error(`[RPC] ${this.lastError}`)
      // Reconnecting is the only thing that can recover this.
      this.connected = false
      this.scheduleReconnect()
      return
    }

    this.lastUpdateTime = Date.now()

    user
      .setActivity(presence)
      .then(() => {
        this.activitiesSent++
        this.lastActivityAt = Date.now()
        this.lastError = null
      })
      .catch((error: any) => {
        this.activitiesDropped++
        this.lastError = error?.message || String(error)
        console.warn('[RPC] Failed to set activity:', this.lastError)
        if (/connection|closed|ended/i.test(this.lastError ?? '')) {
          this.connected = false
          this.scheduleReconnect()
        }
      })
  }

  setActivity(presence: SetActivity, bypassThrottle: boolean = false): void {
    this.lastActivity = presence

    if (!this.connected) {
      // Not an error: it is replayed from the `ready` handler once connected.
      this.activitiesDropped++
      return
    }

    const now = Date.now()
    const timeSinceLastUpdate = now - this.lastUpdateTime

    if (bypassThrottle) {
      if (this.updateThrottle) {
        clearTimeout(this.updateThrottle)
        this.updateThrottle = null
      }
      this.dispatch(presence)
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

    this.dispatch(presence)
  }

  clearActivity(): void {
    this.lastActivity = null

    if (!this.connected) {
      return
    }

    this.client.user?.clearActivity().catch((error: any) => {
      console.warn('[RPC] Failed to clear activity:', error?.message || error)
    })
  }

  isConnected(): boolean {
    return this.connected
  }

  isReady(): boolean {
    return this.connected && Boolean(this.client.user)
  }

  getStatus(): RpcStatus {
    return {
      connected: this.connected,
      hasUser: Boolean(this.client.user),
      activitiesSent: this.activitiesSent,
      activitiesDropped: this.activitiesDropped,
      lastActivityAt: this.lastActivityAt,
      lastError: this.lastError,
      clientIdPresent: this.clientIdPresent,
    }
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
      this.client.destroy().catch((error: any) => {
        console.warn('[RPC] Error destroying client:', error?.message || error)
      })
    }

    this.connected = false
  }
}
