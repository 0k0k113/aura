const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const build = path.join(__dirname, '..', 'build')

// ============================================================================
// The app icon — the one in the dock, the Finder, the Windows taskbar.
//
// What shipped: `icon-mac.png` was a black disc with NO accent ring, and every
// `icon_<size>.png` — and therefore every image embedded in `icon-win.ico` —
// was a fully opaque solid black SQUARE. No disc, no ring, no transparency.
//
// It got there because "is this icon fine?" was only ever asked as "does this
// file exist and decode to something non-zero", and a solid black rectangle
// answers yes to both. `electron-builder.config.js` checks existence; the tray
// asset test checks for non-zero bytes. Neither can tell the brand mark from a
// black rectangle.
//
// So these check the two things that actually distinguish it: the corners must
// be TRANSPARENT (it is a disc), and the accent colour must be PRESENT (the
// ring is the only part that is legible against a dark dock). Both failure
// modes that shipped are caught by one of the two.
// ============================================================================

/** Brand accent, from the site's own icon. */
const ACCENT = [0xe9, 0x81, 0xec]

/** Full RGBA decode — filters included, so pixels are real pixel values. */
function decodePng(file) {
  const buf = fs.readFileSync(file)
  assert.deepStrictEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${file}: not a PNG`,
  )
  return decodePngBuffer(buf, file)
}

function decodePngBuffer(buf, label) {
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  assert.strictEqual(buf[24], 8, `${label}: expected 8-bit channels`)
  assert.strictEqual(buf[25], 6, `${label}: expected RGBA`)

  const parts = []
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i)
    if (buf.toString('ascii', i + 4, i + 8) === 'IDAT') parts.push(buf.subarray(i + 8, i + 8 + len))
    i += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(parts))

  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      if (filter === 1) line[x] = (line[x] + a) & 255
      else if (filter === 2) line[x] = (line[x] + b) & 255
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { width, height, pixels: out }
}

const near = (px, o, rgb, tolerance = 40) =>
  Math.abs(px[o] - rgb[0]) <= tolerance &&
  Math.abs(px[o + 1] - rgb[1]) <= tolerance &&
  Math.abs(px[o + 2] - rgb[2]) <= tolerance

function describe(image) {
  const { width, height, pixels } = image
  let transparent = 0
  let accent = 0
  let dark = 0
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const alpha = pixels[o + 3]
    if (alpha < 20) {
      transparent++
      continue
    }
    if (near(pixels, o, ACCENT)) accent++
    else if (pixels[o] + pixels[o + 1] + pixels[o + 2] < 120) dark++
  }
  const total = width * height
  return {
    transparentRatio: transparent / total,
    accentPixels: accent,
    darkRatio: dark / total,
  }
}

/** Every icon that ends up in a shipped bundle. */
const ICON_FILES = [
  'icon-mac.png',
  'icon-win.png',
  'icon_16.png',
  'icon_22.png',
  'icon_24.png',
  'icon_32.png',
  'icon_48.png',
  'icon_64.png',
  'icon_128.png',
  'icon_256.png',
  'icon_512.png',
  'icon_1024.png',
]

test('every app icon is a disc, not a filled rectangle', () => {
  for (const name of ICON_FILES) {
    const file = path.join(build, name)
    assert.ok(fs.existsSync(file), `missing build/${name}`)
    const { transparentRatio } = describe(decodePng(file))
    // A disc inscribed in its canvas leaves ~21.5% of it empty. Anything under
    // 10% is a rectangle — which is exactly what shipped.
    assert.ok(
      transparentRatio > 0.1,
      `build/${name}: only ${(transparentRatio * 100).toFixed(1)}% transparent — this is a filled rectangle, not the mark`,
    )
  }
})

test('every app icon carries the accent ring', () => {
  for (const name of ICON_FILES) {
    const { accentPixels } = describe(decodePng(path.join(build, name)))
    // The ring is the only legible part of the mark on a dark dock. A black
    // disc without it is an anonymous blob — which is what icon-mac.png was.
    assert.ok(
      accentPixels > 0,
      `build/${name}: no accent-coloured pixels — the ring is missing`,
    )
  }
})

test('every app icon still has its dark fill', () => {
  for (const name of ICON_FILES) {
    const { darkRatio } = describe(decodePng(path.join(build, name)))
    assert.ok(
      darkRatio > 0.3,
      `build/${name}: only ${(darkRatio * 100).toFixed(1)}% dark fill`,
    )
  }
})

test('the Windows .ico embeds real icons at every declared size', () => {
  const file = path.join(build, 'icon-win.ico')
  assert.ok(fs.existsSync(file), 'missing build/icon-win.ico')
  const buf = fs.readFileSync(file)

  assert.strictEqual(buf.readUInt16LE(0), 0, 'ICO reserved field must be 0')
  assert.strictEqual(buf.readUInt16LE(2), 1, 'expected an icon (type 1), not a cursor')
  const count = buf.readUInt16LE(4)
  assert.ok(count > 0, 'ICO declares no images')

  const seen = []
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16
    const declared = buf[at] === 0 ? 256 : buf[at]
    const size = buf.readUInt32LE(at + 8)
    const offset = buf.readUInt32LE(at + 12)
    assert.ok(offset + size <= buf.length, `ICO entry ${i} runs past the end of the file`)

    const image = decodePngBuffer(buf.subarray(offset, offset + size), `icon-win.ico[${i}]`)
    assert.strictEqual(image.width, declared, `ICO entry ${i}: directory says ${declared}px`)

    const { transparentRatio, accentPixels } = describe(image)
    assert.ok(transparentRatio > 0.1, `ICO ${declared}px is a filled rectangle`)
    assert.ok(accentPixels > 0, `ICO ${declared}px has no accent ring`)
    seen.push(declared)
  }
  // 16 and 32 are what Windows actually draws in the taskbar and title bar.
  assert.ok(seen.includes(16) && seen.includes(32), `ICO is missing 16/32px: ${seen.join(', ')}`)
})

test('the generator reproduces the committed icons byte for byte', () => {
  // If this fails, the icons were hand-edited and the next run of
  // scripts/generate-icons.js will silently revert them.
  const before = Object.fromEntries(
    ICON_FILES.concat('icon-win.ico').map((n) => [n, fs.readFileSync(path.join(build, n))]),
  )

  // Rendered into a temp directory, not over build/ — a test that rewrites the
  // working tree to check it would "pass" by fixing what it was inspecting.
  const out = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aura-icons-'))
  try {
    const { execFileSync } = require('child_process')
    execFileSync(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'generate-icons.js'), out],
      { stdio: 'ignore' },
    )

    for (const [name, bytes] of Object.entries(before)) {
      assert.ok(
        bytes.equals(fs.readFileSync(path.join(out, name))),
        `build/${name} differs from what scripts/generate-icons.js produces`,
      )
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})
