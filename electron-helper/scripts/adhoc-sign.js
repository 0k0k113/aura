// scripts/adhoc-sign.js
//
// Ad-hoc codesign the packaged .app when no Apple Developer ID is configured.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// On Apple Silicon, macOS REQUIRES every executable to carry a code signature.
// Unlike Intel, where an unsigned binary merely triggers a Gatekeeper prompt,
// arm64 refuses to load unsigned code outright. When such a build is also
// downloaded from the internet (GitHub Releases attaches the
// `com.apple.quarantine` extended attribute), Gatekeeper reports the failure
// with its most alarming and least accurate message:
//
//     "Unreleased Presence" is damaged and can't be opened.
//     You should move it to the Trash.
//
// The app is not damaged. It was never signed. That is exactly what users on
// M-series Macs were hitting with the arm64 downloads.
//
// An ad-hoc signature (`codesign --sign -`) satisfies the arm64 requirement
// without an Apple Developer account. The app then launches normally after the
// standard "unidentified developer" right-click → Open, instead of being
// declared damaged and pushed toward the Trash.
//
// ── Why not `--deep` ─────────────────────────────────────────────────────────
// `codesign --deep` is deprecated by Apple and signs nested code in an order
// that leaves helper apps and frameworks intermittently unsigned. Signing
// bottom-up — every nested Mach-O first, the outer bundle last — is what Apple
// documents and is reliable. That's what this script does.
//
// ── Why afterPack, not afterSign ─────────────────────────────────────────────
// electron-builder does not invoke `afterSign` when it skipped signing — which
// is precisely the unsigned case this hook exists to repair. `afterPack` always
// runs, and it runs BEFORE electron-builder's own signing step, so a configured
// Developer ID still overwrites this ad-hoc signature with the real one.

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/** True when electron-builder was given real signing credentials. */
function hasRealIdentity() {
  if (process.env.CSC_LINK || process.env.CSC_NAME) return true
  // electron-builder treats this as opt-in keychain discovery.
  return process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'true'
}

/** Recursively collect nested code that must be signed before the outer bundle. */
function collectNestedCode(dir, found = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      // Nested bundles are signed as a unit; don't descend past them.
      if (/\.(app|framework|xpc|bundle)$/.test(entry.name)) {
        collectNestedCode(full, found)
        found.push(full)
        continue
      }
      collectNestedCode(full, found)
      continue
    }

    if (entry.isSymbolicLink()) continue

    // Loadable code and bare Mach-O executables inside Helpers/MacOS dirs.
    if (/\.(dylib|so|node)$/.test(entry.name)) {
      found.push(full)
    }
  }

  return found
}

function sign(target) {
  execFileSync(
    'codesign',
    // Deliberately NOT --options=runtime: the hardened runtime is only
    // meaningful alongside a real Developer ID (and notarization), and
    // enabling it on an ad-hoc signature would have macOS kill Electron for
    // JIT before the window ever appears.
    ['--force', '--sign', '-', '--timestamp=none', target],
    { stdio: 'pipe' },
  )
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  if (hasRealIdentity()) {
    console.log('[adhoc-sign] Developer ID configured — leaving electron-builder’s signature intact.')
    return
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )

  if (!fs.existsSync(appPath)) {
    throw new Error(`[adhoc-sign] Expected app bundle not found at ${appPath}`)
  }

  console.log(`[adhoc-sign] Ad-hoc signing ${path.basename(appPath)} (no Developer ID configured)`)

  const nested = collectNestedCode(path.join(appPath, 'Contents'))
  for (const target of nested) {
    try {
      sign(target)
    } catch (error) {
      // A handful of resources are not Mach-O and codesign rejects them; that's
      // expected and harmless. A genuine failure surfaces on the --verify below.
      const message = String(error.stderr || error.message)
      if (!/is not a|bundle format unrecognized|does not contain/i.test(message)) {
        console.warn(`[adhoc-sign] Skipped ${path.relative(appPath, target)}: ${message.trim()}`)
      }
    }
  }

  // Outer bundle last, so it seals the nested signatures computed above.
  sign(appPath)

  // Fail the build rather than shipping another "damaged" download.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'pipe',
  })

  console.log(`[adhoc-sign] Signed and verified ${nested.length + 1} objects.`)
}
