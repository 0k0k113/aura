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
  /** Requests filed with the Discord client that have not been answered.
   * Should sit at 0-1; a number that climbs with uptime is a leak. */
  pendingRequests: number
}

export class DiscordRPC {
  private client: Client
  private connected = false
  private reconnectTimeout: NodeJS.Timeout | null = null
  private lastActivity: SetActivity | null = null
  /** Nothing has been shown yet, so the first clear has nothing to undo. */
  private activityCleared = true
  private updateThrottle: NodeJS.Timeout | null = null
  private lastUpdateTime = 0
  private readonly THROTTLE_MS = 1000
  private readonly RECONNECT_DELAY = 5000
  /** We only ever send SetActivity, at most once a second. More than this many
   * unanswered means replies are not coming back, not that we are busy. */
  private static readonly MAX_PENDING_REQUESTS = 32

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
      this.releasePendingRequests()
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
      // The library's `connect()` registers `this.once('connected', ...)` and
      // only removes it on success. Every failed attempt therefore leaves one
      // behind, permanently, on a client we reuse forever — and this fires
      // every few seconds for as long as Discord is unreachable, which is the
      // normal state for someone playing music without Discord open. It trips
      // the emitter's own leak warning ("Possible AsyncEventEmitter memory
      // leak detected") inside about two minutes, and when Discord finally
      // does start, all of the accumulated listeners fire at once — each one
      // registering another transport close handler, so the next disconnect
      // is amplified by however long the outage lasted.
      this.client.removeAllListeners('connected')
      this.login().catch(err => {
        console.warn('[RPC] Reconnect failed:', err?.message || err)
      })
    }, this.RECONNECT_DELAY)
  }

  /**
   * Drop the client's record of requests Discord will never answer.
   *
   * `Client.request()` files every call in a `nonceMap` keyed by a random
   * UUID, and the ONLY thing that removes an entry is a reply carrying the
   * same nonce. On transport close the library rejects each pending entry —
   * and then leaves it in the map. Nothing ever deletes it.
   *
   * Every leftover holds a resolve/reject pair and an RPCError with a captured
   * stack trace, and the map survives reconnects, so a long session that
   * bounces Discord (a restart, a sleep/wake) accumulates them for as long as
   * the app runs.
   *
   * This comment used to claim the leak was why "the whole machine feels
   * slower". It is not — the app only ever has 0-1 requests outstanding, so
   * this leaks one or two entries per Discord disconnect, well under a
   * kilobyte across a long session. Worth fixing as a correctness bug; never
   * worth believing in as a performance cause. The actual cause was the
   * renderer being kept awake by `backgroundThrottling: false` (see main.ts).
   *
   * Called after the library has already settled those promises, so removing
   * the entries discards nothing a caller is still waiting on.
   */
  private releasePendingRequests(): void {
    const map = this.pendingRequestMap()
    if (!map || map.size === 0) return
    const dropped = map.size
    map.clear()
    console.warn(`[RPC] Released ${dropped} pending request(s) after disconnect`)
  }

  /**
   * The same map, pruned while CONNECTED.
   *
   * A request Discord simply never answers has no timeout and no close event
   * to clean it up, so it would sit there for the life of the process. We only
   * ever send SetActivity, at most once a second, so anything beyond a handful
   * outstanding means replies are not coming back. Rejecting them settles the
   * promises — which is what actually releases the closures — and the catch in
   * `dispatch` records the drop.
   */
  private prunePendingRequests(): void {
    const map = this.pendingRequestMap()
    if (!map || map.size <= DiscordRPC.MAX_PENDING_REQUESTS) return

    for (const [nonce, pending] of Array.from(map.entries())) {
      map.delete(nonce)
      try {
        pending?.reject?.(pending.error ?? new Error('Discord never answered this request'))
      } catch {
        /* the caller's own handler threw; the entry is gone either way */
      }
    }
  }

  /** `nonceMap` is `private` in the typings but a plain instance property at
   * runtime. Reached defensively so a library change degrades to a no-op. */
  private pendingRequestMap():
    | Map<string, { reject?: (reason?: unknown) => void; error?: Error }>
    | null {
    try {
      const map = (this.client as unknown as { nonceMap?: unknown }).nonceMap
      return map instanceof Map ? map : null
    } catch {
      return null
    }
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
    // Cheap, and this is the one place that runs on every activity.
    this.prunePendingRequests()
    const user = this.client.user

    if (!user) {
      this.activitiesDropped++
      this.lastError =
        'Discord connected but never identified the user, so activities cannot be set. ' +
        'Restart Discord, then restart aura.'
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
    this.activityCleared = false

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

  /**
   * Take the card down.
   *
   * Two things make this more than a passthrough:
   *
   *   • A pending THROTTLED set must be cancelled. setActivity defers an update
   *     that arrives inside the throttle window, so pausing within a second of
   *     the last update would clear the card and then let the deferred timer
   *     re-post it — the card blinking back after a pause.
   *
   *   • Repeat clears are dropped. Browsing emits a payload per navigation and
   *     none of them show anything now, so without this every click would spend
   *     one of Discord's rate-limited RPC calls saying "still nothing".
   */
  clearActivity(): void {
    this.lastActivity = null

    if (this.updateThrottle) {
      clearTimeout(this.updateThrottle)
      this.updateThrottle = null
    }

    if (this.activityCleared) return
    this.activityCleared = true

    if (!this.connected) {
      // Discord drops a disconnected client's activity on its own, and the
      // `ready` handler replays only a non-null lastActivity — so there is
      // nothing left to take down.
      return
    }

    this.client.user?.clearActivity().catch((error: any) => {
      console.warn('[RPC] Failed to clear activity:', error?.message || error)
    })
  }

  /** True when Discord is currently showing nothing for us. */
  isCleared(): boolean {
    return this.activityCleared
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
      pendingRequests: this.pendingRequestMap()?.size ?? 0,
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
