# Building Unreleased Presence

## Prerequisites

- Node.js 20+ and npm
- macOS builds must run on macOS (electron-builder cannot produce a `.dmg` elsewhere)
- Windows builds run on Windows (or Wine)

## Quick start

```bash
cd electron-helper
npm install
npm test          # typecheck + unit tests
npm run build     # build for the current platform
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Compile and run Electron locally |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Compile, then run the unit tests |
| `npm run pack` | Unpacked app directory (fast; no installer) |
| `npm run build` | Installers for the current platform |
| `npm run dist:mac:arm64` | macOS Apple Silicon |
| `npm run dist:mac:x64` | macOS Intel |
| `npm run dist:win` | Windows x64 + x86 |
| `npm run dist:linux` | Linux AppImage + deb + zip |

## Output layout

Two different directories, and mixing them up used to corrupt builds:

| Directory | Produced by | Committed? |
| --- | --- | --- |
| `dist/` | `tsc` — compiled JavaScript | No (gitignored) |
| `release/` | electron-builder — installers | No (gitignored) |

electron-builder's default output directory is *also* `dist`, which meant it
wrote DMGs into the very folder it was packaging from. `directories.output` is
now `release` so the two never collide.

## Configuration

`electron-builder.config.js` is the **only** build configuration.

There used to be two — a `build` block in `package.json` (which ran) and
`builder.config.json` (which did not, because electron-builder doesn't
auto-discover that filename and no script passed `--config`). Every macOS
signing setting lived in the dead one. Both are gone; the npm scripts now pass
`--config electron-builder.config.js` explicitly.

## macOS code signing

### The short version

**On Apple Silicon, an unsigned app cannot run at all.** Intel Macs merely warn
about unsigned binaries; arm64 refuses to load them. When such a build is also
downloaded from the internet — GitHub Releases attaches the
`com.apple.quarantine` attribute — Gatekeeper reports this with its most
misleading message:

> "Unreleased Presence" is damaged and can't be opened. You should move it to
> the Trash.

The app is not damaged. It was never signed.

### What the build does now

`scripts/adhoc-sign.js` runs as an `afterPack` hook:

- **No Developer ID configured** → the bundle is ad-hoc signed
  (`codesign --sign -`), bottom-up: every nested framework, helper app and
  `.node`/`.dylib` first, the outer bundle last. That satisfies the arm64
  signature requirement. The signature is then verified, and the build **fails**
  if verification does not pass — no more shipping broken downloads.
- **Developer ID configured** (`CSC_LINK` / `CSC_NAME` /
  `CSC_IDENTITY_AUTO_DISCOVERY=true`) → the hook steps aside, hardened runtime
  is enabled, `build/entitlements.mac.plist` is applied, and the app is notarized
  when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are present.

### What users see

| Build | Apple Silicon result |
| --- | --- |
| Unsigned (the old builds) | ❌ "is damaged and can't be opened" |
| Ad-hoc signed (default now) | ⚠️ Right-click → Open once, then works |
| Developer ID + notarized | ✅ Opens normally |

Ad-hoc signing does not remove the Gatekeeper prompt — only notarization does.
It does remove the "damaged" error, which is the difference between "one extra
click" and "the app is broken". See `scripts/notarization.md` to set up the real
certificate.

### Why not `--deep`

`codesign --deep` is deprecated by Apple and signs nested code in an order that
leaves helper apps intermittently unsigned. The hook signs bottom-up instead,
which is what Apple documents.

## Windows

Builds are unsigned. SmartScreen shows "Windows protected your PC" → **More
info** → **Run anyway**. An EV code-signing certificate is the only way to
remove that prompt.

## Releasing

Push a tag; `.github/workflows/release-electron-helper.yml` builds all four
targets, verifies the macOS signature, and publishes a GitHub Release.

```bash
npm version patch          # bumps package.json
git push && git push --tags
```

`workflow_dispatch` accepts a tag name if you'd rather trigger it by hand.

## Environment variables

`.env` in `electron-helper/` (gitignored; CI writes it from the
`DISCORD_CLIENT_ID` secret):

```env
DISCORD_CLIENT_ID=your_discord_client_id
```

Optional, for development:

| Variable | Effect |
| --- | --- |
| `ELECTRON_APP_URL` | Point the helper at another deployment (its origin is auto-allowed) |
| `UNRL_PRESENCE_LOG=1` | Log each Discord activity payload |
| `UNRL_PRESENCE_DEBUG=1` | Log preload normalization |
| `MEDIA_DEBUG=1` | Log Range headers on media requests |

## Troubleshooting

**"is damaged and can't be opened"** — an unsigned build, or a stuck quarantine
flag. Users can clear it with:

```bash
xattr -dr com.apple.quarantine "/Applications/Unreleased Presence.app"
```

If a build you just produced does this, the signature verification step should
have caught it — check the build log for the `[adhoc-sign]` output.

**Rich presence shows nothing** — check the console line the preload prints at
startup:

```
[RP:Preload] Bridge exposed on window.unrlPresence — origin https://… is allowed (allowed: …)
```

If it says `BLOCKED`, the page origin isn't in the allow-list; see
`app/origins.ts`. Discord itself must also be running locally, and
`DISCORD_CLIENT_ID` must be set.

**Build size is ~100–200 MB** — normal. Electron bundles Chromium and Node.
