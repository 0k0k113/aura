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
// without an Apple Developer account. The app then launches after the standard
// unidentified-developer approval, instead of being declared damaged.
//
// ── Signing order ────────────────────────────────────────────────────────────
// `codesign --deep` is deprecated by Apple and signs nested code in an order
// that leaves helper apps and frameworks intermittently unsigned. The correct
// approach is bottom-up: every nested Mach-O and nested bundle first, deepest
// first, then the outer bundle last. Sorting candidates by path depth
// guarantees that regardless of the order the directory walk produced.
//
// ── Finding the nested code ──────────────────────────────────────────────────
// Nested executables must be found by CONTENT, not by file extension. The first
// version of this script matched only `.dylib`, `.so` and `.node`, which missed
// every extension-less Mach-O executable — `chrome_crashpad_handler`, the
// Helper apps' main binaries, and so on. That passed on arm64 (Electron ships
// its darwin-arm64 binaries already ad-hoc signed, so those only needed
// re-sealing) and failed on x64, where they arrive unsigned:
//
//     Electron Framework.framework: code object is not signed at all
//
// Mach-O files are identified here by their magic number instead.
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

/** Directory suffixes that codesign treats as a single signable unit. */
const BUNDLE_SUFFIXES = /\.(app|framework|xpc|bundle|plugin)$/

/**
 * Mach-O magic numbers, big- and little-endian, 32- and 64-bit, plus the
 * universal/fat header. This is how an extension-less executable is recognized.
 */
const MACH_O_MAGIC = new Set([
  0xfeedface, 0xfeedfacf, // big-endian 32 / 64
  0xcefaedfe, 0xcffaedfe, // little-endian 32 / 64
  0xcafebabe, 0xbebafeca, // universal (fat) binary, both byte orders
])

function isMachO(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const header = Buffer.alloc(4)
    if (fs.readSync(fd, header, 0, 4, 0) < 4) return false
    return MACH_O_MAGIC.has(header.readUInt32BE(0))
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Collect every path that needs its own signature: nested bundles, framework
 * version directories, and any Mach-O file.
 */
function collectSignTargets(dir, found = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)

    // Never follow symlinks — a framework's Versions/Current points back at a
    // real version directory and would be signed twice, or worse, cycle.
    if (entry.isSymbolicLink()) continue

    if (entry.isDirectory()) {
      collectSignTargets(full, found)

      if (BUNDLE_SUFFIXES.test(entry.name)) {
        // Apple signs a framework through its versioned directory, not the
        // top-level alias, so add those explicitly when present.
        if (entry.name.endsWith('.framework')) {
          const versionsDir = path.join(full, 'Versions')
          if (fs.existsSync(versionsDir)) {
            for (const version of fs.readdirSync(versionsDir, { withFileTypes: true })) {
              if (version.isDirectory() && !version.isSymbolicLink()) {
                found.push(path.join(versionsDir, version.name))
              }
            }
          }
        }
        found.push(full)
      }
      continue
    }

    if (entry.isFile() && isMachO(full)) {
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

  console.log(
    `[adhoc-sign] Ad-hoc signing ${path.basename(appPath)} for ${context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : `arch ${context.arch}`} (no Developer ID configured)`,
  )

  const targets = collectSignTargets(path.join(appPath, 'Contents'))

  // Deepest first. codesign seals a bundle's contents into its own signature,
  // so anything signed after its parent invalidates that parent.
  targets.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)

  for (const target of targets) {
    try {
      sign(target)
    } catch (error) {
      // Everything here was selected because it IS code, so a failure is real.
      // The previous version warned and carried on, which is how a bundle with
      // an unsigned framework got as far as the build output.
      const detail = String(error.stderr || error.message).trim()
      throw new Error(
        `[adhoc-sign] Failed to sign ${path.relative(appPath, target)}\n${detail}`,
      )
    }
  }

  // Outer bundle last, sealing everything signed above.
  sign(appPath)

  // Fail the build rather than shipping another "damaged" download.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'pipe',
  })

  console.log(`[adhoc-sign] Signed and verified ${targets.length + 1} objects.`)
}

// Exported for tests/adhoc-sign.test.js — the collection and ordering rules are
// what broke the x64 build, so they are covered directly rather than only
// through a full macOS build.
exports.isMachO = isMachO
exports.collectSignTargets = collectSignTargets
exports.orderDeepestFirst = (targets) =>
  [...targets].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
