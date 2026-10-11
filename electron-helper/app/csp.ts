// app/csp.ts
//
// The Content-Security-Policy the app puts on every response it loads.
//
// main.ts registers an onHeadersReceived handler with no filter, so this
// policy lands on every document the window loads: the site's pages, and any
// iframe inside them. It replaces whatever policy the response carried.
//
// Why it names Cloudflare
// -----------------------
// Since October 2026 the site checks sign-ins, sign-ups and password resets
// with Cloudflare Turnstile (Supabase Auth's CAPTCHA, and the bot check on a
// new account's profile). Turnstile is a script from
// https://challenges.cloudflare.com that draws its widget in an iframe from the
// same origin. Up to 1.0.4 this policy named neither: script-src had no
// Cloudflare in it and there was no frame-src at all, so frames fell back to
// default-src (the site and nothing else). The app refused the script, the
// site sent its requests without a token, and Supabase turned down every email
// sign-in made in the app ("captcha protection: request disallowed (no
// captcha_token found)") while the same account signed in fine in a browser.
//
// Cloudflare documents exactly two sources for Turnstile
// (developers.cloudflare.com/turnstile/reference/content-security-policy/):
//
//   script-src https://challenges.cloudflare.com
//   frame-src  https://challenges.cloudflare.com
//
// plus connect-src 'self' for pre-clearance, which this policy already allows
// (connect-src takes 'self' and any https: URL). So Cloudflare's origin is
// added to script-src, and frame-src is written out as what frames got before
// (default-src's sources) plus Cloudflare. Every other directive is what 1.0.4
// shipped; tests/csp.test.js pins all of it.
//
// The handler also rewrites Cloudflare's own iframe document, where 'self' is
// challenges.cloudflare.com: its scripts, frames and workers are same-origin
// or blob:, and its requests are https:, all of which the policy allows.

/** Cloudflare Turnstile: its script and its iframe both come from this origin. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/**
 * The site's origins as CSP sources: each allowed origin, and its www. twin.
 *
 * Apex and www must both be listed: the site may redirect between them, and a
 * policy naming only one would block the other's scripts and styles outright.
 * (Loopback origins get a www. twin too. It matches nothing and harms nothing,
 * and it is what every release so far has shipped.)
 */
export function cspSources(allowedOrigins: string[]): string {
  return allowedOrigins
    .flatMap((origin) => {
      const withWww = origin.replace(/^(https?:\/\/)/, '$1www.')
      return origin === withWww ? [origin] : [origin, withWww]
    })
    .join(' ')
}

/** The policy for a window whose allowed origins are `allowedOrigins` (see app/origins.ts). */
export function buildContentSecurityPolicy(allowedOrigins: string[]): string {
  const site = cspSources(allowedOrigins)
  return (
    `default-src 'self' ${site}; ` +
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${site} ${TURNSTILE_ORIGIN}; ` +
    // Before 1.0.5 frames fell back to default-src. Same sources, plus Turnstile's iframe.
    `frame-src 'self' ${site} ${TURNSTILE_ORIGIN}; ` +
    // Supabase realtime drives its keep-alive ping from a Web Worker
    // spawned off a blob URL. Without this the construction is refused,
    // and realtime-js answers a failed worker by disconnecting outright —
    // so the desktop app loses cross-device control entirely. With the
    // main-thread fallback it merely loses the ping whenever the window
    // is backgrounded, which is exactly when playback control matters.
    `worker-src 'self' blob:; ` +
    `style-src 'self' 'unsafe-inline' ${site}; ` +
    `img-src 'self' data: https: blob:; ` +
    `connect-src 'self' https: ws: wss: data:; ` +
    `font-src 'self' data: ${site}; ` +
    `media-src 'self' https: data: blob:;`
  )
}
