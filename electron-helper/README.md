# Unreleased Presence – Desktop Helper  
_Last updated: August 10, 2026_

This app is a small desktop helper that connects **unreleased.world** to **Discord Rich Presence**.  
It is **open source**. macOS builds are code-signed so they launch on Apple Silicon, but they are not
notarized by Apple, so macOS and Windows still show a security prompt the first time you open it.

---

## 1. Which download should I use?

- **Windows (x64 or x86)**  
  Download the `.exe` installer from the **Windows** artifact / release.

- **macOS – Apple Silicon (M1 / M2 / M3 / M4)**  
  Download the `...-mac-arm64.dmg` (or `.zip`).

- **macOS – Intel**  
  Download the `...-mac-x64.dmg` (or `.zip`).

> ✅ If you’re not sure which Mac you have:  
> Click  → **About This Mac** → check if it says **Apple M-chip** (Apple Silicon) or **Intel**.

---

## 2. General requirements

- You must have the **Discord desktop app** installed and running.
- Log into **unreleased.world** in the built-in Electron window.
- Once logged in and playing music, Discord should show the **Rich Presence**.

---

## 3. macOS (Apple Silicon & Intel)

### A. Install the app

1. Download the correct **DMG** for your Mac (`arm64` for Apple Silicon, `x64` for Intel).
2. Double-click the `.dmg` file.
3. Drag **Unreleased Presence.app** into your **Applications** folder.
4. Eject the DMG.

---

### B. First launch – unsigned app (normal case)

On first open, macOS may show:

> “Unreleased Presence” can’t be opened because it is from an unidentified developer.

Do this:

1. Open **System Settings → Privacy & Security**.
2. Scroll down to the **Security** section.
3. You should see a message like:  
   _“Unreleased Presence was blocked from use because it is not from an identified developer”_  
4. Click **“Open Anyway”**.
5. In the popup, click **“Open”** again.

After doing this once, you can open the app normally from Launchpad / Applications.

---

### C. Fallback #1 – Right-click → Open

If you don’t see **“Open Anyway”** in Privacy & Security:

1. Open **Finder → Applications**.
2. **Right-click** (or Ctrl-click) on **Unreleased Presence.app**.
3. Click **Open**.
4. macOS will show a similar warning, but now with an **Open** button.  
5. Click **Open**.

---

### D. Fallback #2 – “App is damaged” message

> “Unreleased Presence” is damaged and can’t be opened. You should move it to the Trash.

**This should no longer happen.** It was caused by the macOS builds being
completely unsigned: Apple Silicon refuses to load unsigned code, and Gatekeeper
reports that refusal with this (very misleading) wording. The app was never
actually damaged. Every build from v1.0.1 onward is signed, and CI fails if the
signature doesn’t verify.

If you hit this on an **older download**, grab the latest release first — that
alone fixes it.

If you still see it, the quarantine flag is stuck. Open **Terminal**
(Applications → Utilities → Terminal) and run:

    xattr -dr com.apple.quarantine "/Applications/Unreleased Presence.app"

No `sudo` is needed — the file is in your own Applications folder, and running
this with `sudo` can leave the app owned by root.

> ⚠️ Only do this for apps you downloaded from the **official GitHub repo**.

---

## 4. Windows (x64 / x86)

### A. Install and run

1. Download the **Windows** installer (`Unreleased-Presence-...-win-...exe`).
2. Double-click the `.exe`.
3. Follow the installer steps (one-click NSIS installer).
4. When the installer completes, it will create a shortcut in **Start Menu** (and optionally on Desktop).
5. Launch **Unreleased Presence** from the Start Menu / shortcut.

---

### B. “Windows protected your PC” (SmartScreen)

On some systems, you may see:

> “Windows protected your PC”
> *Microsoft Defender SmartScreen prevented an unrecognized app from starting.*

To continue:

1. Click **More info**.
2. Click **Run anyway**.
3. Complete the installation and launch the app.

Again, only do this if you downloaded from the **official GitHub repo / website** and you trust the app.

---

## 5. After launching the helper

To see Discord Rich Presence working:

1. Make sure **Discord desktop** is running and you are logged in.
2. Open **Unreleased Presence**.
3. Log into **unreleased.world** inside the Electron window (if prompted).
4. Start playing a track on **unreleased.world**.
5. In Discord, open your profile card and confirm you see **Listening to unreleased.world** with track details.

If presence doesn’t show:

* Check that **“Display current activity as status message”** is enabled in Discord:
  **Settings → Activity Privacy → Display current activity as status message**.
* Restart both **Discord** and **Unreleased Presence**, then try again.
* Make sure only **one** Discord instance is running and that the helper app is open.

---

## 6. Getting help / reporting issues

If something doesn’t work:

* Open the GitHub repo’s **Issues** tab.
* Include:

  * Your OS (Windows / macOS, Intel or Apple Silicon).
  * What you downloaded (exact file name).
  * What you tried.
  * Any error messages or screenshots.

This helps us debug and improve the unsigned builds for everyone.
