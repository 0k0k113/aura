// tests/adhoc-sign.test.js
//
// The macOS x64 build failed with
//
//   Electron Framework.framework: code object is not signed at all
//
// because the first version of collectSignTargets matched only `.dylib`,
// `.so` and `.node`. Every extension-less Mach-O executable —
// `chrome_crashpad_handler`, the Helper apps' main binaries — was skipped.
// arm64 passed anyway, because Electron ships its darwin-arm64 binaries
// already ad-hoc signed and they only needed re-sealing; x64 arrives unsigned.
//
// These tests build a synthetic bundle so the collection and ordering rules are
// verified without a macOS runner.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { isMachO, collectSignTargets, orderDeepestFirst } = require('../scripts/adhoc-sign')

/** 64-bit little-endian Mach-O header magic (0xCFFAEDFE big-endian order). */
const MACH_O_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
const MACH_O_FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe])

function makeBundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-sign-'))
  const contents = path.join(root, 'Test.app', 'Contents')

  const write = (relative, buffer) => {
    const full = path.join(contents, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, buffer)
    return full
  }

  // The extension-less executables the old extension-matching missed.
  write('MacOS/Test', MACH_O_64)
  write(
    'Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
    MACH_O_64,
  )
  write('Frameworks/Electron Framework.framework/Versions/A/Electron Framework', MACH_O_FAT)
  write('Frameworks/Test Helper.app/Contents/MacOS/Test Helper', MACH_O_64)

  // Extension-bearing code, which the old version did find.
  write('Frameworks/libffmpeg.dylib', MACH_O_64)
  write('Resources/app.asar.unpacked/native.node', MACH_O_64)

  // Non-code that must NOT be handed to codesign.
  write('Info.plist', Buffer.from('<?xml version="1.0"?>'))
  write('Resources/icon.icns', Buffer.from('icns fake'))
  write('Resources/app.asar', Buffer.from('not mach-o'))

  // A framework's Current symlink points back at a real version directory;
  // following it would sign the same code twice.
  const versions = path.join(contents, 'Frameworks/Electron Framework.framework/Versions')
  fs.symlinkSync('A', path.join(versions, 'Current'))

  return { root, contents }
}

test('isMachO recognizes Mach-O by magic number, not extension', () => {
  const { root, contents } = makeBundle()
  try {
    assert.equal(isMachO(path.join(contents, 'MacOS/Test')), true)
    assert.equal(isMachO(path.join(contents, 'Frameworks/libffmpeg.dylib')), true)
    assert.equal(
      isMachO(path.join(contents, 'Frameworks/Electron Framework.framework/Versions/A/Electron Framework')),
      true,
    )
    assert.equal(isMachO(path.join(contents, 'Info.plist')), false)
    assert.equal(isMachO(path.join(contents, 'Resources/app.asar')), false)
    assert.equal(isMachO(path.join(contents, 'Resources/icon.icns')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('isMachO is safe on a missing or unreadable path', () => {
  assert.equal(isMachO('/definitely/not/here'), false)
})

test('collectSignTargets finds extension-less executables', () => {
  const { root, contents } = makeBundle()
  try {
    const targets = collectSignTargets(contents).map((p) => path.relative(contents, p))

    // The exact binaries whose omission broke the x64 build.
    assert.ok(targets.includes(path.join('MacOS', 'Test')))
    assert.ok(
      targets.includes(
        path.join('Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Helpers', 'chrome_crashpad_handler'),
      ),
      'chrome_crashpad_handler must be signed — it has no file extension',
    )
    assert.ok(
      targets.includes(path.join('Frameworks', 'Test Helper.app', 'Contents', 'MacOS', 'Test Helper')),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('collectSignTargets includes nested bundles and framework versions', () => {
  const { root, contents } = makeBundle()
  try {
    const targets = collectSignTargets(contents).map((p) => path.relative(contents, p))
    assert.ok(targets.includes(path.join('Frameworks', 'Electron Framework.framework')))
    assert.ok(targets.includes(path.join('Frameworks', 'Electron Framework.framework', 'Versions', 'A')))
    assert.ok(targets.includes(path.join('Frameworks', 'Test Helper.app')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('collectSignTargets excludes non-code and symlinks', () => {
  const { root, contents } = makeBundle()
  try {
    const targets = collectSignTargets(contents).map((p) => path.relative(contents, p))
    for (const excluded of ['Info.plist', path.join('Resources', 'icon.icns'), path.join('Resources', 'app.asar')]) {
      assert.ok(!targets.includes(excluded), `${excluded} must not be sent to codesign`)
    }
    // Signing through Current would re-sign Versions/A a second time.
    assert.ok(
      !targets.some((t) => t.includes(`Versions${path.sep}Current`)),
      'must not follow the Versions/Current symlink',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('targets are ordered deepest first', () => {
  const { root, contents } = makeBundle()
  try {
    const ordered = orderDeepestFirst(collectSignTargets(contents))
    const depths = ordered.map((p) => p.split(path.sep).length)

    for (let i = 1; i < depths.length; i++) {
      assert.ok(depths[i] <= depths[i - 1], 'ordering must be non-increasing in depth')
    }

    // A bundle seals its contents into its own signature, so anything inside it
    // has to be signed first.
    const indexOf = (suffix) => ordered.findIndex((p) => p.endsWith(suffix))
    assert.ok(
      indexOf(path.join('Versions', 'A', 'Helpers', 'chrome_crashpad_handler')) <
        indexOf('Electron Framework.framework'),
      'nested helper must be signed before its framework',
    )
    assert.ok(
      indexOf(path.join('Test Helper.app', 'Contents', 'MacOS', 'Test Helper')) <
        indexOf('Test Helper.app'),
      'helper executable must be signed before its bundle',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('collectSignTargets returns empty for a path that does not exist', () => {
  assert.deepEqual(collectSignTargets('/definitely/not/here'), [])
})
