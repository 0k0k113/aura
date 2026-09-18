import { Client } from '@xhayper/discord-rpc'
import type { SetActivity } from '@xhayper/discord-rpc'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Which build of Discord a connection landed on.
 *
 * Every Discord build listens on the same numbered socket family
 * (`discord-ipc-0` … `discord-ipc-9`) and claims the lowest one that is free,
 * so the socket number says nothing about which build answered it — whichever
 * launched first is simply on 0. The build only becomes knowable once it
 * replies: the READY frame carries a config block naming the API host it talks
 * to, and canary and PTB each have their own.
 */
export type DiscordFlavor = 'stable' | 'ptb' | 'canary' | 'unknown'

export const FLAVOR_LABELS: Record<DiscordFlavor, string> = {
  stable: 'Discord',
  ptb: 'Discord PTB',
  canary: 'Discord Canary',
  unknown: 'Discord',
}

/** Read the build out of a READY frame's `config`, defensively. */
export function detectFlavor(config: unknown): DiscordFlavor {
  const c = (config ?? {}) as { api_endpoint?: unknown; environment?: unknown }
  const endpoint = typeof c.api_endpoint === 'string' ? c.api_endpoint.toLowerCase() : ''
  const environment = typeof c.environment === 'string' ? c.environment.toLowerCase() : ''
  const haystack = `${endpoint} ${environment}`
  // Order matters: every endpoint contains "discord.com", so the qualified
  // hosts have to be ruled out before falling through to stable.
  if (haystack.includes('canary')) return 'canary'
  if (haystack.includes('ptb')) return 'ptb'
  if (endpoint.includes('discord.com') || environment.includes('production')) return 'stable'
  return 'unknown'
}

function tempDir(): string {
  const { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } = process.env
  const candidate = XDG_RUNTIME_DIR ?? TMPDIR ?? TMP ?? TEMP ?? `${path.sep}tmp`
  try {
    return fs.realpathSync(candidate)
  } catch {
    return candidate
  }
}

/**
 * A path list pinned to one socket number.
 *
 * The library does take a `pipeId`, but it tests it with `if (pipeId)` — so
 * pipe **0**, the one the first-launched Discord almost always owns, is falsy
 * and silently turns back into "scan 0 through 9 and take the first that
 * answers". Pinning the number inside `format()` instead makes every candidate
 * path this socket regardless of how the id is tested, which is what lets one
 * connection per Discord build exist at the same time.
 */
function pathListForPipe(id: number) {
  return [
    { platform: ['win32'] as NodeJS.Platform[], format: () => `\\\\?\\pipe\\discord-ipc-${id}` },
    { platform: ['darwin', 'linux'] as NodeJS.Platform[], format: () => path.join(tempDir(), `discord-ipc-${id}`) },
    { platform: ['linux'] as NodeJS.Platform[], format: () => path.join(tempDir(), 'snap.discord', `discord-ipc-${id}`) },
    {
      platform: ['linux'] as NodeJS.Platform[],
      format: () => path.join(tempDir(), 'app', 'com.discordapp.Discord', `discord-ipc-${id}`),
    },
  ]
}

export interface DiscordRPCOptions {
  /** Pin this connection to one Discord socket. Omitted: let the library scan. */
  pipeId?: number
  /**
   * Reconnect on its own after a drop. The pool sets this false and rediscovers
   * instead, so that a Discord which has actually quit stops being retried
   * forever and one which reappears is picked up by the same scan that finds a
   * newly launched one.
   */
  autoReconnect?: boolean
  /** Called once the build behind this socket is known. */
  onFlavor?: (flavor: DiscordFlavor) => void
  /** Called when the connection drops and will not retry itself. */
  onDropped?: () => void
}

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
  readonly pipeId: number | undefined
  private readonly autoReconnect: boolean
  private readonly onDropped?: () => void
  private flavor: DiscordFlavor = 'unknown'

  constructor(clientId: string, options: DiscordRPCOptions = {}) {
    this.clientIdPresent = Boolean(clientId)
    this.pipeId = options.pipeId
    this.autoReconnect = options.autoReconnect !== false
    this.onDropped = options.onDropped

    this.client =
      options.pipeId === undefined
        ? new Client({ clientId })
        : new Client({
            clientId,
            pipeId: options.pipeId,
            // See pathListForPipe: the id is baked into every candidate path
            // because the library's own `pipeId` test drops pipe 0.
            transport: { pathList: pathListForPipe(options.pipeId) },
          })

    // The build behind this socket is only knowable from the READY frame, and
    // the library keeps that frame to itself — it lifts `user` and `cdn_host`
    // out and emits `connected` with nothing attached. Reading the transport
    // directly is the only way to see `config`. Additive: the library's own
    // listener is registered in its constructor and still runs.
    try {
      const transport = (this.client as unknown as { transport?: { on?: Function } }).transport
      if (transport && typeof transport.on === 'function') {
        transport.on('message', (message: any) => {
          if (message?.cmd === 'DISPATCH' && message?.evt === 'READY') {
            this.flavor = detectFlavor(message?.data?.config)
            options.onFlavor?.(this.flavor)
          }
        })
      }
    } catch {
      // A library change that moves or renames `transport` costs us the label
      // and nothing else; the connection still works and reports 'unknown'.
    }

    this.client.on('ready', () => {
      console.log(`[RPC] Connected to ${this.describe()}`)
      this.connected = true
      this.lastError = null
      if (this.lastActivity) {
        this.setActivity(this.lastActivity, true)
      }
    })

    this.client.on('disconnected', () => {
      this.connected = false
      this.releasePendingRequests()
      if (this.autoReconnect) {
        console.warn(`[RPC] Disconnected from ${this.describe()} — will retry`)
        this.scheduleReconnect()
      } else {
        // Pooled: the owner drops this connection and its next scan re-adds
        // the Discord if it is still there. One rediscovery path, not two.
        console.warn(`[RPC] Disconnected from ${this.describe()} — releasing`)
        this.onDropped?.()
      }
    })
  }

  /** Human-readable identity for logs: "Discord Canary (pipe 1)". */
  describe(): string {
    const label = FLAVOR_LABELS[this.flavor]
    return this.pipeId === undefined ? label : `${label} (pipe ${this.pipeId})`
  }

  getFlavor(): DiscordFlavor {
    return this.flavor
  }

  /** The Discord account this connection is signed in as, once known. */
  getUsername(): string | null {
    const user = this.client.user as unknown as { username?: string } | undefined
    return typeof user?.username === 'string' ? user.username : null
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
    // Single choke point for every path that wants to retry — the disconnect
    // handler, a failed login, and the two error branches in dispatch(). A
    // pooled connection never retries on its own; it tells its owner to let it
    // go, so a Discord that has quit stops being polled forever and one that
    // comes back is found by the same scan that finds a newly launched build.
    if (!this.autoReconnect) {
      this.onDropped?.()
      return
    }

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
