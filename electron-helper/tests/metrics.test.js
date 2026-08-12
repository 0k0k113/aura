// tests/metrics.test.js
//
// Resource telemetry, which exists so a "the app made my whole machine slow"
// report can be answered with numbers. Two things matter about it:
//
//   • the shape is stable, because it gets pasted into a bug report;
//   • it NEVER throws. It runs inside the tray menu builder and the ping
//     handler, and diagnostics that can crash the app are worse than none.

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

/** Load metrics.js with a stubbed `electron`, since there is no runtime here. */
function loadMetrics(appStub) {
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app: appStub }
    return originalLoad(request, parent, isMain)
  }
  try {
    delete require.cache[require.resolve('../dist/metrics')]
    return require('../dist/metrics')
  } finally {
    Module._load = originalLoad
  }
}

const SAMPLE = [
  { type: 'Browser', pid: 1, cpu: { percentCPUUsage: 3.14159 }, memory: { workingSetSize: 120_000 } },
  { type: 'Tab', pid: 2, cpu: { percentCPUUsage: 41.5 }, memory: { workingSetSize: 512_000 } },
  { type: 'GPU', pid: 3, cpu: { percentCPUUsage: 12 }, memory: { workingSetSize: 64_000 } },
]

test('reports every process with CPU and memory in readable units', () => {
  const { collectResourceMetrics } = loadMetrics({ getAppMetrics: () => SAMPLE })
  const metrics = collectResourceMetrics()

  assert.equal(metrics.processes.length, 3)
  // workingSetSize is kilobytes; a bug report wants megabytes.
  assert.deepEqual(
    metrics.processes.map((p) => p.memoryMB),
    [117, 500, 63],
  )
  assert.equal(metrics.processes[0].cpuPercent, 3.1) // one decimal, not noise
  assert.deepEqual(
    metrics.processes.map((p) => p.type),
    ['Browser', 'Tab', 'GPU'],
  )
})

test('totals memory across processes — the number that shows growth', () => {
  const { collectResourceMetrics } = loadMetrics({ getAppMetrics: () => SAMPLE })
  assert.equal(collectResourceMetrics().totalMemoryMB, 117 + 500 + 63)
})

test('carries uptime, without which memory means nothing', () => {
  // 400MB after two minutes is a leak; after eight hours it may be a baseline.
  const { collectResourceMetrics } = loadMetrics({ getAppMetrics: () => SAMPLE })
  const metrics = collectResourceMetrics()
  assert.equal(typeof metrics.uptimeSeconds, 'number')
  assert.ok(metrics.uptimeSeconds >= 0)
})

test('survives a metrics API that returns junk', () => {
  const { collectResourceMetrics } = loadMetrics({
    getAppMetrics: () => [{ type: 'Browser', pid: 9 }], // no cpu, no memory
  })
  const metrics = collectResourceMetrics()
  assert.equal(metrics.processes[0].cpuPercent, 0)
  assert.equal(metrics.processes[0].memoryMB, 0)
  assert.equal(metrics.totalMemoryMB, 0)
})

test('returns null instead of throwing when the API is unavailable', () => {
  // This runs inside the tray menu builder. Diagnostics must never be the
  // thing that takes the app down.
  const { collectResourceMetrics } = loadMetrics({
    getAppMetrics: () => {
      throw new Error('not available')
    },
  })
  assert.equal(collectResourceMetrics(), null)
})

test('an empty process list is reported, not treated as a failure', () => {
  const { collectResourceMetrics } = loadMetrics({ getAppMetrics: () => [] })
  const metrics = collectResourceMetrics()
  assert.deepEqual(metrics.processes, [])
  assert.equal(metrics.totalMemoryMB, 0)
})
