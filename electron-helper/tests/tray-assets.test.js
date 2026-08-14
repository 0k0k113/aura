const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

// The tray icon was invisible in every packaged build the app ever shipped.
// tsc emits a FLAT dist (dist/tray.js), so __dirname is app.asar/dist — but the
// lookup only tried Contents/Resources/build and __dirname/../../build, which
// resolve to the same place, and `files: ['build/**/*']` with asar:true puts the
// icons at app.asar/build instead. Nothing matched, loadTrayImage fell back to
// an empty image, and `new Tray(<empty>)` renders nothing at all — taking "Copy
// diagnostics" with it.
//
// These pin the three facts that made that combination fail, so it cannot
// silently come back.

test('tsc emits a flat dist, so tray.js sits one level under the app root', () => {
  const compiled = path.join(root, 'dist', 'tray.js')
  assert.ok(fs.existsSync(compiled), 'expected dist/tray.js (flat), not dist/app/tray.js')
})

test('the macOS tray assets exist in build/', () => {
  for (const name of ['trayTemplate.png', 'tray.png']) {
    const asset = path.join(root, 'build', name)
    assert.ok(fs.existsSync(asset), `missing build/${name}`)
    assert.ok(fs.statSync(asset).size > 0, `build/${name} is empty`)
  }
})

test('build/ is packed into the app bundle, which is why the asar-relative path is required', () => {
  const config = require(path.join(root, 'electron-builder.config.js'))
  assert.ok(
    config.files.some((pattern) => pattern.startsWith('build/')),
    'build/ must be in `files` or the icons ship nowhere at all',
  )
  assert.strictEqual(config.asar, true, 'asar:true is what puts build/ inside app.asar')
})

test('the resolver looks inside the asar, one level up from dist', () => {
  const source = fs.readFileSync(path.join(root, 'app', 'tray.ts'), 'utf8')
  assert.match(
    source,
    /path\.join\(__dirname, '\.\.\/build'\)/,
    "loadTrayImage must try __dirname/../build (app.asar/build) — the only path that exists packaged",
  )
})
