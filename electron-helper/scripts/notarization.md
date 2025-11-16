# macOS Code Signing and Notarization

## Requirements

To sign and notarize the macOS builds, you need:

1. **Apple Developer Account** - Enrolled in the Apple Developer Program
2. **Developer ID Application Certificate** - For signing the app
3. **App-Specific Password** - For notarization API access

## Setup

### 1. Create App-Specific Password

1. Go to [appleid.apple.com](https://appleid.apple.com)
2. Sign in with your Apple ID
3. Navigate to "Sign-In and Security" → "App-Specific Passwords"
4. Generate a new password
5. Save it securely (you'll need it for CI/CD)

### 2. Export Certificates

From Keychain Access on your Mac:

1. Find your "Developer ID Application" certificate
2. Right-click → Export "Developer ID Application: Your Name"
3. Save as `.p12` file with a secure password
4. Base64 encode for GitHub Secrets:
   ```bash
   base64 -i certificate.p12 | pbcopy
   ```

### 3. GitHub Secrets

Add these secrets to your repository:

- `APPLE_ID` - Your Apple ID email
- `APPLE_PASSWORD` - App-specific password from step 1
- `APPLE_TEAM_ID` - Your team ID (found in Apple Developer dashboard)
- `CSC_LINK` - Base64-encoded certificate from step 2
- `CSC_KEY_PASSWORD` - Password for the `.p12` file

## Entitlements

The app requires these entitlements (already configured in `builder.config.json`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
```

## Manual Signing

If building locally:

```bash
export APPLE_ID="your@email.com"
export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"

npm run build
```

## CI/CD Integration

The GitHub Actions workflow (`.github/workflows/electron-release.yml`) handles signing and notarization automatically when the secrets are configured.

## Troubleshooting

### "App is damaged and can't be opened"

This means the app wasn't properly signed or notarized. Users need to:

```bash
xattr -cr /Applications/Unreleasd\ Presence.app
```

Or you need to properly sign and notarize the build.

### Notarization Failed

Check the notarization log:

```bash
xcrun altool --notarization-info <REQUEST_UUID> \
  --username "your@email.com" \
  --password "@keychain:AC_PASSWORD"
```

Common issues:
- Missing or invalid entitlements
- Hardened runtime not enabled
- Unsigned native modules
- Invalid bundle identifier

## Resources

- [Apple Code Signing Guide](https://developer.apple.com/support/code-signing/)
- [Notarization Guide](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [electron-builder Signing](https://www.electron.build/code-signing)
