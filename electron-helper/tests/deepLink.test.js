// tests/deepLink.test.js
//
// The sign-in link the browser hands back (app/deepLink.ts), and how main.ts,
// the preload and the build config wire it up.
//
// The link carries a one-time handoff that is a credential until the page
// redeems it with the verifier it kept. So: only exactly-shaped links get
// through to the page, only the two values in them, only to the main window's
// own page on an allowed origin, once; and every platform's way of delivering
// a link is wired (macOS open-url from the very start, Windows and Linux on
// the command line of the first launch or of a second one).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  DEEP_LINK_SCHEME,
  HANDOFF_MAX_AGE_MS,
  MAX_DEEP_LINK_LENGTH,
  parseAuthDeepLink,
  findDeepLinkInArgv,
  protocolClientTarget,
} = require('../dist/deepLink')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const HANDOFF = 'h'.repeat(20) + '_-' + 'A1'.repeat(10) + 'z' // 43 base64url characters
const STATE = 's'.repeat(20) + '-_' // 22
const LINK = `world.unreleased.aura://auth?handoff=${HANDOFF}&state=${STATE}`

test('the scheme is the reverse-domain one the site opens (RFC 8252 section 7.1)', () => {
  assert.equal(DEEP_LINK_SCHEME, 'world.unreleased.aura')
  assert.equal(HANDOFF.length, 43)
  assert.equal(STATE.length, 22)
})

test('a well-formed sign-in link gives the handoff and the state, and nothing else', () => {
  assert.deepEqual(parseAuthDeepLink(LINK), { handoff: HANDOFF, state: STATE })
  // The parameters in either order.
  assert.deepEqual(parseAuthDeepLink(`world.unreleased.aura://auth?state=${STATE}&handoff=${HANDOFF}`), {
    handoff: HANDOFF,
    state: STATE,
  })
})

test('the forms browsers actually hand over are accepted', () => {
  for (const variant of [
    `world.unreleased.aura://auth/?handoff=${HANDOFF}&state=${STATE}`, // a trailing slash added
    `WORLD.UNRELEASED.AURA://auth?handoff=${HANDOFF}&state=${STATE}`, // the scheme is case-insensitive
    `world.unreleased.aura:/auth?handoff=${HANDOFF}&state=${STATE}`, // RFC 8252's single-slash form
  ]) {
    assert.deepEqual(parseAuthDeepLink(variant), { handoff: HANDOFF, state: STATE }, variant)
  }
})

test('anything that is not exactly a sign-in link is refused', () => {
  for (const bad of [
    undefined,
    null,
    42,
    '',
    'not a url',
    `https://www.unreleased.world/auth?handoff=${HANDOFF}&state=${STATE}`, // another scheme
    `unreleasd://auth?handoff=${HANDOFF}&state=${STATE}`, // the presence deep-link scheme is not this one
    `world.unreleased.aura.evil://auth?handoff=${HANDOFF}&state=${STATE}`,
    `world.unreleased.aura://settings?handoff=${HANDOFF}&state=${STATE}`, // another target
    `world.unreleased.aura://auth/callback?handoff=${HANDOFF}&state=${STATE}`,
    `world.unreleased.aura://auth?handoff=${HANDOFF}`, // the state is missing
    `world.unreleased.aura://auth?state=${STATE}`,
    `world.unreleased.aura://auth?handoff=${HANDOFF}&state=${STATE}&verifier=x`, // an extra parameter
    `world.unreleased.aura://auth?handoff=${HANDOFF}&handoff=${HANDOFF}&state=${STATE}`, // a repeated one
    `world.unreleased.aura://auth?handoff=${HANDOFF}x&state=${STATE}`, // 44 characters
    `world.unreleased.aura://auth?handoff=${HANDOFF.slice(1)}&state=${STATE}`, // 42
    `world.unreleased.aura://auth?handoff=${HANDOFF.slice(0, 42)}%3D&state=${STATE}`, // not base64url
    `world.unreleased.aura://auth?handoff=${HANDOFF}&state=${STATE}x`,
    `world.unreleased.aura://auth?handoff=${HANDOFF}&state=${STATE}#fragment`,
    `world.unreleased.aura://user:pass@auth?handoff=${HANDOFF}&state=${STATE}`,
    `world.unreleased.aura://auth:8080?handoff=${HANDOFF}&state=${STATE}`,
    `${LINK}&${'x'.repeat(MAX_DEEP_LINK_LENGTH)}=1`, // far too long
  ]) {
    assert.equal(parseAuthDeepLink(bad), null, `should have refused ${String(bad).slice(0, 120)}`)
  }
})

test('the link is found on a command line among the switches Chromium adds', () => {
  assert.equal(findDeepLinkInArgv(['C:\\aura\\aura.exe', LINK]), LINK)
  assert.equal(
    findDeepLinkInArgv(['C:\\aura\\aura.exe', '--allow-file-access-from-files', '--original-process-start-time=1', LINK]),
    LINK,
  )
  assert.equal(findDeepLinkInArgv(['/opt/aura/aura', '--no-sandbox', LINK.toUpperCase()]), LINK.toUpperCase())
  assert.equal(findDeepLinkInArgv(['C:\\aura\\aura.exe']), null)
  assert.equal(findDeepLinkInArgv(['C:\\aura\\aura.exe', 'https://www.unreleased.world/']), null)
  assert.equal(findDeepLinkInArgv([]), null)
  assert.equal(findDeepLinkInArgv([null, 7, undefined]), null)
})

test('the protocol is registered for this copy of the app', () => {
  // Installed: Electron's own path.
  assert.deepEqual(protocolClientTarget({ defaultApp: false, execPath: 'C:\\aura\\aura.exe' }), {})
  // `electron .` in development: bare Electron plus the app folder.
  assert.deepEqual(protocolClientTarget({ defaultApp: true, appPath: '/src/aura', execPath: '/x/electron' }), {
    path: '/x/electron',
    args: ['/src/aura'],
  })
  // The portable .exe runs from a temporary folder: the file the person has.
  assert.deepEqual(
    protocolClientTarget({ defaultApp: false, execPath: 'C:\\Temp\\x\\aura.exe', portableExecutable: 'D:\\Aura-win-x64.exe' }),
    { path: 'D:\\Aura-win-x64.exe', args: [] },
  )
})

test('a received link waits for the page a few minutes at most (the server allows two)', () => {
  assert.ok(HANDOFF_MAX_AGE_MS >= 2 * 60 * 1000 && HANDOFF_MAX_AGE_MS <= 10 * 60 * 1000)
})

// ---- Wiring ---------------------------------------------------------------------------

/** A source file with comments taken out, so a comment can never satisfy a check. */
function code(file) {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')
}

test('main.ts hears macOS open-url from the very start, before the lock and before ready', () => {
  const main = code('app/main.ts')
  const openUrl = main.indexOf("app.on('open-url'")
  assert.ok(openUrl > -1, 'no open-url handler')
  assert.ok(openUrl < main.indexOf('app.requestSingleInstanceLock()'), 'open-url must be registered before the lock')
  assert.ok(openUrl < main.indexOf('app.whenReady()'), 'open-url must be registered before ready')
  assert.match(main, /app\.on\('open-url', \(event, url\) => \{\s*event\.preventDefault\(\)\s*acceptDeepLink\(url\)/)
})

test('main.ts takes the link from a second launch and from its own first command line', () => {
  const main = code('app/main.ts')
  assert.match(main, /app\.on\('second-instance', \(_event, argv\) => \{[\s\S]*?acceptDeepLink\(findDeepLinkInArgv\(argv\)\)/)
  assert.match(main, /acceptDeepLink\(findDeepLinkInArgv\(process\.argv\)\)/)
  assert.match(main, /registerProtocolClient\(\)/)
  assert.match(main, /app\.setAsDefaultProtocolClient\(DEEP_LINK_SCHEME/)
  // Both inside the branch that holds the lock (a second copy quits at once).
  const lock = main.indexOf('if (!gotTheLock)')
  assert.ok(main.indexOf('registerProtocolClient()\n') > lock)
  assert.ok(main.indexOf('acceptDeepLink(findDeepLinkInArgv(process.argv))') > lock)
})

test('only a parsed link is kept, and nothing about a link is ever logged', () => {
  const main = code('app/main.ts')
  const start = main.indexOf('function acceptDeepLink(')
  const end = main.indexOf('\n}\n', start)
  const body = main.slice(start, end)
  assert.match(body, /const link = parseAuthDeepLink\(raw\)/)
  assert.match(body, /if \(!link\) \{/)
  assert.match(body, /pendingHandoff = \{ link, at: Date\.now\(\) \}/)
  // A fixed sentence at most: no variable, so neither the link nor anything parsed from it.
  const calls = body.match(/console\.\w+\([^)]*\)/g) || []
  assert.ok(calls.length > 0)
  for (const call of calls) assert.match(call, /^console\.\w+\('[^'$`]*'\)$/, `logs more than a fixed sentence: ${call}`)
})

test("the page takes the link once, and only the main window's page on an allowed origin", () => {
  const main = code('app/main.ts')
  const start = main.indexOf("ipcMain.handle('auth:take-handoff'")
  assert.ok(start > -1, 'no auth:take-handoff handler')
  const body = main.slice(start, main.indexOf('})', main.indexOf('return { handoff', start)) + 2)
  assert.match(body, /event\.sender !== mainWindow\.webContents\) return null/)
  assert.match(body, /if \(!isOriginAllowed\(event\.senderFrame\?\.url, ALLOWED_ORIGINS\)\) return null/)
  assert.match(body, /pendingHandoff = null/)
  assert.match(body, /if \(Date\.now\(\) - pending\.at > HANDOFF_MAX_AGE_MS\) return null/)
  assert.match(body, /return \{ handoff: pending\.link\.handoff, state: pending\.link\.state \}/)
  // Taken before the age check: an old link is dropped, not kept for later.
  assert.ok(body.indexOf('pendingHandoff = null') < body.indexOf('HANDOFF_MAX_AGE_MS'))
})

test('the preload exposes unrlAuth: version 1, origin-checked, handoff and state only', () => {
  const preload = code('app/preload.ts')
  assert.match(preload, /contextBridge\.exposeInMainWorld\('unrlAuth', unrlAuthAPI\)/)
  assert.match(preload, /version: 1,/)
  assert.match(preload, /onHandoff: \(callback[\s\S]*?if \(typeof callback !== 'function' \|\| !isCurrentOriginAllowed\(\)\) return \(\) => \{\}/)
  assert.match(preload, /ipcRenderer\.invoke\('auth:take-handoff'\)/)
  assert.match(preload, /ipcRenderer\.on\('auth:handoff-ready'/)
  assert.match(preload, /listener\(\{ handoff: link\.handoff, state: link\.state \}\)/)
  // The presence bridge is untouched: the site still detects the app by it.
  assert.match(preload, /contextBridge\.exposeInMainWorld\('unrlPresence', unrlPresenceAPI\)/)
})

test('the build declares the scheme, and the uninstaller removes what the app registered', () => {
  const config = require('../electron-builder.config.js')
  assert.deepEqual(config.protocols, [{ name: 'aura sign-in', schemes: [DEEP_LINK_SCHEME] }])
  const nsh = read('build/installer.nsh')
  assert.match(nsh, /!macro customUnInstall\s+DeleteRegKey HKCU "Software\\Classes\\world\.unreleased\.aura"\s+!macroend/)
})

test('new windows still go to the system browser, which is how the site opens the sign-in page', () => {
  const main = code('app/main.ts')
  assert.match(main, /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?shell\.openExternal\(url\)[\s\S]*?return \{ action: 'deny' \}/)
})
