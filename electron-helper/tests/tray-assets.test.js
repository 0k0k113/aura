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

// Decode a PNG's alpha channel far enough to answer "does this image draw
// anything at all". `fs.statSync(...).size > 0` was the previous check, and a
// fully transparent PNG passes it — which is exactly how the tray shipped for
// the life of the app with nothing in it.
function visibleAlphaRatio(file) {
  const zlib = require('zlib')
  const buf = fs.readFileSync(file)
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  assert.strictEqual(buf[24], 8, `${file}: expected 8-bit channels`)
  assert.strictEqual(buf[25], 6, `${file}: expected RGBA`)

  const parts = []
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i)
    if (buf.toString('ascii', i + 4, i + 8) === 'IDAT') parts.push(buf.subarray(i + 8, i + 8 + len))
    i += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(parts))

  // Alpha is the only channel that matters here, and every scanline is
  // preceded by its filter byte. Filters make an exact decode more involved,
  // but any non-zero byte anywhere in the pixel data means SOMETHING is drawn
  // — a fully transparent image decodes to all zeros under every filter type.
  const stride = width * 4 + 1
  let nonZero = 0
  for (let i = 0; i < raw.length; i++) {
    if (i % stride === 0) continue // filter byte
    if (raw[i] !== 0) nonZero++
  }
  return nonZero / (width * height * 4)
}

test('the macOS tray assets exist and are not blank', () => {
  for (const name of ['trayColor.png', 'trayColor@2x.png', 'trayTemplate.png', 'trayTemplate@2x.png', 'tray.png', 'tray@2x.png']) {
    const asset = path.join(root, 'build', name)
    assert.ok(fs.existsSync(asset), `missing build/${name}`)

    const ratio = visibleAlphaRatio(asset)
    assert.ok(
      ratio > 0.01,
      `build/${name} draws nothing (${(ratio * 100).toFixed(2)}% non-zero pixel data). ` +
        'A transparent PNG renders as an INVISIBLE menu bar item, not a missing one.',
    )
  }
})

test('the macOS template image carries no colour', () => {
  // macOS paints a template image using its alpha only, in the menu bar's own
  // tint. Colour in the file is silently discarded, so any that is present is a
  // sign the asset was not built as a template and will not look right.
  const zlib = require('zlib')
  const buf = fs.readFileSync(path.join(root, 'build', 'trayTemplate.png'))
  const width = buf.readUInt32BE(16)
  const parts = []
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i)
    if (buf.toString('ascii', i + 4, i + 8) === 'IDAT') parts.push(buf.subarray(i + 8, i + 8 + len))
    i += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(parts))
  const stride = width * 4 + 1
  for (let i = 0; i < raw.length; i++) {
    const col = i % stride
    if (col === 0) continue
    const channel = (col - 1) % 4
    if (channel !== 3) {
      assert.strictEqual(raw[i], 0, 'trayTemplate.png must be black + alpha only')
    }
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

// The menu bar showed an empty outlined circle (11-12, the owner: "pls fix the
// icon on the top"): the template image is drawn from its alpha alone, so the
// brand mark (black disc, pink ring) lost both colours. macOS now loads the
// colour mark first and never as a template; these pin that it is first in
// every lookup and that its pink ring is really in the file.
test('macOS loads the colour mark first, and only a *Template file as a template', () => {
  const src = fs.readFileSync(path.join(root, 'app', 'tray.ts'), 'utf8')
  for (const dir of ['resBuild', 'asarBuild', 'localBuild']) {
    const first = src.indexOf(`path.join(${dir}, 'trayColor.png')`)
    const template = src.indexOf(`path.join(${dir}, 'trayTemplate.png')`)
    assert.ok(first !== -1 && first < template, `${dir}: trayColor.png must come before trayTemplate.png`)
  }
  assert.match(src, /if \(\/Template\(@2x\)\?\\\.png\$\/\.test\(chosen/)
})

test('the colour mark carries the brand pink', () => {
  const zlib = require('zlib')
  const buf = fs.readFileSync(path.join(root, 'build', 'trayColor@2x.png'))
  const width = buf.readUInt32BE(16)
  const parts = []
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i)
    if (buf.toString('ascii', i + 4, i + 8) === 'IDAT') parts.push(buf.subarray(i + 8, i + 8 + len))
    i += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(parts))
  const stride = width * 4 + 1
  // Unfiltered rows (filter byte 0), as the drawing script writes them.
  let pink = 0
  for (let row = 0; row * stride < raw.length; row++) {
    assert.strictEqual(raw[row * stride], 0, 'expected unfiltered rows')
    for (let x = 0; x < width; x++) {
      const o = row * stride + 1 + x * 4
      if (raw[o + 3] === 255 && Math.abs(raw[o] - 0xe9) < 8 && Math.abs(raw[o + 1] - 0x81) < 8 && Math.abs(raw[o + 2] - 0xec) < 8) pink++
    }
  }
  assert.ok(pink > width, `only ${pink} brand-pink pixels: the ring is missing`)
})
