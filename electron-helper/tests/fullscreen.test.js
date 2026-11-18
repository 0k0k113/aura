// tests/fullscreen.test.js
//
// The way out of full screen (app/fullscreen.ts). A Windows member was stuck in
// full screen on 2026-11-18: no title bar, no menu bar (hidden since 1.0.8),
// Esc did nothing, and the Windows key only showed the taskbar. So: Esc leaves
// full screen, only while the window is in it (every other Esc is the page's);
// F11 keeps toggling; and the site gets a tiny, origin-checked window.unrlWindow
// to draw its own "Exit full screen" button.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const {
  FULL_SCREEN_CHANGED,
  IS_FULL_SCREEN,
  EXIT_FULL_SCREEN,
  LEAVE_HTML_FULL_SCREEN,
  isPlainEscape,
  shouldLeaveFullScreen,
  attachFullScreenExit,
} = require('../dist/fullscreen')

const ROOT = path.join(__dirname, '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
/** A TS file without its comments, so a match is code and not a sentence about it. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const ESC = { type: 'keyDown', key: 'Escape' }

// ---------------------------------------------------------------------------
// Which key presses count.
// ---------------------------------------------------------------------------

test('a plain Esc press is the way out', () => {
  assert.equal(isPlainEscape(ESC), true)
  assert.equal(isPlainEscape({ ...ESC, isAutoRepeat: false, shift: false, control: false, alt: false, meta: false }), true)
})

test('only the press itself: not the key coming up, not a held key repeating, not with a modifier', () => {
  assert.equal(isPlainEscape({ ...ESC, type: 'keyUp' }), false)
  assert.equal(isPlainEscape({ ...ESC, isAutoRepeat: true }), false)
  for (const modifier of ['shift', 'control', 'alt', 'meta']) {
    assert.equal(isPlainEscape({ ...ESC, [modifier]: true }), false, `Esc with ${modifier}`)
  }
})

test('no other key: F11 stays the menu shortcut, letters stay the page', () => {
  for (const key of ['F11', 'Esc', 'q', 'Enter', ' ', 'Backspace']) {
    assert.equal(isPlainEscape({ type: 'keyDown', key }), false, key)
  }
})

test('Esc leaves full screen only while the window is full screen', () => {
  assert.equal(shouldLeaveFullScreen(ESC, true), true)
  assert.equal(shouldLeaveFullScreen(ESC, false), false)
})

// ---------------------------------------------------------------------------
// The window: a fake BrowserWindow, driven the way Electron drives it.
// ---------------------------------------------------------------------------

function fakeWindow({ fullScreen = false } = {}) {
  const listeners = {}
  const contentsListeners = {}
  const calls = { setFullScreen: [], sent: [], scripts: [] }
  const win = {
    destroyed: false,
    fullScreen,
    isDestroyed: () => win.destroyed,
    isFullScreen: () => win.fullScreen,
    setFullScreen(flag) {
      calls.setFullScreen.push(flag)
      win.fullScreen = flag
    },
    on(event, listener) {
      ;(listeners[event] ||= []).push(listener)
      return win
    },
    webContents: {
      destroyed: false,
      isDestroyed: () => win.webContents.destroyed,
      send: (channel, ...args) => calls.sent.push([channel, ...args]),
      executeJavaScript(script) {
        calls.scripts.push(script)
        return Promise.resolve(true)
      },
      on(event, listener) {
        ;(contentsListeners[event] ||= []).push(listener)
        return win.webContents
      },
    },
  }
  const emit = (event) => (listeners[event] || []).forEach((l) => l())
  /** A key press as before-input-event delivers it; true when it was kept from the page and the menu. */
  const press = (input) => {
    let prevented = false
    for (const l of contentsListeners['before-input-event'] || []) l({ preventDefault: () => (prevented = true) }, input)
    return prevented
  }
  return { win, calls, emit, press, listeners, contentsListeners }
}

test('Esc in F11 full screen leaves it, and the page never sees that Esc', () => {
  const f = fakeWindow({ fullScreen: true })
  attachFullScreenExit(f.win)
  assert.equal(f.press(ESC), true)
  assert.deepEqual(f.calls.setFullScreen, [false])
  // Not HTML full screen: the page's own exit is not needed.
  assert.deepEqual(f.calls.scripts, [])
})

test('Esc outside full screen is the page\'s: not prevented, nothing changed', () => {
  const f = fakeWindow({ fullScreen: false })
  attachFullScreenExit(f.win)
  assert.equal(f.press(ESC), false)
  assert.deepEqual(f.calls.setFullScreen, [])
  assert.deepEqual(f.calls.scripts, [])
})

test('F11 is never touched, in or out of full screen (the hidden menu toggles with it)', () => {
  for (const fullScreen of [true, false]) {
    const f = fakeWindow({ fullScreen })
    attachFullScreenExit(f.win)
    assert.equal(f.press({ type: 'keyDown', key: 'F11' }), false)
    assert.deepEqual(f.calls.setFullScreen, [])
  }
})

test('a held Esc leaves once; the repeats after it are the page\'s again', () => {
  const f = fakeWindow({ fullScreen: true })
  attachFullScreenExit(f.win)
  assert.equal(f.press(ESC), true)
  assert.equal(f.press({ ...ESC, isAutoRepeat: true }), false)
  assert.equal(f.press({ ...ESC, type: 'keyUp' }), false)
  assert.deepEqual(f.calls.setFullScreen, [false])
})

test("Esc in a video's full screen also ends the page's own full screen", () => {
  const f = fakeWindow({ fullScreen: false })
  attachFullScreenExit(f.win)
  f.win.fullScreen = true
  f.emit('enter-html-full-screen')
  assert.equal(f.press(ESC), true)
  assert.deepEqual(f.calls.scripts, [LEAVE_HTML_FULL_SCREEN])
  assert.deepEqual(f.calls.setFullScreen, [false])
  // The script is fixed, and only ever leaves: no page data goes into it.
  assert.match(LEAVE_HTML_FULL_SCREEN, /^document\.fullscreenElement \? document\.exitFullscreen\(\)/)
})

test('the page hears every change, with the state the window is in', () => {
  const f = fakeWindow({ fullScreen: false })
  attachFullScreenExit(f.win)
  f.win.fullScreen = true
  f.emit('enter-full-screen')
  f.win.fullScreen = false
  f.emit('leave-full-screen')
  f.win.fullScreen = true
  f.emit('enter-html-full-screen')
  f.win.fullScreen = false
  f.emit('leave-html-full-screen')
  assert.deepEqual(f.calls.sent, [
    [FULL_SCREEN_CHANGED, true],
    [FULL_SCREEN_CHANGED, false],
    [FULL_SCREEN_CHANGED, true],
    [FULL_SCREEN_CHANGED, false],
  ])
})

test('leave() says whether there was anything to leave', () => {
  const f = fakeWindow({ fullScreen: false })
  const exit = attachFullScreenExit(f.win)
  assert.equal(exit.leave(), false)
  assert.deepEqual(f.calls.setFullScreen, [])
  f.win.fullScreen = true
  assert.equal(exit.leave(), true)
  assert.deepEqual(f.calls.setFullScreen, [false])
})

test('a closed window is left alone: no send, no throw', () => {
  const f = fakeWindow({ fullScreen: true })
  const exit = attachFullScreenExit(f.win)
  f.win.destroyed = true
  f.win.webContents.destroyed = true
  f.emit('leave-full-screen')
  assert.equal(f.press(ESC), false)
  assert.equal(exit.leave(), false)
  assert.deepEqual(f.calls.sent, [])
  assert.deepEqual(f.calls.setFullScreen, [])
})

// ---------------------------------------------------------------------------
// The preload's window.unrlWindow, loaded against a fake Electron and window.
// ---------------------------------------------------------------------------

function loadPreload(origin) {
  const exposed = {}
  const invoked = []
  const rendererListeners = {}
  const answers = { [IS_FULL_SCREEN]: true, [EXIT_FULL_SCREEN]: true }
  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, api) => (exposed[name] = api) },
    ipcRenderer: {
      send() {},
      invoke: async (channel, ...args) => {
        invoked.push([channel, ...args])
        return answers[channel] ?? null
      },
      on: (channel, listener) => (rendererListeners[channel] ||= []).push(listener),
    },
  }
  const originalLoad = Module._load
  const realWindow = global.window
  const realLog = console.log
  const argv = `--unrl-allowed-origins=${JSON.stringify(['https://unreleased.world'])}`
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad(request, parent, isMain)
  }
  global.window = { location: { origin } }
  process.argv.push(argv)
  console.log = () => {}
  try {
    delete require.cache[require.resolve('../dist/preload')]
    require('../dist/preload')
  } finally {
    Module._load = originalLoad
    process.argv.splice(process.argv.indexOf(argv), 1)
    console.log = realLog
  }
  const restore = () => {
    if (realWindow === undefined) delete global.window
    else global.window = realWindow
  }
  /** main sending on a channel, as webContents.send does. */
  const fromMain = (channel, ...args) => (rendererListeners[channel] || []).forEach((l) => l({}, ...args))
  return { api: exposed.unrlWindow, exposed, invoked, answers, fromMain, restore }
}

test('the preload exposes unrlWindow with exactly four things, next to the bridges it had', () => {
  const p = loadPreload('https://unreleased.world')
  try {
    assert.deepEqual(Object.keys(p.exposed).sort(), ['unrlAuth', 'unrlPresence', 'unrlWindow'])
    assert.deepEqual(Object.keys(p.api).sort(), ['exitFullScreen', 'isFullScreen', 'onFullScreenChange', 'version'])
    assert.equal(p.api.version, 1)
  } finally {
    p.restore()
  }
})

test('isFullScreen and exitFullScreen ask main, and answer with a boolean only', async () => {
  const p = loadPreload('https://www.unreleased.world')
  try {
    assert.equal(await p.api.isFullScreen(), true)
    assert.equal(await p.api.exitFullScreen(), true)
    assert.deepEqual(p.invoked, [[IS_FULL_SCREEN], [EXIT_FULL_SCREEN]])
    p.answers[IS_FULL_SCREEN] = { anything: 'else' }
    assert.equal(await p.api.isFullScreen(), false)
  } finally {
    p.restore()
  }
})

test('onFullScreenChange hears booleans from main, nothing else, until unsubscribed', () => {
  const p = loadPreload('https://unreleased.world')
  try {
    const heard = []
    const off = p.api.onFullScreenChange((value) => heard.push(value))
    p.fromMain(FULL_SCREEN_CHANGED, true)
    p.fromMain(FULL_SCREEN_CHANGED, 'yes')
    p.fromMain(FULL_SCREEN_CHANGED, false)
    off()
    p.fromMain(FULL_SCREEN_CHANGED, true)
    assert.deepEqual(heard, [true, false])
    // A listener that throws does not stop the others.
    const later = []
    p.api.onFullScreenChange(() => {
      throw new Error('a broken listener')
    })
    p.api.onFullScreenChange((value) => later.push(value))
    const realError = console.error
    console.error = () => {}
    try {
      p.fromMain(FULL_SCREEN_CHANGED, true)
    } finally {
      console.error = realError
    }
    assert.deepEqual(later, [true])
  } finally {
    p.restore()
  }
})

test('a page on any other origin gets nothing: no question to main, no events', async () => {
  const p = loadPreload('https://evil.example')
  try {
    assert.equal(await p.api.isFullScreen(), false)
    assert.equal(await p.api.exitFullScreen(), false)
    assert.deepEqual(p.invoked, [])
    const heard = []
    const off = p.api.onFullScreenChange((value) => heard.push(value))
    p.fromMain(FULL_SCREEN_CHANGED, true)
    assert.deepEqual(heard, [])
    assert.equal(typeof off, 'function')
  } finally {
    p.restore()
  }
})

// ---------------------------------------------------------------------------
// The wiring in main.ts and the preload.
// ---------------------------------------------------------------------------

test('main.ts wires the exit into every window it makes, inside a try', () => {
  const main = code('app/main.ts')
  const create = main.slice(main.indexOf('function createWindow('), main.indexOf('function setupIPC('))
  assert.match(create, /try \{\s*fullScreenExit = attachFullScreenExit\(mainWindow\)\s*\} catch/)
  // Before the page loads: a window must never be up without its way out.
  assert.ok(create.indexOf('attachFullScreenExit(mainWindow)') < create.indexOf('mainWindow.loadURL('))
  assert.match(create, /mainWindow\.on\('closed', \(\) => \{\s*mainWindow = null\s*fullScreenExit = null/)
})

test("main answers only the main window's own page, on an allowed origin", () => {
  const main = code('app/main.ts')
  for (const channel of [IS_FULL_SCREEN, EXIT_FULL_SCREEN]) {
    const start = main.indexOf(`ipcMain.handle('${channel}'`)
    assert.ok(start > -1, `no ${channel} handler`)
    const body = main.slice(start, main.indexOf('})', start) + 2)
    assert.match(body, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\) \|\| event\.sender !== mainWindow\.webContents\) return false/)
    assert.match(body, /if \(!isOriginAllowed\(event\.senderFrame\?\.url, ALLOWED_ORIGINS\)\) return false/)
  }
})

test('main, the preload and fullscreen.ts name the same three channels', () => {
  const main = code('app/main.ts')
  const preload = code('app/preload.ts')
  assert.ok(main.includes(`ipcMain.handle('${IS_FULL_SCREEN}'`))
  assert.ok(main.includes(`ipcMain.handle('${EXIT_FULL_SCREEN}'`))
  assert.ok(preload.includes(`ipcRenderer.invoke('${IS_FULL_SCREEN}')`))
  assert.ok(preload.includes(`ipcRenderer.invoke('${EXIT_FULL_SCREEN}')`))
  assert.ok(preload.includes(`ipcRenderer.on('${FULL_SCREEN_CHANGED}'`))
  assert.match(preload, /contextBridge\.exposeInMainWorld\('unrlWindow', unrlWindowAPI\)/)
})

test('F11 keeps working: the default menu, with its full-screen shortcut, is never replaced', () => {
  const main = code('app/main.ts')
  assert.doesNotMatch(main, /Menu\.setApplicationMenu|\.removeMenu\(|\.setMenu\(/)
  assert.match(main, /mainWindow\.setMenuBarVisibility\(false\)/)
})
