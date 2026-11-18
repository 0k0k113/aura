// tests/titleBar.test.js
//
// The window's buttons inside the site's own top bar (app/titleBar.ts, 1.0.13). A member, 2026-11-18: "is there no
// way of you getting rid of that [the title bar] and make the minimize fullscreen or cross can be implimented in the
// bar you have like how spotify has it"; the owner: "genuinely flawless & reliable ... for mac & not only windows".
// Pinned here: the window's options per platform and mode, the fail-safe (the frame until the site has said it is
// ready; a safe band over a page that never says it), the bridge's allow-list and origin checks, and the wiring.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const tb = require('../dist/titleBar')
const {
  TITLE_BAR_CHANGED,
  TITLE_BAR_THEME,
  TITLE_BAR_ARGV_PREFIX,
  TITLE_BAR_PROTOCOL,
  TITLE_BAR_HEIGHT,
  TRAFFIC_LIGHT_POSITION,
  READY_GRACE_MS,
  EMERGENCY_CSS,
  titleBarModeFor,
  titleBarWindowOptions,
  overlayStyle,
  windowBackground,
  parseTitleBarMemory,
  readTitleBarMemory,
  writeTitleBarMemory,
  attachTitleBar,
} = tb

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
/** A TS file without its comments, so a match is code and not a sentence about it. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const READY = { siteReady: true, protocol: TITLE_BAR_PROTOCOL, theme: 'dark' }

// ---------------------------------------------------------------------------
// The window's options.
// ---------------------------------------------------------------------------

test('Windows with the overlay: no title bar, the system buttons drawn over the page, see-through, 80px', () => {
  const options = titleBarWindowOptions('win32', 'overlay')
  assert.deepEqual(options, { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 80 } })
  assert.equal(TITLE_BAR_HEIGHT, 80)
})

test('a Mac with the overlay: hidden title bar, the traffic lights vertically centred on the band, its geometry on', () => {
  const options = titleBarWindowOptions('darwin', 'overlay')
  assert.deepEqual(options, { titleBarStyle: 'hidden', trafficLightPosition: { x: 24, y: 32 }, titleBarOverlay: { height: 80 } })
  // A light's frame is 16 tall: 32 + 16/2 = 40, the band's middle.
  assert.equal(TRAFFIC_LIGHT_POSITION.y + 16 / 2, TITLE_BAR_HEIGHT / 2)
  // Never shared: a caller changing its copy cannot move the lights of the next window.
  options.trafficLightPosition.y = 0
  assert.equal(titleBarWindowOptions('darwin', 'overlay').trafficLightPosition.y, 32)
})

test("while the page loads: black, as always, except a light-theme overlay window (its ink buttons stay visible)", () => {
  assert.equal(windowBackground('frame', undefined), '#000000')
  assert.equal(windowBackground('frame', 'light'), '#000000')
  assert.equal(windowBackground('overlay', 'dark'), '#000000')
  assert.equal(windowBackground('overlay', undefined), '#000000')
  assert.equal(windowBackground('overlay', 'light'), '#efeef6')
  assert.match(code('app/main.ts'), /backgroundColor: windowBackground\(mode, titleBarRemembered\?\.theme\)/)
})

test('Linux keeps its frame, and the frame mode adds nothing at all on any platform', () => {
  for (const mode of ['overlay', 'frame']) assert.deepEqual(titleBarWindowOptions('linux', mode), {})
  for (const platform of ['win32', 'darwin', 'linux', 'freebsd']) assert.deepEqual(titleBarWindowOptions(platform, 'frame'), {})
})

test('the colours follow the site: white symbols on dark, ink on light, the background see-through either way', () => {
  assert.deepEqual(overlayStyle('dark'), { color: '#00000000', symbolColor: '#ffffff', height: 80 })
  assert.deepEqual(overlayStyle('light'), { color: '#ffffff00', symbolColor: '#17141d', height: 80 })
  // A window starts in the colours the site last asked for (no white symbols on a light page while it loads).
  assert.deepEqual(titleBarWindowOptions('win32', 'overlay', 'light').titleBarOverlay, overlayStyle('light'))
  assert.deepEqual(titleBarWindowOptions('win32', 'overlay', 'nonsense').titleBarOverlay, overlayStyle('dark'))
})

// ---------------------------------------------------------------------------
// The fail-safe: the frame until the site has said it is ready.
// ---------------------------------------------------------------------------

test('the overlay only after the site said ready, in this protocol, on Windows or a Mac', () => {
  assert.equal(titleBarModeFor('win32', READY), 'overlay')
  assert.equal(titleBarModeFor('darwin', READY), 'overlay')
  assert.equal(titleBarModeFor('linux', READY), 'frame')
  // A first start, a site that said "not ready", another protocol: the frame, exactly as today.
  assert.equal(titleBarModeFor('win32', null), 'frame')
  assert.equal(titleBarModeFor('win32', { siteReady: false, protocol: TITLE_BAR_PROTOCOL }), 'frame')
  assert.equal(titleBarModeFor('darwin', { siteReady: true, protocol: TITLE_BAR_PROTOCOL + 1 }), 'frame')
})

test('the memory: anything unreadable is no memory (the frame)', () => {
  assert.deepEqual(parseTitleBarMemory('{"siteReady":true,"protocol":1,"at":"x"}'), { siteReady: true, protocol: 1, theme: undefined, at: 'x' })
  assert.equal(parseTitleBarMemory('{"siteReady":true,"protocol":1,"theme":"light"}').theme, 'light')
  assert.equal(parseTitleBarMemory('{"siteReady":true,"protocol":1,"theme":"#fff"}').theme, undefined)
  for (const bad of [null, '', '{', 'null', '[]', '{"siteReady":"yes","protocol":1}', '{"siteReady":true}', '7']) {
    assert.equal(parseTitleBarMemory(bad), null, String(bad))
  }
  const missing = { readFileSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, writeFileSync() {} }
  assert.equal(readTitleBarMemory('/nowhere/title-bar.json', missing), null)
})

test('remembering writes one small file, and a failed write is only a missed change', () => {
  const written = []
  const ok = writeTitleBarMemory('/u/title-bar.json', true, 'light', { readFileSync() {}, writeFileSync: (f, d) => written.push([f, d]) }, new Date('2026-11-18T19:00:00Z'))
  assert.equal(ok, true)
  assert.deepEqual(written, [['/u/title-bar.json', '{"siteReady":true,"protocol":1,"theme":"light","at":"2026-11-18T19:00:00.000Z"}']])
  assert.equal(writeTitleBarMemory('/u/title-bar.json', false, 'dark', { readFileSync() {}, writeFileSync() { throw new Error('EACCES') } }), false)
})

// ---------------------------------------------------------------------------
// One window: a fake BrowserWindow, driven the way Electron drives it.
// ---------------------------------------------------------------------------

function fakeWindow({ url = 'https://unreleased.world/home' } = {}) {
  const listeners = {}
  const contentsListeners = {}
  const calls = { overlay: [], sent: [], inserted: [], removed: [] }
  let key = 0
  const win = {
    destroyed: false,
    maximized: false,
    fullScreen: false,
    isDestroyed: () => win.destroyed,
    isMaximized: () => win.maximized,
    isFullScreen: () => win.fullScreen,
    setTitleBarOverlay: (o) => calls.overlay.push(o),
    on(event, listener) {
      ;(listeners[event] ||= []).push(listener)
      return win
    },
    webContents: {
      destroyed: false,
      url,
      isDestroyed: () => win.webContents.destroyed,
      getURL: () => win.webContents.url,
      send: (channel, ...args) => calls.sent.push([channel, ...args]),
      insertCSS(css) {
        calls.inserted.push(css)
        return Promise.resolve(`key-${++key}`)
      },
      removeInsertedCSS(k) {
        calls.removed.push(k)
        return Promise.resolve()
      },
      on(event, listener) {
        ;(contentsListeners[event] ||= []).push(listener)
        return win.webContents
      },
    },
  }
  const emit = (event, ...args) => (listeners[event] || []).forEach((l) => l(...args))
  const emitContents = (event, ...args) => (contentsListeners[event] || []).forEach((l) => l(...args))
  return { win, calls, emit, emitContents }
}

/** attachTitleBar with fake timers and a memory that records what it is told. */
function attach(f, { platform = 'win32', mode = 'overlay', remembered = READY } = {}) {
  const timers = []
  const remembers = []
  const themes = []
  const bar = attachTitleBar(f.win, {
    platform,
    mode,
    remembered,
    isSiteUrl: (u) => /^https:\/\/(www\.)?unreleased\.world\//.test(u),
    remember: (v, theme) => remembers.push(v) && themes.push(theme),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      t.cleared = true
    },
  })
  const fire = () => timers.filter((t) => !t.cleared && !t.fired).forEach((t) => ((t.fired = true), t.fn()))
  return { bar, timers, remembers, themes, fire }
}

const settle = () => new Promise((r) => setImmediate(r))

test('the site says ready with its colours: taken, remembered, the buttons recoloured (Windows)', () => {
  const f = fakeWindow()
  const a = attach(f)
  assert.equal(a.bar.mode, 'overlay')
  assert.equal(a.bar.setTheme('light', TITLE_BAR_PROTOCOL), true)
  assert.equal(a.bar.isReady(), true)
  assert.deepEqual(f.calls.overlay, [overlayStyle('light')])
  // Still ready, now in light: remembered, so the next window starts light.
  assert.deepEqual(a.remembers, [true])
  assert.deepEqual(a.themes, ['light'])
  // The same colours again change nothing; new ones do.
  a.bar.setTheme('light', TITLE_BAR_PROTOCOL)
  a.bar.setTheme('dark', TITLE_BAR_PROTOCOL)
  assert.deepEqual(f.calls.overlay, [overlayStyle('light'), overlayStyle('dark')])
  assert.deepEqual(a.themes, ['light', 'dark'])
  // Ready and dark, as remembered at the start: nothing to write.
  const g = fakeWindow()
  const b = attach(g, { remembered: { ...READY, theme: 'dark' } })
  b.bar.setTheme('dark', TITLE_BAR_PROTOCOL)
  assert.deepEqual(b.remembers, [])
})

test('only the two words and this protocol: anything else is refused and changes nothing', () => {
  const f = fakeWindow()
  const a = attach(f)
  for (const [theme, protocol] of [['blue', 1], ['dark', 2], ['dark', '1'], [{ color: '#f00' }, 1], ['#ffffff', 1], [undefined, undefined], ['light', undefined]]) {
    assert.equal(a.bar.setTheme(theme, protocol), false, `${JSON.stringify(theme)} / ${protocol}`)
  }
  assert.equal(a.bar.isReady(), false)
  assert.deepEqual(f.calls.overlay, [])
})

test('a Mac has no colours to set; the word "ready" still counts', () => {
  const f = fakeWindow()
  const a = attach(f, { platform: 'darwin' })
  assert.equal(a.bar.setTheme('light', TITLE_BAR_PROTOCOL), true)
  assert.deepEqual(f.calls.overlay, [])
  assert.equal(a.bar.isReady(), true)
})

test('a framed window whose site says ready: remembered, so the next start has the overlay', () => {
  const f = fakeWindow()
  const a = attach(f, { mode: 'frame', remembered: null })
  assert.equal(a.bar.mode, 'frame')
  f.emitContents('did-finish-load')
  assert.deepEqual(a.timers, [], 'a frame never waits for the page')
  assert.equal(a.bar.setTheme('dark', TITLE_BAR_PROTOCOL), true)
  assert.deepEqual(a.remembers, [true])
  assert.deepEqual(f.calls.overlay, [], 'the frame has no overlay to colour')
  a.bar.setTheme('dark', TITLE_BAR_PROTOCOL)
  assert.deepEqual(a.remembers, [true], 'written once')
})

test('fail-safe: the site never says ready -> a draggable band over the page, and the frame from the next start', async () => {
  const f = fakeWindow()
  const a = attach(f)
  f.emitContents('did-navigate')
  f.emitContents('did-finish-load')
  assert.equal(a.timers.length, 1)
  assert.equal(a.timers[0].ms, READY_GRACE_MS)
  a.fire()
  await settle()
  assert.deepEqual(f.calls.inserted, [EMERGENCY_CSS])
  assert.deepEqual(a.remembers, [false])
  // It says ready after all (a slow start): the band comes off, and the overlay is remembered again.
  assert.equal(a.bar.setTheme('dark', TITLE_BAR_PROTOCOL), true)
  await settle()
  assert.deepEqual(f.calls.removed, ['key-1'])
  assert.deepEqual(a.remembers, [false, true])
})

test('ready in time: no band, nothing written', async () => {
  const f = fakeWindow()
  const a = attach(f)
  f.emitContents('did-navigate')
  f.emitContents('did-finish-load')
  a.bar.setTheme('dark', TITLE_BAR_PROTOCOL)
  a.fire()
  await settle()
  assert.equal(a.timers[0].cleared, true)
  assert.deepEqual(f.calls.inserted, [])
  assert.deepEqual(a.remembers, [])
})

test('each new document has to say it again (a reload, a full navigation)', async () => {
  const f = fakeWindow()
  const a = attach(f)
  a.bar.setTheme('dark', TITLE_BAR_PROTOCOL)
  f.emitContents('did-navigate')
  assert.equal(a.bar.isReady(), false)
  f.emitContents('did-finish-load')
  a.fire()
  await settle()
  assert.deepEqual(f.calls.inserted, [EMERGENCY_CSS])
})

test('a page that failed to load (offline): the band at once, but nothing learned about the site', async () => {
  const f = fakeWindow()
  const a = attach(f)
  f.emitContents('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', 'https://unreleased.world/', true)
  await settle()
  assert.deepEqual(f.calls.inserted, [EMERGENCY_CSS])
  assert.deepEqual(a.remembers, [])
  // A load replaced by another (-3) and a frame inside the page are not failures of the page.
  const g = fakeWindow()
  const b = attach(g)
  g.emitContents('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://unreleased.world/', true)
  g.emitContents('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', 'https://example.com/embed', false)
  await settle()
  assert.deepEqual(g.calls.inserted, [])
  assert.deepEqual(b.remembers, [])
})

test('a page that is not the site gets the band, and the site is not blamed for it', async () => {
  const f = fakeWindow({ url: 'https://example.com/' })
  const a = attach(f)
  f.emitContents('did-finish-load')
  a.fire()
  await settle()
  assert.deepEqual(f.calls.inserted, [EMERGENCY_CSS])
  assert.deepEqual(a.remembers, [])
})

test('the band: fixed, as tall as the buttons, opaque, draggable, on top of everything, last in the page', () => {
  assert.match(EMERGENCY_CSS, /^body::after\{content:"";position:fixed;top:0;left:0;right:0;height:80px;/)
  assert.match(EMERGENCY_CSS, /background:#000;/)
  assert.match(EMERGENCY_CSS, /-webkit-app-region:drag;app-region:drag;/)
  assert.match(EMERGENCY_CSS, /z-index:2147483647/)
  assert.match(EMERGENCY_CSS, /html\{padding-top:80px!important/)
})

test('the page hears the window maximize, restore and enter or leave full screen (overlay only)', () => {
  const f = fakeWindow()
  attach(f)
  f.win.maximized = true
  f.emit('maximize')
  f.win.maximized = false
  f.emit('unmaximize')
  f.win.fullScreen = true
  f.emit('enter-full-screen')
  assert.deepEqual(f.calls.sent, [
    [TITLE_BAR_CHANGED, { maximized: true, fullScreen: false }],
    [TITLE_BAR_CHANGED, { maximized: false, fullScreen: false }],
    [TITLE_BAR_CHANGED, { maximized: false, fullScreen: true }],
  ])
  const g = fakeWindow()
  attach(g, { mode: 'frame', remembered: null })
  g.emit('maximize')
  assert.deepEqual(g.calls.sent, [])
})

test('a closed window is left alone: no send, no band, no throw', async () => {
  const f = fakeWindow()
  const a = attach(f)
  f.emitContents('did-finish-load')
  f.win.destroyed = true
  f.win.webContents.destroyed = true
  f.emit('maximize')
  a.fire()
  await settle()
  assert.equal(a.bar.setTheme('dark', TITLE_BAR_PROTOCOL), false)
  assert.deepEqual(f.calls.sent, [])
  assert.deepEqual(f.calls.inserted, [])
})

// ---------------------------------------------------------------------------
// The preload's window.unrlWindow (version 2), loaded against a fake Electron, window and overlay.
// ---------------------------------------------------------------------------

function loadPreload({ origin = 'https://unreleased.world', mode = 'overlay', platform = 'win32', area = { x: 0, y: 0, width: 1062, height: 80 }, innerWidth = 1200, visible = true } = {}) {
  const exposed = {}
  const invoked = []
  const rendererListeners = {}
  const windowListeners = {}
  const overlayListeners = {}
  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, api) => (exposed[name] = api) },
    ipcRenderer: {
      send() {},
      invoke: async (channel, ...args) => {
        invoked.push([channel, ...args])
        return channel === TITLE_BAR_THEME ? true : null
      },
      on: (channel, listener) => (rendererListeners[channel] ||= []).push(listener),
    },
  }
  const overlay = {
    visible,
    area,
    getTitlebarAreaRect: () => ({ ...overlay.area }),
    addEventListener: (type, l) => (overlayListeners[type] ||= []).push(l),
  }
  const fakeWin = {
    location: { origin },
    innerWidth,
    devicePixelRatio: 1,
    addEventListener: (type, l) => (windowListeners[type] ||= []).push(l),
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  const originalLoad = Module._load
  const realWindow = global.window
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
  const realLog = console.log
  const argv = [`--unrl-allowed-origins=${JSON.stringify(['https://unreleased.world'])}`, `${TITLE_BAR_ARGV_PREFIX}${mode}`]
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad(request, parent, isMain)
  }
  global.window = fakeWin
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { windowControlsOverlay: overlay } })
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  process.argv.push(...argv)
  console.log = () => {}
  try {
    delete require.cache[require.resolve('../dist/preload')]
    require('../dist/preload')
  } finally {
    Module._load = originalLoad
    for (const a of argv) process.argv.splice(process.argv.indexOf(a), 1)
    Object.defineProperty(process, 'platform', platformDesc)
    console.log = realLog
  }
  const restore = () => {
    if (realWindow === undefined) delete global.window
    else global.window = realWindow
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc)
    else delete globalThis.navigator
  }
  const fromMain = (channel, ...args) => (rendererListeners[channel] || []).forEach((l) => l({}, ...args))
  const geometry = () => (overlayListeners.geometrychange || []).forEach((l) => l())
  const resize = () => (windowListeners.resize || []).forEach((l) => l())
  return { api: exposed.unrlWindow, exposed, invoked, overlay, fakeWin, fromMain, geometry, resize, restore }
}

const frame = () => new Promise((r) => setTimeout(r, 40))

test('unrlWindow 2: the full-screen trio plus platform, getTitleBar, onTitleBarChange and setTitleBarTheme, nothing else', () => {
  const p = loadPreload()
  try {
    assert.deepEqual(Object.keys(p.exposed).sort(), ['unrlAuth', 'unrlPresence', 'unrlWindow'])
    assert.deepEqual(Object.keys(p.api).sort(), [
      'exitFullScreen',
      'getTitleBar',
      'isFullScreen',
      'onFullScreenChange',
      'onTitleBarChange',
      'platform',
      'setTitleBarTheme',
      'version',
    ])
    assert.equal(p.api.version, 2)
    assert.equal(p.api.platform, 'win32')
  } finally {
    p.restore()
  }
})

test("Windows: the buttons' box is the window's width right of the overlay's titlebar area", () => {
  const p = loadPreload()
  try {
    assert.deepEqual(p.api.getTitleBar(), {
      overlay: true, protocol: 1, side: 'right', visible: true, x: 1062, y: 0, width: 138, height: 80, maximized: false, fullScreen: false,
    })
  } finally {
    p.restore()
  }
})

test("a Mac: the box is the lights' corner, left of the titlebar area; in full screen they are gone, and so is the room", () => {
  const p = loadPreload({ platform: 'darwin', area: { x: 100, y: 0, width: 1100, height: 80 } })
  try {
    assert.equal(p.api.platform, 'darwin')
    assert.deepEqual(p.api.getTitleBar(), {
      overlay: true, protocol: 1, side: 'left', visible: true, x: 0, y: 0, width: 100, height: 80, maximized: false, fullScreen: false,
    })
    p.overlay.visible = false
    const hidden = p.api.getTitleBar()
    assert.equal(hidden.overlay, true)
    assert.equal(hidden.visible, false)
    assert.deepEqual([hidden.x, hidden.y, hidden.width, hidden.height], [0, 0, 0, 0])
  } finally {
    p.restore()
  }
})

test('a framed window, or a page on another origin, is told "no overlay" and nothing else', async () => {
  const framed = loadPreload({ mode: 'frame' })
  try {
    const s = framed.api.getTitleBar()
    assert.equal(s.overlay, false)
    assert.equal(s.side, null)
    assert.equal(s.visible, false)
  } finally {
    framed.restore()
  }
  const evil = loadPreload({ origin: 'https://evil.example' })
  try {
    assert.equal(evil.api.getTitleBar().overlay, false)
    assert.equal(await evil.api.setTitleBarTheme('dark', 1), false)
    const heard = []
    const off = evil.api.onTitleBarChange((s) => heard.push(s))
    evil.geometry()
    await frame()
    assert.deepEqual(heard, [])
    assert.equal(typeof off, 'function')
    assert.deepEqual(evil.invoked, [])
  } finally {
    evil.restore()
  }
})

test('setTitleBarTheme sends only "dark" or "light" in protocol 1, and answers with a boolean', async () => {
  const p = loadPreload()
  try {
    assert.equal(await p.api.setTitleBarTheme('light', 1), true)
    assert.equal(await p.api.setTitleBarTheme('dark'), true, 'the protocol defaults to 1')
    for (const [theme, protocol] of [['red', 1], ['dark', 2], [{}, 1], ['light', '1']]) {
      assert.equal(await p.api.setTitleBarTheme(theme, protocol), false)
    }
    assert.deepEqual(p.invoked, [[TITLE_BAR_THEME, 'light', 1], [TITLE_BAR_THEME, 'dark', 1]])
  } finally {
    p.restore()
  }
})

test('onTitleBarChange: the new box on a geometry change, a resize or a window change from main; nothing when unchanged', async () => {
  const p = loadPreload()
  try {
    const heard = []
    const off = p.api.onTitleBarChange((s) => heard.push(s))
    p.geometry()
    await frame()
    assert.deepEqual(heard, [], 'nothing changed')
    // Maximized: the overlay grows a pixel.
    p.overlay.area = { x: 0, y: 0, width: 1062, height: 81 }
    p.fromMain(TITLE_BAR_CHANGED, { maximized: true, fullScreen: false })
    await frame()
    assert.equal(heard.length, 1)
    assert.equal(heard[0].height, 81)
    assert.equal(heard[0].maximized, true)
    // A zoom to 125%: the same window, fewer CSS pixels.
    p.overlay.area = { x: 0, y: 0, width: 849.6, height: 64 }
    p.fakeWin.innerWidth = 960
    p.resize()
    p.geometry()
    await frame()
    assert.equal(heard.length, 2, 'one read for both events')
    assert.equal(heard[1].height, 64)
    assert.ok(Math.abs(heard[1].width - 110.4) < 1e-9)
    // Full screen (the buttons hidden).
    p.overlay.visible = false
    p.fromMain(TITLE_BAR_CHANGED, { maximized: false, fullScreen: true })
    await frame()
    assert.equal(heard[2].visible, false)
    assert.equal(heard[2].fullScreen, true)
    off()
    p.overlay.visible = true
    p.geometry()
    await frame()
    assert.equal(heard.length, 3, 'unsubscribed')
    // A listener that throws does not stop the others; main's malformed message is ignored.
    const later = []
    p.api.onTitleBarChange(() => {
      throw new Error('a broken listener')
    })
    p.api.onTitleBarChange((s) => later.push(s))
    const realError = console.error
    console.error = () => {}
    try {
      p.fromMain(TITLE_BAR_CHANGED, 'maximized')
      p.overlay.area = { x: 0, y: 0, width: 800, height: 80 }
      p.geometry()
      await frame()
    } finally {
      console.error = realError
    }
    assert.equal(later.length, 1)
    assert.equal(later[0].width, 160)
  } finally {
    p.restore()
  }
})

// ---------------------------------------------------------------------------
// The wiring in main.ts.
// ---------------------------------------------------------------------------

test('main.ts: the mode is decided before the window, its options go into the window, and the preload is told', () => {
  const main = code('app/main.ts')
  const create = main.slice(main.indexOf('function createWindow('), main.indexOf('function setupIPC('))
  assert.match(create, /titleBarMode = titleBarModeFor\(process\.platform, titleBarRemembered\)/)
  assert.match(create, /titleBarOptions = titleBarWindowOptions\(process\.platform, titleBarMode, titleBarRemembered\?\.theme\)/)
  // A throw there means the frame, not a missing window.
  assert.match(create, /\} catch \(error\) \{[^}]*titleBarMode = 'frame'\s*titleBarOptions = \{\}/)
  assert.match(create, /const makeWindow = \(mode: TitleBarMode, extra: ReturnType<typeof titleBarWindowOptions>\) => new BrowserWindow\(\{[\s\S]*?\.\.\.extra,/)
  assert.match(create, /TITLE_BAR_ARGV_PREFIX \+ mode/)
  // A window that cannot be made with the overlay is made with the frame, never left out.
  assert.match(create, /try \{\s*mainWindow = makeWindow\(titleBarMode, titleBarOptions\)\s*\} catch \(error\) \{\s*if \(titleBarMode === 'frame'\) throw error[\s\S]*?titleBarMode = 'frame'\s*titleBarOptions = \{\}\s*mainWindow = makeWindow\(titleBarMode, titleBarOptions\)/)
})

test('main.ts: the title bar is wired inside a try, before the page loads, and forgotten with the window', () => {
  const main = code('app/main.ts')
  const create = main.slice(main.indexOf('function createWindow('), main.indexOf('function setupIPC('))
  assert.match(create, /try \{\s*titleBar = attachTitleBar\(mainWindow, \{/)
  assert.ok(create.indexOf('attachTitleBar(mainWindow') < create.indexOf('mainWindow.loadURL('))
  assert.match(create, /isSiteUrl: \(url\) => isOriginAllowed\(url, ALLOWED_ORIGINS\)/)
  assert.match(create, /mainWindow\.on\('closed', \(\) => \{[^}]*titleBar = null/)
})

test("main answers the colours only for the main window's own page, on an allowed origin", () => {
  const main = code('app/main.ts')
  const start = main.indexOf(`ipcMain.handle('${TITLE_BAR_THEME}'`)
  assert.ok(start > -1, 'no title-bar handler')
  const body = main.slice(start, main.indexOf('})', start) + 2)
  assert.match(body, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\) \|\| event\.sender !== mainWindow\.webContents\) return false/)
  assert.match(body, /if \(!isOriginAllowed\(event\.senderFrame\?\.url, ALLOWED_ORIGINS\)\) return false/)
  assert.match(body, /return titleBar \? titleBar\.setTheme\(theme, protocol\) : false/)
})

test('main, the preload and titleBar.ts name the same channels, argument and protocol', () => {
  const preload = code('app/preload.ts')
  assert.ok(preload.includes(`ipcRenderer.invoke('${TITLE_BAR_THEME}', theme, protocol)`))
  assert.ok(preload.includes(`ipcRenderer.on('${TITLE_BAR_CHANGED}'`))
  assert.ok(preload.includes(`const TITLE_BAR_ARGV_PREFIX = '${TITLE_BAR_ARGV_PREFIX}'`))
  assert.ok(preload.includes(`const TITLE_BAR_PROTOCOL = ${TITLE_BAR_PROTOCOL}`))
})
