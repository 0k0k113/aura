// tests/tray.test.js
//
// The tray refresh loop, which is what ran continuously for an entire
// listening session and was reported as the machine getting slower the longer
// the app stayed open.
//
// Menu.buildFromTemplate builds a native menu (on macOS an NSMenu plus an
// NSMenuItem per entry, each holding a JS closure) and setContextMenu hands it
// to the OS. Doing that unconditionally every 5s is ~480 of them across 40
// minutes, for a menu nobody had open.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

/** Load tray.js against a fake Electron and report what it did to the OS. */
function loadTray(rpcStatus) {
  const calls = { menusBuilt: 0, setContextMenu: 0, toolTips: [] }
  let intervalFn = null

  const electronStub = {
    app: { getVersion: () => '1.0.7' },
    Tray: class {
      setToolTip(text) {
        calls.toolTips.push(text)
      }
      setContextMenu() {
        calls.setContextMenu++
      }
      isDestroyed() {
        return false
      }
      on() {}
    },
    Menu: {
      buildFromTemplate: (template) => {
        calls.menusBuilt++
        return { template }
      },
    },
    BrowserWindow: class {},
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true, setTemplateImage() {}, resize: () => ({}) }),
      createEmpty: () => ({ isEmpty: () => true, setTemplateImage() {}, resize: () => ({}) }),
    },
    Notification: class {
      show() {}
    },
    clipboard: { writeText() {} },
  }

  const realSetInterval = global.setInterval
  global.setInterval = (fn) => {
    intervalFn = fn
    return { unref() {} }
  }

  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad(request, parent, isMain)
  }

  try {
    delete require.cache[require.resolve('../dist/tray')]
    delete require.cache[require.resolve('../dist/metrics')]
    const { createTray } = require('../dist/tray')
    createTray(() => null, { getStatus: () => rpcStatus.value, clearActivity() {} })
  } finally {
    Module._load = originalLoad
    global.setInterval = realSetInterval
  }

  return { calls, tick: () => intervalFn && intervalFn() }
}

const ACTIVE = {
  connected: true,
  hasUser: true,
  activitiesSent: 1,
  activitiesDropped: 0,
  lastActivityAt: 1,
  lastError: null,
  clientIdPresent: true,
  pendingRequests: 0,
}

test('a steady session rebuilds the menu ZERO extra times', () => {
  // The regression under test. `activitiesSent` climbs throughout playback,
  // and it used to be printed in the status label — so the label differed on
  // every refresh and the rebuild could never be skipped.
  const status = { value: { ...ACTIVE } }
  const { calls, tick } = loadTray(status)

  const afterStartup = calls.menusBuilt
  assert.equal(afterStartup, 1, 'exactly one menu at startup')

  // 40 minutes of refreshes, with the counter climbing the whole way.
  for (let i = 0; i < 480; i++) {
    status.value = { ...ACTIVE, activitiesSent: 100 + i }
    tick()
  }

  assert.equal(calls.menusBuilt, afterStartup, `rebuilt ${calls.menusBuilt - afterStartup}× while idle`)
  assert.equal(calls.setContextMenu, 1)
})

test('a real status change still redraws exactly once', () => {
  const status = { value: { ...ACTIVE, connected: false } }
  const { calls, tick } = loadTray(status)
  const baseline = calls.menusBuilt

  tick() // unchanged
  assert.equal(calls.menusBuilt, baseline)

  status.value = { ...ACTIVE } // Discord came up
  tick()
  assert.equal(calls.menusBuilt, baseline + 1)

  tick() // and settles again
  tick()
  assert.equal(calls.menusBuilt, baseline + 1)
})

test('the status line carries no counter that could tick', () => {
  // Any number that changes during playback puts the rebuild loop straight
  // back, however the comparison is written.
  const status = { value: { ...ACTIVE, activitiesSent: 4321 } }
  const { calls } = loadTray(status)
  const tip = calls.toolTips[calls.toolTips.length - 1]
  assert.ok(!/\d/.test(tip.replace('Unreleased Presence', '')), `tooltip has a number: ${tip}`)
})

test('each distinct state is reported, and each is reported once', () => {
  const status = { value: { ...ACTIVE, connected: false } }
  const { calls, tick } = loadTray(status)
  const baseline = calls.menusBuilt

  const states = [
    { ...ACTIVE, connected: true, hasUser: false },
    { ...ACTIVE, connected: true, hasUser: true, activitiesSent: 0 },
    { ...ACTIVE },
    { ...ACTIVE, connected: false },
  ]
  for (const value of states) {
    status.value = value
    tick()
    tick() // a second tick on the same state must not redraw
  }

  assert.equal(calls.menusBuilt, baseline + states.length)
})
