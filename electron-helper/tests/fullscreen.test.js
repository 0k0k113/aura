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
  TYPING,
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

test("1.0.14: while a text field has the cursor, Esc is the field's, not the way out", () => {
  assert.equal(shouldLeaveFullScreen(ESC, true, true), false)
  assert.equal(shouldLeaveFullScreen(ESC, true, false), true)
  assert.equal(shouldLeaveFullScreen(ESC, false, true), false)
  // Only a real true holds Esc back.
  for (const notTrue of ['true', 1, {}, null, undefined]) assert.equal(shouldLeaveFullScreen(ESC, true, notTrue), true, String(notTrue))
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
  /** An event of the window's page (webContents), with the arguments Electron passes. */
  const emitContents = (event, ...args) => (contentsListeners[event] || []).forEach((l) => l(...args))
  /** A key press as before-input-event delivers it; true when it was kept from the page and the menu. */
  const press = (input) => {
    let prevented = false
    for (const l of contentsListeners['before-input-event'] || []) l({ preventDefault: () => (prevented = true) }, input)
    return prevented
  }
  return { win, calls, emit, emitContents, press, listeners, contentsListeners }
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
// 1.0.14: Esc in a text field is the field's (the full player's Search box
// clears with it, then lets go of the cursor); the next Esc leaves.
// ---------------------------------------------------------------------------

test("a typing window's Esc reaches the page and the window stays full screen; after setTyping(false), Esc leaves", () => {
  const f = fakeWindow({ fullScreen: true })
  const exit = attachFullScreenExit(f.win)
  exit.setTyping(true)
  assert.equal(f.press(ESC), false, 'the Search box clears')
  assert.equal(f.press(ESC), false, 'and lets go of the cursor')
  assert.deepEqual(f.calls.setFullScreen, [])
  assert.deepEqual(f.calls.scripts, [])
  assert.equal(f.win.fullScreen, true)
  exit.setTyping(false)
  assert.equal(f.press(ESC), true, 'no field focused: the way out, as before')
  assert.deepEqual(f.calls.setFullScreen, [false])
})

test("typing holds Esc in a video's full screen too, and F11 is untouched either way", () => {
  const f = fakeWindow({ fullScreen: false })
  const exit = attachFullScreenExit(f.win)
  f.win.fullScreen = true
  f.emit('enter-html-full-screen')
  exit.setTyping(true)
  assert.equal(f.press(ESC), false)
  assert.equal(f.press({ type: 'keyDown', key: 'F11' }), false)
  assert.deepEqual(f.calls.scripts, [])
  assert.deepEqual(f.calls.setFullScreen, [])
  exit.setTyping(false)
  assert.equal(f.press(ESC), true)
  assert.deepEqual(f.calls.scripts, [LEAVE_HTML_FULL_SCREEN])
})

test('setTyping takes the boolean true and nothing else: any other payload means false', () => {
  for (const payload of ['true', 1, {}, [], null, undefined]) {
    const f = fakeWindow({ fullScreen: true })
    attachFullScreenExit(f.win).setTyping(payload)
    assert.equal(f.press(ESC), true, `${JSON.stringify(payload)} is not typing`)
  }
  // And a non-boolean takes back an earlier true.
  const f = fakeWindow({ fullScreen: true })
  const exit = attachFullScreenExit(f.win)
  exit.setTyping(true)
  exit.setTyping('yes')
  assert.equal(f.press(ESC), true)
})

test('typing starts over at false when another document takes the page (a navigation or reload, an error page, a dead renderer) or the page stops answering', () => {
  const replaced = [
    ['did-navigate', {}, 'https://unreleased.world/', 200, 'OK'],
    ['did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', 'https://unreleased.world/', true],
    ['render-process-gone', {}, { reason: 'crashed', exitCode: 1 }],
    ['unresponsive'],
  ]
  for (const [event, ...args] of replaced) {
    const f = fakeWindow({ fullScreen: true })
    const exit = attachFullScreenExit(f.win)
    exit.setTyping(true)
    f.emitContents(event, ...args)
    assert.equal(f.press(ESC), true, `${event}: Esc leaves again`)
  }
})

test("the same document keeps its typing: the site's own page changes (pushState), a frame inside it failing to load", () => {
  const f = fakeWindow({ fullScreen: true })
  const exit = attachFullScreenExit(f.win)
  exit.setTyping(true)
  f.emitContents('did-navigate-in-page', {}, 'https://unreleased.world/yeat', true)
  f.emitContents('did-fail-load', {}, -2, 'ERR_FAILED', 'https://challenges.cloudflare.com/x', false)
  assert.equal(f.press(ESC), false)
})

test('leaving full screen forgets the typing, however it was left: F11, the Exit pill, a video', () => {
  // F11 (or the hidden menu) out, then back in: the page has not said anything since.
  const f = fakeWindow({ fullScreen: true })
  const exit = attachFullScreenExit(f.win)
  exit.setTyping(true)
  f.win.fullScreen = false
  f.emit('leave-full-screen')
  f.win.fullScreen = true
  f.emit('enter-full-screen')
  assert.equal(f.press(ESC), true)
  assert.equal(f.win.fullScreen, false, 'that Esc left')
  // The site's Exit full screen pill (leave()), the same.
  f.win.fullScreen = true
  f.emit('enter-full-screen')
  exit.setTyping(true)
  assert.equal(exit.leave(), true)
  f.emit('leave-full-screen')
  f.win.fullScreen = true
  f.emit('enter-full-screen')
  assert.equal(f.press(ESC), true)
  // A video's full screen, left by the page itself.
  const v = fakeWindow({ fullScreen: false })
  const videoExit = attachFullScreenExit(v.win)
  v.win.fullScreen = true
  v.emit('enter-html-full-screen')
  videoExit.setTyping(true)
  v.win.fullScreen = false
  v.emit('leave-html-full-screen')
  v.win.fullScreen = true
  v.emit('enter-full-screen')
  assert.equal(v.press(ESC), true)
})

test('the page still hears every change, so its preload can say the typing again (main forgot it)', () => {
  const f = fakeWindow({ fullScreen: true })
  const exit = attachFullScreenExit(f.win)
  exit.setTyping(true)
  f.win.fullScreen = false
  f.emit('leave-full-screen')
  assert.deepEqual(f.calls.sent, [[FULL_SCREEN_CHANGED, false]])
  // The preload's answer (still in the field), then F11 back in: the field keeps its Esc.
  exit.setTyping(true)
  f.win.fullScreen = true
  f.emit('enter-full-screen')
  assert.equal(f.press(ESC), false)
})

// ---------------------------------------------------------------------------
// The preload's window.unrlWindow, loaded against a fake Electron and window.
// ---------------------------------------------------------------------------

/** A page element as the preload reads it: its tag, an input's type, editable or not, a role, an open shadow root. */
function el(tagName, { type, editable = false, role = null, shadowRoot = null } = {}) {
  return { tagName, type, isContentEditable: editable, shadowRoot, getAttribute: (name) => (name === 'role' ? role : null) }
}

function loadPreload(origin) {
  const exposed = {}
  const invoked = []
  const sent = []
  const rendererListeners = {}
  const windowListeners = {}
  const answers = { [IS_FULL_SCREEN]: true, [EXIT_FULL_SCREEN]: true }
  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, api) => (exposed[name] = api) },
    ipcRenderer: {
      send: (channel, ...args) => sent.push([channel, ...args]),
      invoke: async (channel, ...args) => {
        invoked.push([channel, ...args])
        return answers[channel] ?? null
      },
      on: (channel, listener) => (rendererListeners[channel] ||= []).push(listener),
    },
  }
  const body = el('BODY')
  const doc = { body, activeElement: body }
  const originalLoad = Module._load
  const realWindow = global.window
  const realDocument = global.document
  const realLog = console.log
  const argv = `--unrl-allowed-origins=${JSON.stringify(['https://unreleased.world'])}`
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad(request, parent, isMain)
  }
  global.window = {
    location: { origin },
    addEventListener: (type, listener, capture) => (windowListeners[type] ||= []).push({ listener, capture }),
  }
  global.document = doc
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
    if (realDocument === undefined) delete global.document
    else global.document = realDocument
  }
  /** main sending on a channel, as webContents.send does. */
  const fromMain = (channel, ...args) => (rendererListeners[channel] || []).forEach((l) => l({}, ...args))
  /** A DOM event reaching the window's listeners. */
  const fire = (type, event = {}) => (windowListeners[type] || []).forEach(({ listener }) => listener(event))
  /** The cursor moving to `element` (null: to nothing), with the events a page sees: focusout, then focusin. */
  const focus = (element) => {
    const from = doc.activeElement
    doc.activeElement = body
    if (from !== body) fire('focusout')
    if (element) {
      doc.activeElement = element
      fire('focusin')
    }
  }
  /** What the preload told main on 'window:typing', in order. */
  const typing = () => sent.filter(([channel]) => channel === TYPING).map(([, value]) => value)
  return { api: exposed.unrlWindow, exposed, invoked, answers, fromMain, restore, sent, typing, fire, focus, doc, body, windowListeners }
}

/** Lets the preload's deferred checks (after a focusout, after an Esc) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

test('the preload exposes unrlWindow with the full-screen trio, next to the bridges it had (1.0.13 adds the title bar: tests/titleBar.test.js)', () => {
  const p = loadPreload('https://unreleased.world')
  try {
    assert.deepEqual(Object.keys(p.exposed).sort(), ['unrlAuth', 'unrlPresence', 'unrlWindow'])
    for (const key of ['exitFullScreen', 'isFullScreen', 'onFullScreenChange', 'version']) assert.ok(key in p.api, key)
    assert.equal(p.api.version, 2)
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
// 1.0.14: the preload tells main whether a text field has the cursor.
// ---------------------------------------------------------------------------

test('the preload tells main when a text field gets and loses the cursor: booleans, once per change', async () => {
  const p = loadPreload('https://unreleased.world')
  try {
    // Capture-phase listeners on the window, so a field that stops the event still counts.
    for (const type of ['focusin', 'focusout', 'keydown']) {
      assert.ok(p.windowListeners[type]?.every(({ capture }) => capture === true), type)
    }
    const search = el('INPUT', { type: 'search' })
    p.focus(search)
    assert.deepEqual(p.typing(), [true])
    // Tab to another field: focusout then focusin, and nothing to say.
    p.focus(el('TEXTAREA'))
    await settle()
    assert.deepEqual(p.typing(), [true])
    // To a button (the site's Esc on an empty Search box moves to the Search tab).
    p.focus(el('BUTTON'))
    await settle()
    assert.deepEqual(p.typing(), [true, false])
    // Back in the box, then a click on nothing.
    p.focus(search)
    p.focus(null)
    assert.deepEqual(p.typing(), [true, false, true], 'decided once the cursor has landed')
    await settle()
    assert.deepEqual(p.typing(), [true, false, true, false])
    for (const value of p.typing()) assert.equal(typeof value, 'boolean')
  } finally {
    p.restore()
  }
})

test('what counts as a text field: what takes typing, not the inputs that are buttons and switches', () => {
  const field = el('INPUT', { type: 'text' })
  const cases = [
    ['text input', el('INPUT', { type: 'text' }), true],
    ['search input', el('INPUT', { type: 'search' }), true],
    ['email input', el('INPUT', { type: 'email' }), true],
    ['password input', el('INPUT', { type: 'password' }), true],
    ['number input', el('INPUT', { type: 'number' }), true],
    ['date input', el('INPUT', { type: 'date' }), true],
    ['textarea', el('TEXTAREA'), true],
    ['select', el('SELECT'), true],
    ['contenteditable', el('DIV', { editable: true }), true],
    ["the site's plaintext-only editor (role textbox)", el('SPAN', { editable: true, role: 'textbox' }), true],
    ['role textbox', el('DIV', { role: 'textbox' }), true],
    ['inside an open shadow root', el('UW-FIELD', { shadowRoot: { activeElement: field } }), true],
    ['two open shadow roots deep', el('UW-A', { shadowRoot: { activeElement: el('UW-B', { shadowRoot: { activeElement: field } }) } }), true],
    ['a closed shadow root: only its host is seen', el('UW-FIELD', { shadowRoot: null }), false],
    ['an editable host of a closed shadow root', el('UW-EDITOR', { editable: true }), true],
    ['button', el('BUTTON'), false],
    ['link', el('A'), false],
    ['an iframe (its fields are its own page)', el('IFRAME'), false],
    ['contenteditable="false"', el('DIV', { editable: false }), false],
  ]
  for (const type of ['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'image', 'file']) {
    cases.push([`${type} input`, el('INPUT', { type }), false])
  }
  for (const [name, element, expected] of cases) {
    const p = loadPreload('https://unreleased.world')
    try {
      p.focus(element)
      // The preload starts at false (so does main, for a new page): only true is news.
      assert.deepEqual(p.typing(), expected ? [true] : [], name)
    } finally {
      p.restore()
    }
  }
})

test("after an Esc the page heard, the preload looks again: a field taken away with the cursor in it is not left 'typing'", async () => {
  const p = loadPreload('https://unreleased.world')
  try {
    p.focus(el('INPUT', { type: 'search' }))
    assert.deepEqual(p.typing(), [true])
    // The field is removed from the page with the cursor in it: no focusout, the cursor is on nothing.
    p.doc.activeElement = p.body
    p.fire('keydown', { key: 'Escape' })
    assert.deepEqual(p.typing(), [true], 'after the page has acted on that Esc, not before')
    await settle()
    assert.deepEqual(p.typing(), [true, false], 'so the next Esc leaves full screen')
    // Other keys do not look.
    p.fire('keydown', { key: 'a' })
    await settle()
    assert.deepEqual(p.typing(), [true, false])
  } finally {
    p.restore()
  }
})

test('at every full-screen change the preload says it again, since main forgets it on the way out', () => {
  const p = loadPreload('https://unreleased.world')
  try {
    p.focus(el('INPUT', { type: 'search' }))
    p.fromMain(FULL_SCREEN_CHANGED, false)
    p.fromMain(FULL_SCREEN_CHANGED, true)
    assert.deepEqual(p.typing(), [true, true, true])
    p.focus(null)
    p.fromMain(FULL_SCREEN_CHANGED, false)
    assert.deepEqual(p.typing().slice(3), [false])
  } finally {
    p.restore()
  }
})

test('a page on any other origin never tells main about its fields', async () => {
  const p = loadPreload('https://evil.example')
  try {
    p.focus(el('INPUT', { type: 'text' }))
    p.fire('keydown', { key: 'Escape' })
    p.fromMain(FULL_SCREEN_CHANGED, true)
    p.focus(null)
    await settle()
    assert.deepEqual(p.sent, [])
  } finally {
    p.restore()
  }
})

test('a preload that cannot watch the cursor still loads, and never says true', () => {
  // The 1.0.13 harness's window: no addEventListener, no document.
  const realWindow = global.window
  const realDocument = global.document
  const originalLoad = Module._load
  const realLog = console.log
  const realError = console.error
  const sent = []
  const exposed = {}
  const argv = `--unrl-allowed-origins=${JSON.stringify(['https://unreleased.world'])}`
  const listeners = {}
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (name, api) => (exposed[name] = api) },
        ipcRenderer: { send: (...args) => sent.push(args), invoke: async () => null, on: (c, l) => (listeners[c] ||= []).push(l) },
      }
    }
    return originalLoad(request, parent, isMain)
  }
  global.window = { location: { origin: 'https://unreleased.world' } }
  delete global.document
  process.argv.push(argv)
  console.log = () => {}
  console.error = () => {}
  try {
    delete require.cache[require.resolve('../dist/preload')]
    require('../dist/preload')
    assert.deepEqual(Object.keys(exposed).sort(), ['unrlAuth', 'unrlPresence', 'unrlWindow'])
    ;(listeners[FULL_SCREEN_CHANGED] || []).forEach((l) => l({}, true))
    assert.deepEqual(sent, [])
  } finally {
    Module._load = originalLoad
    process.argv.splice(process.argv.indexOf(argv), 1)
    console.log = realLog
    console.error = realError
    if (realWindow === undefined) delete global.window
    else global.window = realWindow
    if (realDocument !== undefined) global.document = realDocument
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

test("main takes the typing word only from the main window's own page, on an allowed origin, and only a true is true", () => {
  const main = code('app/main.ts')
  const start = main.indexOf(`ipcMain.on('${TYPING}'`)
  assert.ok(start > -1, `no ${TYPING} handler`)
  const body = main.slice(start, main.indexOf('})', start) + 2)
  // The same two checks as the window:* handlers above, in the same order, before anything else.
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
  assert.equal(lines[1], 'if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return')
  assert.equal(lines[2], 'if (!isOriginAllowed(event.senderFrame?.url, ALLOWED_ORIGINS)) return')
  assert.equal(lines[3], 'fullScreenExit?.setTyping(typing === true)')
  assert.equal(lines.length, 5)
})

/**
 * main.js itself, started against a fake Electron: the handlers setupIPC registers, and the one window it makes
 * (a fakeWindow in full screen, so its Esc can be pressed). No Discord (no client id), no tray timer.
 */
async function loadMain() {
  const f = fakeWindow({ fullScreen: true })
  Object.assign(f.win, { setMenuBarVisibility() {}, loadURL: async () => {}, isMaximized: () => false })
  Object.assign(f.win.webContents, {
    session: { webRequest: { onHeadersReceived() {} } },
    setUserAgent() {},
    setWindowOpenHandler() {},
    openDevTools() {},
    getURL: () => 'https://unreleased.world/',
  })
  const handlers = {}
  const image = () => ({ isEmpty: () => true, setTemplateImage() {}, resize: () => ({}) })
  const electronStub = {
    app: {
      on() {},
      quit() {},
      requestSingleInstanceLock: () => true,
      setAsDefaultProtocolClient: () => true,
      whenReady: () => Promise.resolve(),
      isReady: () => true,
      getPath: () => path.join(require('node:os').tmpdir(), 'aura-tests-no-such-folder'),
      getVersion: () => '1.0.14',
      isPackaged: true,
    },
    BrowserWindow: Object.assign(function BrowserWindow() {
      return f.win
    }, { getAllWindows: () => [f.win] }),
    ipcMain: {
      on: (channel, listener) => (handlers[channel] = listener),
      handle: (channel, listener) => (handlers[channel] = listener),
    },
    shell: { openExternal() {} },
    Notification: class {
      show() {}
    },
    nativeTheme: {},
    Tray: class {
      setToolTip() {}
      setContextMenu() {}
      isDestroyed() {
        return false
      }
      on() {}
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    nativeImage: { createFromPath: image, createEmpty: image },
    clipboard: { writeText() {} },
  }
  const originalLoad = Module._load
  const realInterval = global.setInterval
  const realConsole = { log: console.log, warn: console.warn, error: console.error }
  const realClientId = process.env.DISCORD_CLIENT_ID
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad(request, parent, isMain)
  }
  global.setInterval = () => ({ unref() {} })
  console.log = console.warn = console.error = () => {}
  process.env.DISCORD_CLIENT_ID = '' // even with a local .env: dotenv keeps what is set
  try {
    delete require.cache[require.resolve('../dist/main')]
    require('../dist/main')
    await new Promise((resolve) => setImmediate(resolve)) // app.whenReady(): the window, then setupIPC
  } finally {
    Module._load = originalLoad
    global.setInterval = realInterval
    Object.assign(console, realConsole)
    if (realClientId === undefined) delete process.env.DISCORD_CLIENT_ID
    else process.env.DISCORD_CLIENT_ID = realClientId
  }
  return { ...f, handlers }
}

test("main's window:typing handler, run: only the main window's own page, on an allowed origin, sets it; only a true is true", async () => {
  const m = await loadMain()
  const typing = m.handlers[TYPING]
  assert.equal(typeof typing, 'function', 'setupIPC registers window:typing')
  const ours = { sender: m.win.webContents, senderFrame: { url: 'https://www.unreleased.world/yeat' } }
  const fullScreen = () => {
    m.win.fullScreen = true
  }

  // Our page: Esc is the field's, and the window stays full screen; its false makes Esc the way out again.
  typing(ours, true)
  assert.equal(m.press(ESC), false)
  assert.equal(m.win.fullScreen, true)
  typing(ours, false)
  assert.equal(m.press(ESC), true)
  assert.equal(m.win.fullScreen, false)

  // Anyone else's word is ignored, either way: it can neither hold Esc back nor let it go.
  const others = [
    ['another page than the main window', { sender: {}, senderFrame: { url: 'https://unreleased.world/' } }],
    ['another origin', { sender: m.win.webContents, senderFrame: { url: 'https://evil.example/' } }],
    ['a look-alike origin', { sender: m.win.webContents, senderFrame: { url: 'https://unreleased.world.evil.example/' } }],
    ['not a web page', { sender: m.win.webContents, senderFrame: { url: 'file:///Users/someone/page.html' } }],
    ['a frame already gone', { sender: m.win.webContents, senderFrame: null }],
  ]
  for (const [name, event] of others) {
    fullScreen()
    typing(event, true)
    assert.equal(m.press(ESC), true, `${name}: its true is ignored`)
    fullScreen()
    typing(ours, true)
    typing(event, false)
    assert.equal(m.press(ESC), false, `${name}: its false is ignored`)
    typing(ours, false)
  }

  // Not a boolean, even from our page: false.
  for (const payload of ['true', 1, { typing: true }, null, undefined]) {
    fullScreen()
    typing(ours, true)
    typing(ours, payload)
    assert.equal(m.press(ESC), true, `${JSON.stringify(payload)} means false`)
  }
})

test('main, the preload and fullscreen.ts name the same typing channel', () => {
  assert.equal(TYPING, 'window:typing')
  assert.ok(code('app/main.ts').includes(`ipcMain.on('${TYPING}'`))
  assert.ok(code('app/preload.ts').includes(`ipcRenderer.send('${TYPING}', typing)`))
})

test('F11 keeps working: the default menu, with its full-screen shortcut, is never replaced', () => {
  const main = code('app/main.ts')
  assert.doesNotMatch(main, /Menu\.setApplicationMenu|\.removeMenu\(|\.setMenu\(/)
  assert.match(main, /mainWindow\.setMenuBarVisibility\(false\)/)
})
