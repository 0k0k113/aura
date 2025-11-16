# Building Unreleasd Presence Helper

This guide covers building unsigned, production-ready desktop builds of the Unreleasd Presence Helper.

## Prerequisites

- Node.js 18+ and npm
- For macOS builds: macOS system
- For Windows builds: Windows system or Wine on Linux/macOS

## Quick Start

```bash
cd electron-helper
npm install
npm run build
```

## Build Commands

### Development Build
```bash
npm run dev
```
Compiles TypeScript and runs Electron in development mode.

### Production Builds

**All platforms:**
```bash
npm run build
```
Creates production builds for the current platform.

**Directory-only (no installer):**
```bash
npm run pack
```
Creates unpacked directory without creating installers (useful for testing).

## Build Outputs

All builds are output to `electron-helper/dist-builds/`:

### macOS
- `Unreleasd Presence Helper-{version}-mac-x64.dmg` - Intel DMG installer
- `Unreleasd Presence Helper-{version}-mac-arm64.dmg` - Apple Silicon DMG installer
- `Unreleasd Presence Helper-{version}-mac-x64.zip` - Intel ZIP archive
- `Unreleasd Presence Helper-{version}-mac-arm64.zip` - Apple Silicon ZIP archive

### Windows
- `Unreleasd Presence Helper-{version}-win-x64.exe` - 64-bit NSIS installer
- `Unreleasd Presence Helper-{version}-win-ia32.exe` - 32-bit NSIS installer

### Linux (if needed)
- `Unreleasd Presence Helper-{version}-linux-x64.AppImage`
- `Unreleasd Presence Helper-{version}-linux-amd64.deb`

## Unsigned Builds

These builds are **unsigned** and **not notarized**. This is intentional for community distribution.

### macOS Security
Users will need to:
1. Right-click the app → Open
2. Click "Open" in the security dialog

Or use the command:
```bash
xattr -cr "/Applications/Unreleasd Presence Helper.app"
```

### Windows Security
Users may see "Windows protected your PC" warning:
1. Click "More info"
2. Click "Run anyway"

## Hosting Builds

Upload the built files from `dist-builds/` to your hosting provider:

### Recommended Hosting
- **GitHub Releases** (free, automatic updates support)
- **Cloudflare R2** (S3-compatible, free tier)
- **DigitalOcean Spaces** (S3-compatible)
- **Any static file host**

### GitHub Releases Example
```bash
gh release create v1.0.0 \
  ./dist-builds/*.dmg \
  ./dist-builds/*.zip \
  ./dist-builds/*.exe \
  --title "v1.0.0" \
  --notes "Release notes here"
```

## Environment Variables

Create `.env` in `electron-helper/`:

```env
DISCORD_CLIENT_ID=your_discord_client_id
API_BASE_URL=https://your-app.com
```

## Configuration

Edit `builder.config.json` to customize:
- App name and ID
- Icons and resources
- Build targets and architectures
- Installer options

## Troubleshooting

**"electron-builder not found"**
```bash
npm install
```

**Build fails with TypeScript errors**
```bash
npm run typecheck
```

**macOS builds fail on Windows/Linux**
electron-builder cannot create macOS DMG installers on other platforms. Use GitHub Actions or build on macOS.

**Large build sizes**
This is normal. Electron bundles Chromium and Node.js. Typical size: 100-200MB.

## Next Steps

After building:
1. Test the builds on target platforms
2. Upload to hosting (GitHub Releases recommended)
3. Update `/discord` page with download links
4. Document installation instructions for users
