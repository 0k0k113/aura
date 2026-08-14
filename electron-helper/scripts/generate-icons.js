#!/usr/bin/env node
//
// Regenerate the app icon set from the brand mark.
//
// Why this exists rather than a checked-in PNG pipeline: the mark is two
// analytic shapes — a black disc and a hairline accent ring at its rim — so it
// can be rendered crisply at any size instead of resampled from one master. It
// also means the icons can be regenerated and diffed, which is how the last set
// went wrong without anybody noticing.
//
// What was wrong: `icon-mac.png` was a black disc with NO ring, and every
// `icon_<size>.png` (and therefore every image inside `icon-win.ico`) was a
// fully opaque solid black square — no disc, no ring, no transparency. The
// existing asset test only asked "does this PNG decode to something non-zero",
// which a solid black square passes. `tests/app-icons.test.js` now checks for
// the accent colour and for the transparent corners, which is what actually
// distinguishes the mark from a black rectangle.
//
// Geometry is taken from the site's own icon (v2 public/apple-touch-icon.png,
// 180x180): a disc 178px across on a 180px canvas, with a 2px ring in
// #E981EC at the rim over a #000000 fill.
//
//   node scripts/generate-icons.js [output-dir]

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// Defaults to the repo's build/. An explicit argument lets the test render into
// a temp directory and diff, instead of rewriting your working tree to check it.
const BUILD = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'build')

/** Disc diameter as a fraction of the canvas. Full-bleed, near enough. */
const DISC_RATIO = 178 / 180
/** Ring thickness as a fraction of the canvas. */
const RING_RATIO = 2 / 180
/** Brand accent — the only thing that makes the mark legible on a dark dock. */
const RING_RGB = [0xe9, 0x81, 0xec]
const FILL_RGB = [0x00, 0x00, 0x00]
/** Samples per axis. 4x4 per pixel is plenty for two circles. */
const SS = 4

/**
 * Render the mark at `size` and return raw RGBA bytes.
 *
 * The ring is floored at one device pixel: at 16px a proportional ring would be
 * 0.18px and would simply not be there, which is how a menu-bar-sized icon ends
 * up as an anonymous dark blob.
 */
function renderIcon(size) {
  const cx = size / 2
  const cy = size / 2
  const rOuter = (size * DISC_RATIO) / 2
  const ring = Math.max(1, size * RING_RATIO)
  const rInner = Math.max(0, rOuter - ring)

  const px = Buffer.alloc(size * size * 4)
  const step = 1 / SS
  const offset = step / 2

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Accumulate PREMULTIPLIED, or the antialiased rim of the pink ring picks
      // up the transparent black outside it and fringes dark.
      let ar = 0
      let ag = 0
      let ab = 0
      let aa = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px0 = x + offset + sx * step - cx
          const py0 = y + offset + sy * step - cy
          const d = Math.hypot(px0, py0)
          if (d > rOuter) continue
          const rgb = d >= rInner ? RING_RGB : FILL_RGB
          ar += rgb[0]
          ag += rgb[1]
          ab += rgb[2]
          aa += 255
        }
      }

      const n = SS * SS
      const alpha = Math.round(aa / n)
      const o = (y * size + x) * 4
      if (alpha === 0) continue
      // Un-premultiply back to straight alpha for the PNG.
      px[o] = Math.round(ar / (aa / 255))
      px[o + 1] = Math.round(ag / (aa / 255))
      px[o + 2] = Math.round(ab / (aa / 255))
      px[o + 3] = alpha
    }
  }
  return px
}

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10..12: deflate / adaptive filtering / no interlace, all zero.

  // Filter type 0 on every scanline. The image is smooth and small; the extra
  // ratio from adaptive filtering is not worth the code to get it wrong in.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** ICO is a directory of embedded PNGs; 256 is encoded as 0 in the byte field. */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length
  entries.forEach((entry, i) => {
    const at = i * 16
    dir[at] = entry.size >= 256 ? 0 : entry.size
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size
    dir[at + 2] = 0 // palette entries
    dir[at + 3] = 0 // reserved
    dir.writeUInt16LE(1, at + 4) // colour planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32LE(entry.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

// --- write everything ------------------------------------------------------

/** Linux: electron-builder scans `build/` for these and picks what it needs. */
const LINUX_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512, 1024]
/** Windows: what goes inside icon-win.ico. */
const ICO_SIZES = [16, 32, 64, 128, 256]
/** macOS iconset, kept in step even though electron-builder builds its own. */
const ICONSET = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

const cache = new Map()
const png = (size) => {
  if (!cache.has(size)) cache.set(size, encodePng(size, renderIcon(size)))
  return cache.get(size)
}

const written = []
const write = (relative, buf) => {
  const target = path.join(BUILD, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, buf)
  written.push(`${relative} (${buf.length}B)`)
}

for (const size of LINUX_SIZES) write(`icon_${size}.png`, png(size))
write('icon-mac.png', png(1024))
write('icon-win.png', png(512))
write('icon-win.ico', encodeIco(ICO_SIZES.map((size) => ({ size, png: png(size) }))))
for (const [name, size] of ICONSET) write(path.join('icon.iconset', name), png(size))

console.log(`Wrote ${written.length} icons to build/:\n  ${written.join('\n  ')}`)
