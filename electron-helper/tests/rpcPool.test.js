// tests/rpcPool.test.js
//
// The multi-client pool: one Rich Presence connection per running Discord
// build, instead of the one arbitrary build that answered first.
//
// None of this can be exercised against real Discord in CI, so the tests drive
// fake connections in through the compiled object's fields — private in
// TypeScript, ordinary properties in the JavaScript that runs — exactly as
// tests/rpc.test.js already does for the single-connection class.
//
// What is actually worth guarding here:
//
//   • FLAVOR DETECTION. The socket number says nothing about which build owns
//     it. The only signal is the API host in the READY frame, and every one of
//     them contains "discord.com", so the qualified hosts must be ruled out
//     before falling through to stable. Get the order wrong and Canary is
//     labelled Discord.
//
//   • FAN-OUT RESPECTS THE TOGGLE. A build the listener switched off must stop
//     receiving activities, and must have whatever it was already showing
//     taken down rather than left frozen on the last track.
//
//   • CLEARING IGNORES THE TOGGLE. A disabled build may still be showing a
//     card from before it was disabled; a clear has to reach it anyway.

const test = require('node:test')
const assert = require('node:assert/strict')

const { detectFlavor, FLAVOR_LABELS } = require('../dist/rpc')
const { DiscordRpcPool, DEFAULT_FLAVOR_PREFS } = require('../dist/rpcPool')

/** A stand-in for one DiscordRPC connection, recording what it was told. */
function fakeConnection(flavor, { ready = true } = {}) {
  return {
    flavor,
    calls: { set: [], clear: 0 },
    getFlavor() {
      return this.flavor
    },
    getUsername() {
      return 'listener'
    },
    isConnected() {
      return true
    },
    isReady() {
      return ready
    },
    describe() {
      return FLAVOR_LABELS[this.flavor]
    },
    setActivity(presence) {
      this.calls.set.push(presence)
    },
    clearActivity() {
      this.calls.clear++
    },
    destroy() {},
    getStatus() {
      return {
        connected: true,
        hasUser: ready,
        activitiesSent: this.calls.set.length,
        activitiesDropped: 0,
        lastActivityAt: null,
        lastError: null,
        clientIdPresent: true,
        pendingRequests: 0,
      }
    },
  }
}

/** A pool holding the given connections, without touching a real socket. */
function poolWith(connections, prefs = {}) {
  const pool = new DiscordRpcPool('fake-client-id', prefs)
  connections.forEach((connection, i) => pool.connections.set(i, connection))
  return pool
}

test('detectFlavor reads the build out of the READY config', async (t) => {
  await t.test('stable', () => {
    assert.equal(detectFlavor({ api_endpoint: '//discord.com/api', environment: 'production' }), 'stable')
  })

  await t.test('canary is not mistaken for stable, though its host contains discord.com', () => {
    assert.equal(detectFlavor({ api_endpoint: '//canary.discord.com/api', environment: 'production' }), 'canary')
  })

  await t.test('ptb likewise', () => {
    assert.equal(detectFlavor({ api_endpoint: '//ptb.discord.com/api', environment: 'production' }), 'ptb')
  })

  await t.test('an absent or malformed config degrades to unknown, never throws', () => {
    assert.equal(detectFlavor(undefined), 'unknown')
    assert.equal(detectFlavor(null), 'unknown')
    assert.equal(detectFlavor({}), 'unknown')
    assert.equal(detectFlavor({ api_endpoint: 42 }), 'unknown')
  })
})

test('every enabled build receives the activity', () => {
  const stable = fakeConnection('stable')
  const canary = fakeConnection('canary')
  const pool = poolWith([stable, canary])

  pool.setActivity({ details: 'Phantom' })

  assert.equal(stable.calls.set.length, 1, 'stable got the card')
  assert.equal(canary.calls.set.length, 1, 'canary got it too — this is the whole point')
})

test('a build switched off stops receiving, and loses the card it was showing', () => {
  const stable = fakeConnection('stable')
  const canary = fakeConnection('canary')
  const pool = poolWith([stable, canary])

  pool.setActivity({ details: 'Phantom' })
  pool.setFlavorEnabled('canary', false)

  assert.equal(canary.calls.clear, 1, 'the stale card came down immediately')

  pool.setActivity({ details: 'Drug Party' })
  assert.equal(canary.calls.set.length, 1, 'canary received nothing further')
  assert.equal(stable.calls.set.length, 2, 'stable is unaffected')
})

test('switching a build back on replays the current track, not the next one', () => {
  const canary = fakeConnection('canary')
  const pool = poolWith([canary], { canary: false })

  pool.setActivity({ details: 'Phantom' })
  assert.equal(canary.calls.set.length, 0, 'disabled at the time')

  pool.setFlavorEnabled('canary', true)
  assert.deepEqual(canary.calls.set.at(-1), { details: 'Phantom' }, 'caught up mid-song')
})

test('clearing reaches disabled builds too', () => {
  const canary = fakeConnection('canary')
  const pool = poolWith([canary], { canary: false })

  pool.clearActivity()

  assert.equal(canary.calls.clear, 1, 'a card from before it was disabled still has to come down')
})

test('a newly discovered build is brought up to date with the current track', () => {
  const stable = fakeConnection('stable')
  const pool = poolWith([stable])
  pool.setActivity({ details: 'Phantom' })

  // What tryPipe does once a login resolves.
  const canary = fakeConnection('canary')
  pool.connections.set(1, canary)
  if (pool.lastActivity && !pool.activityCleared && pool.prefs[canary.getFlavor()] !== false) {
    canary.setActivity(pool.lastActivity, true)
  }

  assert.deepEqual(canary.calls.set.at(-1), { details: 'Phantom' }, 'Discord opened mid-song shows the song')
})

test('isReady ignores builds the listener switched off', () => {
  const canary = fakeConnection('canary')
  const pool = poolWith([canary], { canary: false })
  assert.equal(pool.isReady(), false, 'the only connection is one we must not post to')

  pool.setFlavorEnabled('canary', true)
  assert.equal(pool.isReady(), true)
})

test('status aggregates across connections and lists them for the settings UI', () => {
  const stable = fakeConnection('stable')
  const canary = fakeConnection('canary')
  const pool = poolWith([stable, canary])
  pool.setActivity({ details: 'Phantom' })

  const status = pool.getStatus()
  assert.equal(status.connected, true)
  assert.equal(status.activitiesSent, 2, 'summed, not taken from whichever answered first')
  assert.equal(status.clients.length, 2)
  assert.deepEqual(
    status.clients.map((c) => c.label),
    ['Discord', 'Discord Canary'],
  )
  assert.ok(status.clients.every((c) => c.enabled))
})

test('every build is on until the listener says otherwise', () => {
  assert.deepEqual(DEFAULT_FLAVOR_PREFS, { stable: true, ptb: true, canary: true, unknown: true })
})
