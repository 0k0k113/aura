// tests/csp.test.js
//
// Pins the Content-Security-Policy the app puts on every response (app/csp.ts).
//
// 1.0.4 and earlier shipped a policy with no Cloudflare in it, so the site's
// sign-in check (Cloudflare Turnstile, Supabase Auth's CAPTCHA) could not load
// in the app, and with the CAPTCHA on every email sign-in made here was
// refused. These fail if Turnstile's two sources go missing again, and just as
// much if the policy grows anything beyond them.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { buildContentSecurityPolicy, cspSources, TURNSTILE_ORIGIN } = require('../dist/csp')
const { buildAllowedOrigins } = require('../dist/origins')

const PRODUCTION = buildAllowedOrigins('https://unreleased.world')
const SITE =
  'https://unreleased.world https://www.unreleased.world ' +
  'http://localhost:3000 http://www.localhost:3000 http://127.0.0.1:3000 http://www.127.0.0.1:3000'

/** The policy 1.0.4 shipped, verbatim (git show v1.0.4:electron-helper/app/main.ts). */
const SHIPPED_IN_1_0_4 =
  `default-src 'self' ${SITE}; ` +
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${SITE}; ` +
  `worker-src 'self' blob:; ` +
  `style-src 'self' 'unsafe-inline' ${SITE}; ` +
  `img-src 'self' data: https: blob:; ` +
  `connect-src 'self' https: ws: wss: data:; ` +
  `font-src 'self' data: ${SITE}; ` +
  `media-src 'self' https: data: blob:;`

/** directive name → its sources, in order. */
function directives(policy) {
  const out = new Map()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean)
    if (!name) continue
    assert.ok(!out.has(name), `${name} is listed twice`)
    out.set(name, sources)
  }
  return out
}

test('the policy, exactly', () => {
  assert.equal(
    buildContentSecurityPolicy(PRODUCTION),
    `default-src 'self' ${SITE}; ` +
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${SITE} https://challenges.cloudflare.com; ` +
      `frame-src 'self' ${SITE} https://challenges.cloudflare.com; ` +
      `worker-src 'self' blob:; ` +
      `style-src 'self' 'unsafe-inline' ${SITE}; ` +
      `img-src 'self' data: https: blob:; ` +
      `connect-src 'self' https: ws: wss: data:; ` +
      `font-src 'self' data: ${SITE}; ` +
      `media-src 'self' https: data: blob:;`,
  )
})

test("Turnstile's script and iframe are allowed (Cloudflare's documented policy)", () => {
  assert.equal(TURNSTILE_ORIGIN, 'https://challenges.cloudflare.com')
  const policy = directives(buildContentSecurityPolicy(PRODUCTION))
  assert.ok(policy.get('script-src').includes(TURNSTILE_ORIGIN), 'script-src must allow api.js')
  assert.ok(policy.get('frame-src').includes(TURNSTILE_ORIGIN), "frame-src must allow Turnstile's iframe")
  // Pre-clearance needs connect-src 'self'; it was always there.
  assert.ok(policy.get('connect-src').includes("'self'"))
})

test('Cloudflare is named in script-src and frame-src and nowhere else', () => {
  const policy = directives(buildContentSecurityPolicy(PRODUCTION))
  for (const [name, sources] of policy) {
    const named = sources.some((s) => s.includes('cloudflare'))
    assert.equal(named, name === 'script-src' || name === 'frame-src', `${name}: ${sources.join(' ')}`)
  }
})

test('frames get exactly what they had before (default-src) plus Cloudflare', () => {
  // 1.0.4 had no frame-src, so frames fell back to default-src. Dropping 'self'
  // or the site here would break same-origin iframes; anything more is broader
  // than Turnstile needs.
  const policy = directives(buildContentSecurityPolicy(PRODUCTION))
  assert.deepEqual(policy.get('frame-src'), [...policy.get('default-src'), TURNSTILE_ORIGIN])
})

test('every other directive is byte-for-byte what 1.0.4 shipped', () => {
  const before = directives(SHIPPED_IN_1_0_4)
  const after = directives(buildContentSecurityPolicy(PRODUCTION))
  assert.deepEqual([...after.keys()].filter((name) => !before.has(name)), ['frame-src'])
  for (const [name, sources] of before) {
    const expected = name === 'script-src' ? [...sources, TURNSTILE_ORIGIN] : sources
    assert.deepEqual(after.get(name), expected, name)
  }
})

test('no wildcard sources, and no new scheme sources where scripts or frames load', () => {
  const policy = directives(buildContentSecurityPolicy(PRODUCTION))
  for (const [name, sources] of policy) {
    for (const source of sources) assert.ok(!source.includes('*'), `${name} has a wildcard: ${source}`)
  }
  assert.deepEqual(
    policy.get('script-src').filter((s) => /^[a-z-]+:$/.test(s)),
    ['blob:'],
    'script-src scheme sources',
  )
  assert.deepEqual(
    policy.get('frame-src').filter((s) => /^[a-z-]+:$/.test(s)),
    [],
    'frame-src scheme sources',
  )
})

test('apex and www are both listed whichever one the app starts on', () => {
  for (const startUrl of ['https://unreleased.world', 'https://www.unreleased.world']) {
    const sources = cspSources(buildAllowedOrigins(startUrl)).split(' ')
    assert.ok(sources.includes('https://unreleased.world'), startUrl)
    assert.ok(sources.includes('https://www.unreleased.world'), startUrl)
  }
})

test('main.ts puts this policy, and no inline copy of one, on every response', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.ts'), 'utf8')
  assert.match(main, /buildContentSecurityPolicy\(ALLOWED_ORIGINS\)/)
  assert.match(main, /'Content-Security-Policy': \[contentSecurityPolicy\]/)
  // A second, hand-written policy in main.ts is how the two would drift apart.
  assert.doesNotMatch(main, /[`'"](default|script|frame)-src/)
})
