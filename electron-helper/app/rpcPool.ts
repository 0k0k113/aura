// ============================================================================
// One Rich Presence connection per running Discord build.
//
// Why this exists
// ---------------
// Discord's RPC is a local socket: `discord-ipc-0` … `discord-ipc-9`. Every
// build — stable, PTB, Canary — claims the lowest number that is free, so with
// stable and Canary both running one sits on 0 and the other on 1. The library
// we use scans that range and connects to the FIRST socket that answers, which
// means presence has always landed on exactly one arbitrary build: whichever
// happened to launch first. Close that one and the card disappears even though
// Discord is still on screen.
//
// Spotify looks like it does better, but it is not doing this at all. Spotify
// never speaks RPC. Discord detects Spotify itself, inside each client, as a
// first-party integration — so every running build lights up independently and
// nothing is being "sent to all of them". That path is not open to us, or to
// any third-party app, at any price. What IS open is holding one RPC
// connection per socket, which is what this does, and the visible result is
// the same: the card shows up on every Discord the listener has open.
//
// Discovery, not configuration
// ----------------------------
// Nothing about a socket says which build owns it, so the pool connects first
// and asks after: the READY frame names the API host, and Canary and PTB each
// have their own (see detectFlavor in rpc.ts). Sockets are rescanned on an
// interval so a Discord started after the app is picked up, and a connection
// that drops is released and rediscovered by that same scan rather than
// retried forever by itself.
// ============================================================================

import type { SetActivity } from '@xhayper/discord-rpc'
import { DiscordRPC, FLAVOR_LABELS, type DiscordFlavor, type RpcStatus } from './rpc'

/** What the settings UI renders one row from. */
export interface DiscordClientInfo {
  pipeId: number
  flavor: DiscordFlavor
  /** "Discord Canary" */
  label: string
  connected: boolean
  /** Discord has identified the account, so activities can actually be set. */
  ready: boolean
  username: string | null
  /** Whether the listener wants presence on this build. */
  enabled: boolean
}

export type FlavorPrefs = Partial<Record<DiscordFlavor, boolean>>

/** Every build is on unless the listener turns it off. */
export const DEFAULT_FLAVOR_PREFS: Record<DiscordFlavor, boolean> = {
  stable: true,
  ptb: true,
  canary: true,
  unknown: true,
}

export class DiscordRpcPool {
  private readonly clientId: string
  private readonly connections = new Map<number, DiscordRPC>()
  private prefs: Record<DiscordFlavor, boolean>
  private lastActivity: SetActivity | null = null
  private activityCleared = true
  private scanTimer: NodeJS.Timeout | null = null
  private scanning = false
  private destroyed = false
  private onChange?: () => void

  /** Discord only ever uses ten. */
  private static readonly PIPE_COUNT = 10
  /** How often to look for a Discord that was not running last time. */
  private static readonly SCAN_INTERVAL_MS = 20_000

  constructor(clientId: string, prefs: FlavorPrefs = {}, onChange?: () => void) {
    this.clientId = clientId
    this.prefs = { ...DEFAULT_FLAVOR_PREFS, ...prefs }
    this.onChange = onChange
  }

  /** Connect to whatever is running now, then keep looking. */
  start(): void {
    if (this.destroyed) return
    void this.scan()
    if (!this.scanTimer) {
      this.scanTimer = setInterval(() => void this.scan(), DiscordRpcPool.SCAN_INTERVAL_MS)
      // Never hold the process open for a rescan.
      this.scanTimer.unref?.()
    }
  }

  /**
   * Try every socket we are not already on.
   *
   * Cheap: on macOS and Linux the library stats the socket path first, so a
   * number nobody is listening on costs a failed `existsSync` and no
   * connection attempt. Sequential rather than ten at once, to stay well under
   * Discord's connection rate limit even in the worst case.
   */
  private async scan(): Promise<void> {
    if (this.destroyed || this.scanning) return
    this.scanning = true
    try {
      for (let pipeId = 0; pipeId < DiscordRpcPool.PIPE_COUNT; pipeId++) {
        if (this.destroyed) return
        if (this.connections.has(pipeId)) continue
        await this.tryPipe(pipeId)
      }
    } finally {
      this.scanning = false
    }
  }

  private async tryPipe(pipeId: number): Promise<void> {
    const connection = new DiscordRPC(this.clientId, {
      pipeId,
      // The pool owns rediscovery; see the note in scheduleReconnect().
      autoReconnect: false,
      onFlavor: () => {
        // The label only becomes known at READY, which is after login()
        // resolves — so the settings list has to be told to refresh, and a
        // build the listener has switched off must not be left showing a card
        // it was only sent because its identity was still unknown.
        if (!this.isEnabled(connection.getFlavor())) connection.clearActivity()
        this.onChange?.()
      },
      onDropped: () => this.release(pipeId),
    })

    try {
      await connection.login()
    } catch {
      // Nothing listening on this socket, or it refused us. Not an error worth
      // reporting: on a machine running one Discord, nine of ten land here
      // every scan.
      connection.destroy()
      return
    }

    if (this.destroyed) {
      connection.destroy()
      return
    }

    this.connections.set(pipeId, connection)
    console.log(`[RPC] Pool now holds ${this.connections.size} client(s); added ${connection.describe()}`)

    // Bring it straight up to date, so a Discord opened mid-song shows the
    // song rather than waiting for the next position tick.
    if (this.lastActivity && !this.activityCleared && this.isEnabled(connection.getFlavor())) {
      connection.setActivity(this.lastActivity, true)
    }
    this.onChange?.()
  }

  private release(pipeId: number): void {
    const connection = this.connections.get(pipeId)
    if (!connection) return
    this.connections.delete(pipeId)
    console.log(`[RPC] Released ${connection.describe()}; pool holds ${this.connections.size}`)
    try {
      connection.destroy()
    } catch {
      /* already gone */
    }
    this.onChange?.()
  }

  private isEnabled(flavor: DiscordFlavor): boolean {
    return this.prefs[flavor] !== false
  }

  // ── The same surface a single connection had ──────────────────────────────

  setActivity(presence: SetActivity, bypassThrottle = false): void {
    this.lastActivity = presence
    this.activityCleared = false
    for (const connection of this.connections.values()) {
      if (!this.isEnabled(connection.getFlavor())) continue
      connection.setActivity(presence, bypassThrottle)
    }
  }

  clearActivity(): void {
    this.lastActivity = null
    this.activityCleared = true
    // Every connection, including disabled ones: a build that was switched off
    // a moment ago may still be showing the last card, and this is what takes
    // it down. Repeat clears are dropped per connection, so this is cheap.
    for (const connection of this.connections.values()) {
      connection.clearActivity()
    }
  }

  isCleared(): boolean {
    return this.activityCleared
  }

  isConnected(): boolean {
    return this.connections.size > 0
  }

  /** At least one enabled build can actually receive activities. */
  isReady(): boolean {
    for (const connection of this.connections.values()) {
      if (this.isEnabled(connection.getFlavor()) && connection.isReady()) return true
    }
    return false
  }

  // ── Multi-client surface ──────────────────────────────────────────────────

  listClients(): DiscordClientInfo[] {
    return Array.from(this.connections.entries())
      .map(([pipeId, connection]) => {
        const flavor = connection.getFlavor()
        return {
          pipeId,
          flavor,
          label: FLAVOR_LABELS[flavor],
          connected: connection.isConnected(),
          ready: connection.isReady(),
          username: connection.getUsername(),
          enabled: this.isEnabled(flavor),
        }
      })
      .sort((a, b) => a.pipeId - b.pipeId)
  }

  getPrefs(): Record<DiscordFlavor, boolean> {
    return { ...this.prefs }
  }

  /**
   * Turn one build on or off.
   *
   * Switching off takes its card down immediately rather than letting it go
   * stale — a listener who just said "not on my work Discord" should not still
   * be broadcasting there. Switching on replays the current activity, so it
   * catches up mid-song instead of at the next track.
   */
  setFlavorEnabled(flavor: DiscordFlavor, enabled: boolean): void {
    this.prefs = { ...this.prefs, [flavor]: enabled }
    for (const connection of this.connections.values()) {
      if (connection.getFlavor() !== flavor) continue
      if (!enabled) {
        connection.clearActivity()
      } else if (this.lastActivity && !this.activityCleared) {
        connection.setActivity(this.lastActivity, true)
      }
    }
    this.onChange?.()
  }

  /**
   * Aggregate status, in the shape the tray and `presence:ping` already read.
   * Counters are summed across connections; `lastError` is whichever connection
   * most recently had one.
   */
  getStatus(): RpcStatus & { clients: DiscordClientInfo[] } {
    const statuses = Array.from(this.connections.values()).map(c => c.getStatus())
    const sum = (pick: (s: RpcStatus) => number) => statuses.reduce((n, s) => n + pick(s), 0)
    const lastActivityAt = statuses.reduce<number | null>(
      (m, s) => (s.lastActivityAt && (!m || s.lastActivityAt > m) ? s.lastActivityAt : m),
      null,
    )
    const lastError = statuses.map(s => s.lastError).filter(Boolean).pop() ?? null

    return {
      connected: this.isConnected(),
      hasUser: statuses.some(s => s.hasUser),
      activitiesSent: sum(s => s.activitiesSent),
      activitiesDropped: sum(s => s.activitiesDropped),
      lastActivityAt,
      lastError,
      clientIdPresent: Boolean(this.clientId),
      pendingRequests: sum(s => s.pendingRequests),
      clients: this.listClients(),
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
    for (const connection of this.connections.values()) {
      try {
        connection.destroy()
      } catch {
        /* best effort on the way out */
      }
    }
    this.connections.clear()
  }
}
