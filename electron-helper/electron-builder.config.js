// electron-builder.config.js
//
// THE build configuration. Previously there were two, and only one of them ran:
//
//   • package.json "build"    → active. productName "Unreleased Presence",
//                               no macOS signing settings at all.
//   • builder.config.json     → DEAD. electron-builder does not auto-discover
//                               that filename, and no script passed --config,
//                               so nothing in it ever applied.
//
// Every Gatekeeper-relevant setting (`identity`, `hardenedRuntime`,
// `gatekeeperAssess`) lived in the dead file. The builds users actually
// downloaded were produced by the package.json block, entirely unsigned — which
// is why arm64 Macs reported the app as "damaged and can't be opened".
//
// Both of those are now gone. This file is the only build config, and the npm
// scripts pass it explicitly via --config so discovery rules can never matter.

const fs = require('fs')
const path = require('path')

/** True when real Apple signing credentials are available in the environment. */
const hasDeveloperId = Boolean(
  process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'true',
)

/** Notarization additionally needs an Apple ID + app-specific password + team. */
const canNotarize =
  hasDeveloperId &&
  Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)

if (!hasDeveloperId) {
  console.log(
    '[electron-builder] No Developer ID in the environment — macOS builds will be ' +
      'ad-hoc signed (scripts/adhoc-sign.js) so Apple Silicon can launch them.',
  )
} else {
  console.log(
    `[electron-builder] Developer ID detected. Notarization ${canNotarize ? 'ENABLED' : 'skipped (missing APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID)'}.`,
  )
}

module.exports = {
  appId: 'world.unreleased.presence',
  productName: 'Unreleased Presence',

  directories: {
    // NOT "dist" — that is tsc's outDir. electron-builder defaults to dist/ too,
    // so it used to write DMGs into the very folder it was packaging from.
    output: 'release',
    buildResources: 'build',
  },

  files: ['dist/**/*', 'build/**/*', 'package.json', '.env'],
  asar: true,

  // Ad-hoc signs the bundle when no Developer ID is configured. Runs on every
  // macOS pack; no-ops on Windows and Linux.
  afterPack: 'scripts/adhoc-sign.js',

  mac: {
    category: 'public.app-category.music',
    icon: 'build/icon-mac.png',
    // No ${version}: a stable filename makes
    //   /releases/latest/download/Unreleased-Presence-mac-arm64.dmg
    // a permanent URL, so install.sh and the website never need updating when
    // a new version ships. The release tag still carries the version.
    artifactName: 'Unreleased-Presence-${os}-${arch}.${ext}',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      // The zip is what auto-update and "just unzip it" users take. Produced by
      // electron-builder rather than a shell `zip` so bundle symlinks survive —
      // a zip that flattens them yields a bundle macOS also calls "damaged".
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],

    // `null` tells electron-builder to skip signing; afterPack then applies the
    // ad-hoc signature. With credentials present we let it sign for real.
    identity: hasDeveloperId ? undefined : null,
    hardenedRuntime: hasDeveloperId,
    gatekeeperAssess: false,
    entitlements: hasDeveloperId ? 'build/entitlements.mac.plist' : undefined,
    entitlementsInherit: hasDeveloperId ? 'build/entitlements.mac.plist' : undefined,
    notarize: canNotarize ? { teamId: process.env.APPLE_TEAM_ID } : false,

    extendInfo: {
      // Apple Silicon shipped with 11.0; nothing older can run these builds.
      LSMinimumSystemVersion: '11.0',
      // The helper lives in the tray and keeps presence alive with no window.
      LSUIElement: false,
    },
  },

  dmg: {
    // Signing a DMG requires an identity; without one this must stay false or
    // the build fails outright.
    sign: hasDeveloperId,
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },

  win: {
    icon: 'build/icon-win.ico',
    artifactName: 'Unreleased-Presence-${os}-${arch}.${ext}',
    target: [
      { target: 'nsis', arch: ['x64', 'ia32'] },
      { target: 'portable', arch: ['x64'] },
    ],
  },

  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    shortcutName: 'Unreleased Presence',
  },

  linux: {
    icon: 'build',
    category: 'AudioVideo',
    artifactName: 'Unreleased-Presence-${os}-${arch}.${ext}',
    target: ['AppImage', 'deb', 'zip'],
  },

  // Releases are published by .github/workflows/release-electron-helper.yml,
  // which uploads the artifacts itself. Nothing publishes from the build step.
  publish: null,
}

// Guard against a silently broken icon: electron-builder falls back to the
// default Electron icon rather than failing, which ships an unbranded app.
for (const icon of ['build/icon-mac.png', 'build/icon-win.ico']) {
  if (!fs.existsSync(path.join(__dirname, icon))) {
    throw new Error(`[electron-builder] Missing required icon: ${icon}`)
  }
}
