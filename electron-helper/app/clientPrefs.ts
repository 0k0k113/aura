// Which Discord builds the listener wants presence on.
//
// Kept in the helper rather than in the web app's localStorage on purpose:
// the choice is about this computer (which Discord builds are installed here),
// not about the account. Someone signed in on a laptop with only stable should
// not have a Canary toggle pushed at them because their desktop has one, and
// the setting should survive clearing site data.

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { DiscordFlavor } from './rpc'
import { DEFAULT_FLAVOR_PREFS, type FlavorPrefs } from './rpcPool'

const FILE = 'discord-clients.json'
const VALID: DiscordFlavor[] = ['stable', 'ptb', 'canary', 'unknown']

function prefsPath(): string {
  return path.join(app.getPath('userData'), FILE)
}

/** Never throws: an unreadable or corrupt file means "all builds on". */
export function loadFlavorPrefs(): Record<DiscordFlavor, boolean> {
  try {
    const raw = fs.readFileSync(prefsPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_FLAVOR_PREFS }
    const out: Record<DiscordFlavor, boolean> = { ...DEFAULT_FLAVOR_PREFS }
    for (const flavor of VALID) {
      const value = (parsed as Record<string, unknown>)[flavor]
      if (typeof value === 'boolean') out[flavor] = value
    }
    return out
  } catch {
    return { ...DEFAULT_FLAVOR_PREFS }
  }
}

/** Best effort. Failing to persist must never break presence itself. */
export function saveFlavorPrefs(prefs: FlavorPrefs): void {
  try {
    fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2), 'utf8')
  } catch (error: any) {
    console.warn('[RPC] Could not save Discord client preferences:', error?.message || error)
  }
}

export function isFlavor(value: unknown): value is DiscordFlavor {
  return typeof value === 'string' && (VALID as string[]).includes(value)
}
