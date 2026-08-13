// tests/rpc.test.js
//
// The set/clear state machine, which is what makes "nothing shows when paused"
// actually hold on screen. Two failure modes it guards:
//
//   • THE PAUSE RACE. setActivity defers an update that lands inside the 1s
//     throttle window. Pause within that window and the clear goes out first,
//     then the deferred timer re-posts the card — the card blinking back after
//     you paused. Clearing has to cancel the pending timer.
//
//   • CLEAR SPAM. Every navigation now emits a payload that shows nothing, and
//     Discord rate-limits RPC calls. Repeat clears must collapse into one.
//
// DiscordRPC builds its own Client, so these tests drive a fake one in through
// the compiled object's fields — private in TypeScript, ordinary properties in
// the JavaScript that actually runs.

const test = require('node:test')
const assert = require('node:assert/strict')
const { mock } = require('node:test')

const { DiscordRPC } = require('../dist/rpc')

/** A connected RPC with a recording Discord client. */
function connectedRpc() {
  const calls = { set: [], clear: 0 }
  const rpc = new DiscordRPC('fake-client-id')

  rpc.client = {
    user: {
      setActivity: async (presence) => {
        calls.set.push(presence)
      },
      clearActivity: async () => {
        calls.clear++
      },
    },
    on() {},
  }
  rpc.connected = true

  return { rpc, calls }
}

const card = (details) => ({ name: 'unreleased.world', type: 2, details })

test('a first activity goes straight out', () => {
  const { rpc, calls } = connectedRpc()
  rpc.setActivity(card('Some Song'))
  assert.equal(calls.set.length, 1)
  assert.equal(calls.set[0].details, 'Some Song')
})

test('pausing inside the throttle window does NOT let the card blink back', (t) => {
  // The exact sequence: play, then a second update lands inside the throttle
  // window and gets deferred, then the user pauses. Before the fix the
  // deferred timer fired afterwards and put the card straight back up.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { rpc, calls } = connectedRpc()

  rpc.setActivity(card('Some Song'))
  assert.equal(calls.set.length, 1)

  rpc.setActivity(card('Some Song (tick)')) // deferred — inside the 1s window
  assert.equal(calls.set.length, 1, 'second update should have been throttled')

  rpc.clearActivity()
  assert.equal(calls.clear, 1)

  // Let every pending timer run. Nothing may reach Discord.
  t.mock.timers.tick(60_000)
  assert.equal(calls.set.length, 1, 'a deferred update re-posted the card after the pause')
  assert.equal(rpc.isCleared(), true)
})

test('repeat clears collapse into one RPC call', () => {
  const { rpc, calls } = connectedRpc()

  rpc.setActivity(card('Some Song'))
  rpc.clearActivity()
  rpc.clearActivity()
  rpc.clearActivity()

  assert.equal(calls.clear, 1, 'every browsing payload spent a rate-limited call')
})

test('a clear with nothing showing costs nothing', () => {
  // Startup, and every navigation before the first play.
  const { rpc, calls } = connectedRpc()
  assert.equal(rpc.isCleared(), true)
  rpc.clearActivity()
  rpc.clearActivity()
  assert.equal(calls.clear, 0)
})

test('playing again after a pause shows the card again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { rpc, calls } = connectedRpc()

  rpc.setActivity(card('Some Song'))
  rpc.clearActivity()
  assert.equal(rpc.isCleared(), true)

  // Resume bypasses the throttle, exactly as main.ts flags a play-state change.
  rpc.setActivity(card('Some Song'), true)

  assert.equal(calls.set.length, 2)
  assert.equal(calls.set[1].details, 'Some Song')
  assert.equal(rpc.isCleared(), false)

  // And a later clear works again rather than being deduped away.
  rpc.clearActivity()
  assert.equal(calls.clear, 2)
  t.mock.timers.tick(60_000)
  assert.equal(calls.set.length, 2)
})

test('a cleared activity is not replayed when Discord reconnects', () => {
  // `ready` replays lastActivity so a reconnect restores the card. After a
  // clear there must be nothing to restore, or pausing then reconnecting
  // would resurrect the paused track.
  const { rpc, calls } = connectedRpc()

  rpc.setActivity(card('Some Song'))
  rpc.clearActivity()
  assert.equal(rpc.lastActivity, null)

  // Simulate the ready handler's replay condition.
  if (rpc.lastActivity) rpc.setActivity(rpc.lastActivity, true)
  assert.equal(calls.set.length, 1)
})

test('clearing while disconnected still records that nothing is showing', () => {
  const { rpc, calls } = connectedRpc()
  rpc.setActivity(card('Some Song'))
  rpc.connected = false

  rpc.clearActivity()

  assert.equal(calls.clear, 0, 'no call should be attempted while disconnected')
  assert.equal(rpc.isCleared(), true)
  assert.equal(rpc.lastActivity, null)
})

test.after(() => {
  mock.timers.reset()
})

// ---------------------------------------------------------------------------
// Pending-request accounting.
//
// @xhayper/discord-rpc files every request in a `nonceMap` keyed by a random
// UUID, and the ONLY thing that removes an entry is a reply carrying the same
// nonce. On transport close it rejects each pending entry and then leaves it
// in the map — nothing deletes it, ever. Each leftover holds a resolve/reject
// pair and an RPCError with a captured stack, and the map survives reconnects,
// so a long session that bounces Discord grows one for the life of the process.
// ---------------------------------------------------------------------------

/** A pending entry shaped like the library's. */
function pending() {
  let rejected = false
  return {
    entry: {
      resolve() {},
      reject() {
        rejected = true
      },
      error: new Error('RPC error'),
    },
    wasRejected: () => rejected,
  }
}

function fill(rpc, count) {
  const entries = []
  for (let i = 0; i < count; i++) {
    const p = pending()
    entries.push(p)
    rpc.client.nonceMap.set(`nonce-${i}`, p.entry)
  }
  return entries
}

function rpcWithNonceMap() {
  const { rpc, calls } = connectedRpc()
  rpc.client.nonceMap = new Map()
  return { rpc, calls }
}

test('a disconnect empties the map the library would have left behind', () => {
  const { rpc } = rpcWithNonceMap()
  fill(rpc, 12)
  assert.equal(rpc.client.nonceMap.size, 12)

  // The library rejects these, emits 'disconnected', and leaves them in place.
  rpc.client.nonceMap.forEach((p) => p.reject(p.error))
  rpc.releasePendingRequests()

  assert.equal(rpc.client.nonceMap.size, 0)
})

test('reconnect cycles do not accumulate — the whole point', () => {
  const { rpc } = rpcWithNonceMap()
  for (let cycle = 0; cycle < 20; cycle++) {
    fill(rpc, 5)
    rpc.releasePendingRequests()
  }
  assert.equal(rpc.client.nonceMap.size, 0, 'entries survived across reconnects')
})

test('replies Discord never sends are bounded while still connected', () => {
  const { rpc } = rpcWithNonceMap()
  const entries = fill(rpc, 200) // Discord went quiet; nothing is answering

  rpc.setActivity(card('Some Song'), true) // dispatch prunes

  assert.ok(rpc.client.nonceMap.size <= 32, `map still holds ${rpc.client.nonceMap.size}`)
  // Rejecting is what settles the promise and releases its closures; silently
  // deleting would leave every caller waiting forever.
  assert.ok(entries.every((e) => e.wasRejected()), 'pruned entries were dropped unsettled')
})

test('a healthy request in flight is left alone', () => {
  const { rpc } = rpcWithNonceMap()
  const entries = fill(rpc, 3)

  rpc.setActivity(card('Some Song'), true)

  assert.equal(rpc.client.nonceMap.size, 3)
  assert.ok(entries.every((e) => !e.wasRejected()))
})

test('the pending count is reported, so growth is visible in diagnostics', () => {
  const { rpc } = rpcWithNonceMap()
  assert.equal(rpc.getStatus().pendingRequests, 0)
  fill(rpc, 7)
  assert.equal(rpc.getStatus().pendingRequests, 7)
})

test('a library that no longer exposes nonceMap degrades to a no-op', () => {
  const { rpc, calls } = connectedRpc()
  delete rpc.client.nonceMap

  assert.doesNotThrow(() => rpc.releasePendingRequests())
  assert.doesNotThrow(() => rpc.setActivity(card('Some Song'), true))
  assert.equal(rpc.getStatus().pendingRequests, 0)
  assert.equal(calls.set.length, 1, 'activities still get sent')
})
