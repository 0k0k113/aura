// tests/origins.test.js
//
// Regression cover for the bug that silently killed all Discord presence:
// main.ts and preload.ts each hardcoded their own origin constant, the two were
// edited in separate commits, and they ended up disagreeing about `www.`.
// Whichever host the site served, one of the two gates rejected every update.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { normalizeOrigin, buildAllowedOrigins, isOriginAllowed } = require('../dist/origins')

const APP_DIR = path.join(__dirname, '..', 'app')

test('normalizeOrigin folds www. into the apex domain', () => {
  assert.equal(
    normalizeOrigin('https://www.unreleased.world'),
    normalizeOrigin('https://unreleased.world'),
  )
})

test('normalizeOrigin lowercases the host and keeps a non-default port', () => {
  assert.equal(normalizeOrigin('https://UNRELEASED.World/some/path'), 'https://unreleased.world')
  assert.equal(normalizeOrigin('http://localhost:3000/x'), 'http://localhost:3000')
})

test('normalizeOrigin does not conflate different schemes or hosts', () => {
  assert.notEqual(normalizeOrigin('http://unreleased.world'), normalizeOrigin('https://unreleased.world'))
  assert.notEqual(normalizeOrigin('https://evil.world'), normalizeOrigin('https://unreleased.world'))
})

test('normalizeOrigin rejects anything that is not an http(s) origin', () => {
  for (const bad of [
    undefined,
    null,
    '',
    'not a url',
    'javascript:alert(1)//',
    'file:///etc/passwd',
    'data:text/html,<script>1</script>',
    'unreleasd://open',
  ]) {
    assert.equal(normalizeOrigin(bad), null, `should have rejected ${String(bad)}`)
  }
})

test('apex and www are both accepted regardless of which one START_URL names', () => {
  // This is the exact failure: main.ts said apex, preload.ts said www.
  for (const startUrl of ['https://unreleased.world', 'https://www.unreleased.world']) {
    const allowed = buildAllowedOrigins(startUrl)
    assert.ok(isOriginAllowed('https://unreleased.world', allowed), `apex rejected for ${startUrl}`)
    assert.ok(isOriginAllowed('https://www.unreleased.world', allowed), `www rejected for ${startUrl}`)
  }
})

test('a custom ELECTRON_APP_URL origin is always allowed', () => {
  const allowed = buildAllowedOrigins('https://staging.unreleased.world')
  assert.ok(isOriginAllowed('https://staging.unreleased.world/home', allowed))
})

test('unrelated origins stay blocked', () => {
  const allowed = buildAllowedOrigins('https://unreleased.world')
  for (const bad of [
    'https://unreleased.world.evil.com',
    'https://evil.com',
    'http://unreleased.world', // scheme downgrade
    'file:///etc/passwd',
    undefined,
    null,
  ]) {
    assert.equal(isOriginAllowed(bad, allowed), false, `should have blocked ${bad}`)
  }
})

test('the allow-list has no duplicates after normalization', () => {
  const allowed = buildAllowedOrigins('https://www.unreleased.world')
  assert.equal(new Set(allowed).size, allowed.length)
})

// ---------------------------------------------------------------------------
// Drift guard.
//
// A sandboxed preload cannot require('./origins'), so normalizeOrigin is
// necessarily duplicated there. That duplication is what caused the original
// outage, so pin the two copies together: if someone edits one, this fails.
// ---------------------------------------------------------------------------

/** Pull a named function's source out of a TS file and strip comments/whitespace. */
function extractFunction(file, name) {
  const source = fs.readFileSync(path.join(APP_DIR, file), 'utf8')
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} not found in ${file}`)

  let depth = 0
  let i = source.indexOf('{', start)
  const bodyStart = i
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) break
    }
  }

  return source
    .slice(bodyStart, i + 1)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

test('preload.ts normalizeOrigin is identical to origins.ts normalizeOrigin', () => {
  assert.equal(
    extractFunction('preload.ts', 'normalizeOrigin'),
    extractFunction('origins.ts', 'normalizeOrigin'),
    'preload.ts and origins.ts have drifted — that is exactly the bug that ' +
      'took Discord presence down. Keep the two copies byte-identical.',
  )
})

test('preload.ts and origins.ts agree on the argv prefix', () => {
  const preload = fs.readFileSync(path.join(APP_DIR, 'preload.ts'), 'utf8')
  const origins = fs.readFileSync(path.join(APP_DIR, 'origins.ts'), 'utf8')
  const prefix = origins.match(/ORIGINS_ARGV_PREFIX = '([^']+)'/)[1]
  assert.ok(
    preload.includes(`ORIGINS_ARGV_PREFIX = '${prefix}'`),
    `preload.ts must use the same argv prefix as origins.ts ('${prefix}')`,
  )
})
