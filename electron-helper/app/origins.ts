// app/origins.ts
//
// THE single source of truth for which web origins may drive Discord presence.
//
// Why this file exists
// --------------------
// The origin allow-list used to be hardcoded separately in `main.ts` and
// `preload.ts`. Two commits moved them independently:
//
//   4252d22  main.ts     → 'https://unreleased.world'      (apex)
//   9da953b  preload.ts  → 'https://www.unreleased.world'  (www)
//
// Both gates are on the same path — the preload checks `window.location.origin`
// before sending over IPC, and main checks the sender frame's origin before
// acting on it. Because the two constants disagreed, whichever host the site
// actually served, exactly ONE of the gates rejected every single update. Rich
// presence was silently dead: no errors surfaced to the user, just a console
// warning inside a window nobody opens.
//
// Now `main.ts` owns the list and hands it to the preload through
// `webPreferences.additionalArguments`, so the two can never drift again.
//
// A sandboxed preload (`sandbox: true`) cannot `require()` a relative module —
// its `require` is a polyfill limited to a handful of Electron built-ins — which
// is why the list travels as a process argument rather than a shared import.

/** Argument prefix used to hand the allow-list to the sandboxed preload. */
export const ORIGINS_ARGV_PREFIX = '--unrl-allowed-origins='

/**
 * Normalize an origin for comparison.
 *
 * Treats `www.` as equivalent to the apex domain and lowercases the host, so
 * `https://www.unreleased.world` and `https://unreleased.world` compare equal.
 * Returns `null` for anything unparseable.
 *
 * This function is duplicated verbatim in `preload.ts` (sandbox can't import
 * it). `npm test` asserts the two copies stay in sync.
 */
export function normalizeOrigin(value: string | undefined | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    // Only the web schemes normalize. `javascript:`, `file:` and friends parse
    // happily and would otherwise yield a comparable string.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (!host) return null
    const port = url.port ? `:${url.port}` : ''
    return `${url.protocol}//${host}${port}`
  } catch {
    return null
  }
}

/**
 * Build the allow-list from the app URL plus the known production hosts.
 *
 * `ELECTRON_APP_URL` lets a developer point the helper at a local or preview
 * deployment without editing source. Its origin is always included.
 */
export function buildAllowedOrigins(startUrl: string): string[] {
  const candidates = [
    startUrl,
    'https://unreleased.world',
    'https://www.unreleased.world',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const normalized = normalizeOrigin(candidate)
    if (normalized) seen.add(normalized)
  }
  return Array.from(seen)
}

/** True when `value`'s origin is in `allowed` (both sides normalized). */
export function isOriginAllowed(value: string | undefined | null, allowed: string[]): boolean {
  const normalized = normalizeOrigin(value)
  return normalized !== null && allowed.includes(normalized)
}
