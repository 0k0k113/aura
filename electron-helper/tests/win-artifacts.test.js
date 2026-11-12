const test = require('node:test')
const assert = require('node:assert')
const path = require('path')

// ============================================================================
// Aura-win-x64.exe must be the installer.
//
// Up to 1.0.7 the Windows build had two targets, nsis and portable, under one
// artifactName. electron-builder built the portable copy second and it
// overwrote the installer's file, so the release's Aura-win-x64.exe (the file
// unreleased.world/discord calls the "one-click installer") was a portable
// exe. It runs from wherever it was saved and never replaces the installed
// app, so people who "updated" kept opening the old build from the Start menu
// and kept seeing the site's update notice. electron-builder does not warn
// when two targets write one path.
// ============================================================================

const config = require(path.join(__dirname, '..', 'electron-builder.config.js'))

const targetsOf = (platform) =>
  (config[platform].target || []).map((t) => (typeof t === 'string' ? t : t.target))

test('Windows builds only the NSIS installer', () => {
  assert.deepStrictEqual(targetsOf('win'), ['nsis'])
})

test('no two targets on one platform share an artifact name', () => {
  for (const platform of ['mac', 'win', 'linux']) {
    const names = targetsOf(platform).map((t) => `${t}:${(config[t] && config[t].artifactName) || config[platform].artifactName}`)
    const byName = new Map()
    for (const entry of names) {
      const [target, name] = entry.split(/:(.*)/s)
      // Targets with different extensions cannot collide (dmg vs zip, AppImage vs deb).
      const ext = { nsis: 'exe', portable: 'exe', dmg: 'dmg', zip: 'zip', AppImage: 'AppImage', deb: 'deb' }[target] || target
      const key = name.replace('${ext}', ext)
      assert.ok(!byName.has(key), `${platform}: ${target} and ${byName.get(key)} both write ${key}`)
      byName.set(key, target)
    }
  }
})
