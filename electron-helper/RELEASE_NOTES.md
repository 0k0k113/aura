Discord Rich Presence for **unreleased.world**. Install it, leave it running,
and whatever you play on the site shows up on your Discord profile — cover art,
track, artist, elapsed time. Nothing shows while you're paused.

## What's new in 1.0.5

**Sign in with a passkey, Google or Discord in the app.** Press "Sign in with a
passkey" (or "Sign up with a passkey", or Continue with Google or Discord) and
your browser opens unreleased.world. Sign in there, or create your account,
press **Continue to the app**, and allow your browser to open aura when it
asks. You're back in the app, signed in. Your browser handles the passkey
(Touch ID, Windows Hello, your phone or a security key), which the app itself
can't. The app gets a sign-in of its own: signing out of one doesn't sign you
out of the other.

**Signing in and creating an account work in the app again.** unreleased.world
now runs Cloudflare's security check when you sign in, create an account or
reset your password. Versions 1.0.4 and older block that check, so those steps
fail inside the app even though they work in a browser. 1.0.5 lets the check
load.

The app doesn't update itself. Install 1.0.5 over the old version the same way
you installed it (below); your settings and sign-in are kept. On a Mac, the
one-line installer always fetches the newest version.

## macOS — one command, no prompts

```
curl -fsSL https://unreleased.world/install.sh | sh
```

Paste that into Terminal. It picks the right build for your Mac, verifies the
app's signature, installs it and opens it.

macOS is the only platform where the terminal is worth the trouble, so here is
why: these builds are code-signed but not notarized by Apple (notarization needs
a paid Developer account). Anything a **browser** downloads gets tagged with
macOS's quarantine flag, and Gatekeeper refuses to open a non-notarized app
carrying that tag without a trip through System Settings. `curl` never sets the
tag, so there is nothing to approve. The script is short and commented — read it
at https://unreleased.world/install.sh before running it.

**Or download it yourself:** `Aura-mac-arm64.dmg` for Apple
Silicon (M1–M4), `Aura-mac-x64.dmg` for Intel. Drag it to
Applications, double-click, then allow it in **System Settings → Privacy &
Security → "Open Anyway"**. (On macOS 14 and earlier you can right-click → Open
instead. Apple removed that shortcut in macOS 15.)

### "It says the app is damaged"

It isn't. That message means macOS found no valid signature, and it came from
older builds that shipped completely unsigned — which Apple Silicon refuses to
run. **This release is signed**, so downloading it again fixes the problem. If
it somehow persists:

```
xattr -dr com.apple.quarantine "/Applications/Aura.app"
```

## Windows — download and run

Download **`Aura-win-x64.exe`** and run it. That's the whole
install.

The Windows build is unsigned, so SmartScreen shows "Windows protected your PC"
the first time. It is two clicks past: **More info → Run anyway**. The setup
wizard handles the rest.

`Aura-win-ia32.exe` is for 32-bit Windows; take it only if you
know you need it. `Aura-win.exe` bundles both architectures in
one much larger file and is only useful for redistribution.

## Linux

AppImage — runs on any distribution, no install:

```
chmod +x Aura-linux-x86_64.AppImage
./Aura-linux-x86_64.AppImage
```

Debian and Ubuntu:

```
sudo apt install ./Aura-linux-amd64.deb
```

If Discord itself came from Flatpak, its RPC socket lives inside the sandbox and
the app cannot reach it. Link it out once:

```
ln -sf $XDG_RUNTIME_DIR/app/com.discordapp.Discord/discord-ipc-0 $XDG_RUNTIME_DIR/discord-ipc-0
```

## Requirements

- macOS 11 (Big Sur) or newer, Windows 10/11, or a 64-bit Linux desktop
- The **Discord desktop app** running on the same machine — the browser version
  of Discord has no local RPC socket, so presence cannot reach it

Every asset below publishes its sha256. The same checksums are listed at
https://unreleased.world/discord, so you can confirm a download is byte-for-byte
what CI built.
