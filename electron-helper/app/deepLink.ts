// app/deepLink.ts
//
// The app's own URL scheme, and the one thing it carries: a sign-in handed
// back from the browser.
//
// Why the browser signs in for the app
// ------------------------------------
// Inside the app, email and password used to be the only way in. Passkeys need
// an authenticator the app does not have: Electron 30 ships Chromium's WebAuthn
// API but not the browser's plumbing behind it (on macOS, Touch ID needs
// Electron 41.5+ with app.configureWebAuthn and a Team ID keychain group, and
// iCloud Keychain needs Apple's restricted associated-domains entitlement; this
// app is ad-hoc signed; on Linux only USB keys answer). Google and Discord open
// the system browser, which then signs the BROWSER in, not the app.
//
// So, from 1.0.5, the site (running in this window) does what RFC 8252 tells
// native apps to do. It keeps a secret verifier, opens the system browser at
// https://www.unreleased.world/auth/desktop with only the verifier's SHA-256,
// and the browser signs in by any means it has: a passkey, Google, Discord, a
// password, or a whole new account. The browser then opens
//
//   world.unreleased.aura://auth?handoff=<43 chars>&state=<22 chars>
//
// which the operating system hands to this app: `open-url` on macOS, and on
// Windows and Linux the command line of a second launch (which the
// single-instance lock turns into 'second-instance' on the running app) or of
// the first launch if the app was not running. main.ts parses it here and
// passes the two values to the page, which redeems the handoff WITH its
// verifier for a session of its own.
//
// The scheme is a reverse domain name (RFC 8252 section 7.1). Another app can
// still register it and catch the link, but the handoff is useless without the
// verifier, which never leaves this app, and it expires in two minutes and
// works once. Nothing here is logged: the link is a credential until redeemed.

/** Registered with the OS (electron-builder `protocols`, and setAsDefaultProtocolClient). */
export const DEEP_LINK_SCHEME = 'world.unreleased.aura'

/** How long a received link waits for the page to take it (the server's own limit is two minutes). */
export const HANDOFF_MAX_AGE_MS = 5 * 60 * 1000

/** Far longer than any real link (about 100 characters); anything longer is not one. */
export const MAX_DEEP_LINK_LENGTH = 512

const HANDOFF = /^[A-Za-z0-9_-]{43}$/
const STATE = /^[A-Za-z0-9_-]{22}$/

export interface AuthHandoff {
  handoff: string
  state: string
}

/**
 * The handoff and state in a sign-in link, or null for anything else: another
 * scheme, another target, extra or missing parameters, or values of the wrong
 * shape. Strict on purpose: nothing but these two values ever reaches the page.
 */
export function parseAuthDeepLink(raw: unknown): AuthHandoff | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DEEP_LINK_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null
  if (url.username || url.password || url.port || url.hash) return null
  // world.unreleased.aura://auth?..., allowing the trailing slash some browsers add.
  const target = `${url.host}${url.pathname}`.replace(/^\/+|\/+$/g, '').toLowerCase()
  if (target !== 'auth') return null
  const keys = Array.from(url.searchParams.keys())
  if (keys.length !== 2 || !keys.includes('handoff') || !keys.includes('state')) return null
  const handoff = url.searchParams.get('handoff')
  const state = url.searchParams.get('state')
  if (!handoff || !HANDOFF.test(handoff) || !state || !STATE.test(state)) return null
  return { handoff, state }
}

/**
 * The sign-in link in a command line, or null. Windows and Linux start the
 * app with the link as an argument; Chromium may add switches of its own
 * around it, so this looks for the argument with our scheme rather than
 * taking the last one.
 */
export function findDeepLinkInArgv(argv: readonly unknown[]): string | null {
  const prefix = `${DEEP_LINK_SCHEME}:`
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.slice(0, prefix.length).toLowerCase() === prefix) return arg
  }
  return null
}

/**
 * What app.setAsDefaultProtocolClient needs to launch THIS copy of the app:
 *   - a development run (`electron .`, process.defaultApp) must name its app
 *     folder, or the OS would start bare Electron;
 *   - the Windows portable build runs from a temporary folder, so it names
 *     the portable .exe the person actually has (PORTABLE_EXECUTABLE_FILE);
 *   - an installed build needs nothing: Electron registers its own path.
 */
export function protocolClientTarget(options: {
  defaultApp: boolean
  /** The app folder a development run was started with (process.argv[1], resolved). */
  appPath?: string | null
  execPath: string
  portableExecutable?: string | null
}): { path?: string; args?: string[] } {
  if (options.defaultApp) return { path: options.execPath, args: options.appPath ? [options.appPath] : [] }
  if (options.portableExecutable) return { path: options.portableExecutable, args: [] }
  return {}
}
