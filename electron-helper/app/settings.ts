// app/settings.ts
//
// A tiny persisted preference store, for the choices only the person looking
// at the Discord card can make.
//
// Whether the album shows on hover is one of those. Discord documents
// `large_text` as a hover tooltip, but this client also paints it as a line in
// the card, so "album on hover, no line" is not something the documentation
// can settle — it takes a look at the actual card. Every attempt to settle it
// by rebuilding costs a release, a download and an install, which is a poor
// way to answer a yes/no question about a tooltip.
//
// So the choice moves to a tray checkbox and lives here. One build, both
// behaviours, switched in a click.

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

export interface Settings {
  /**
   * Show the album name when hovering the artwork.
   *
   * On: the album travels in `small_text`, with the site logo badged on the
   * corner of the cover to give the tooltip something to hover.
   * Off: the album is not sent at all — no tooltip, no badge, and no chance
   * of it appearing as a line.
   */
  albumHover: boolean
}

const DEFAULTS: Settings = {
  albumHover: true,
}

let cached: Settings | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): Settings {
  if (cached) return cached
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Settings>
    // Only take keys we know, and only when the type is right — a hand-edited
    // or half-written file must not be able to produce undefined behaviour.
    cached = {
      albumHover:
        typeof parsed.albumHover === 'boolean' ? parsed.albumHover : DEFAULTS.albumHover,
    }
  } catch {
    // Missing, unreadable or malformed — defaults are always a valid answer.
    cached = { ...DEFAULTS }
  }
  return cached
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch }
  cached = next
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (error) {
    // The preference still applies for this session; it just will not survive
    // a restart. Losing a tooltip toggle is not worth taking the app down.
    console.warn('[Settings] Could not persist settings:', error)
  }
  return next
}

/** Test seam: forget the in-memory copy so the next read hits disk. */
export function resetSettingsCache(): void {
  cached = null
}
