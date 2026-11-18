// app/fullscreen.ts
//
// Getting out of full screen.
//
// Why this file exists
// --------------------
// On Windows (and Linux) a full-screen window has no title bar, so no X and no
// restore button, and since 1.0.8 the menu bar is hidden too (main.ts). Full
// screen comes from F11 (the hidden menu's View > Toggle Full Screen, whose
// shortcut still works) or from the site (a video's full-screen button: HTML
// full screen). Up to 1.0.11 only F11 led back out of F11's full screen: Esc
// went to the page and did nothing, the Windows key shows the taskbar without
// leaving full screen, and nothing on screen said what to press. A member was
// stuck there (2026-11-18: "theres no ex at the top of the screen ... i could
// press the windows button ... but that still doesnt get me out of
// fullscreen").
//
// Now:
//  * Esc leaves full screen, whichever way it was entered. Only while the
//    window is full screen: every other Esc reaches the page untouched (the
//    site closes its dialogs and minimizes its player with Esc).
//  * F11 keeps toggling, as before. Nothing here touches it.
//  * The page hears when the window enters and leaves full screen and can ask
//    to leave it (preload.ts, window.unrlWindow), so the site can draw its own
//    "Exit full screen" button where the title bar would be.

/** main → page: the window entered (true) or left (false) full screen. */
export const FULL_SCREEN_CHANGED = 'window:full-screen-changed'
/** page → main: is the window full screen now? */
export const IS_FULL_SCREEN = 'window:is-full-screen'
/** page → main: leave full screen. */
export const EXIT_FULL_SCREEN = 'window:exit-full-screen'

/** The fields of Electron's `Input` (before-input-event) that decide. */
export interface KeyInput {
  type: string
  key: string
  isAutoRepeat?: boolean
  shift?: boolean
  control?: boolean
  alt?: boolean
  meta?: boolean
}

/** A plain Esc press: the key going down, not a held key repeating, no modifier. */
export function isPlainEscape(input: KeyInput): boolean {
  return (
    input.type === 'keyDown' &&
    input.key === 'Escape' &&
    !input.isAutoRepeat &&
    !input.shift &&
    !input.control &&
    !input.alt &&
    !input.meta
  )
}

/** Esc leaves full screen while the window is in it, and is the page's otherwise. */
export function shouldLeaveFullScreen(input: KeyInput, fullScreen: boolean): boolean {
  return fullScreen && isPlainEscape(input)
}

/** The parts of a BrowserWindow this uses (tests/fullscreen.test.js drives a fake one). */
export interface FullScreenWindow {
  isDestroyed(): boolean
  isFullScreen(): boolean
  setFullScreen(flag: boolean): void
  on(event: 'enter-full-screen' | 'leave-full-screen' | 'enter-html-full-screen' | 'leave-html-full-screen', listener: () => void): unknown
  webContents: {
    isDestroyed(): boolean
    send(channel: string, ...args: unknown[]): void
    executeJavaScript(code: string): Promise<unknown>
    on(event: 'before-input-event', listener: (event: { preventDefault(): void }, input: KeyInput) => void): unknown
  }
}

/**
 * Leaves the page's own full screen (a video's). On Windows, setFullScreen(false)
 * alone resizes the window but can leave the page in HTML full screen, the video
 * still covering everything; the page's own exit is what ends that. A fixed
 * string: nothing from the page goes into it.
 */
export const LEAVE_HTML_FULL_SCREEN =
  'document.fullscreenElement ? document.exitFullscreen().then(() => true, () => false) : false'

export interface FullScreenExit {
  /** Leaves full screen. True when the window was in it. */
  leave(): boolean
}

/** Esc leaves full screen, and the page is told each time the window enters or leaves it. */
export function attachFullScreenExit(win: FullScreenWindow): FullScreenExit {
  // HTML full screen as Electron reports it: the window is full screen too
  // then, unless the page went full screen inside an F11 window.
  let html = false

  const report = (): void => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(FULL_SCREEN_CHANGED, win.isFullScreen())
  }

  const leave = (): boolean => {
    if (win.isDestroyed()) return false
    if (!win.isFullScreen() && !html) return false
    if (html && !win.webContents.isDestroyed()) {
      win.webContents.executeJavaScript(LEAVE_HTML_FULL_SCREEN).catch(() => {
        // The page is gone or busy; setFullScreen below still restores the window.
      })
    }
    win.setFullScreen(false)
    return true
  }

  win.on('enter-full-screen', report)
  win.on('leave-full-screen', report)
  win.on('enter-html-full-screen', () => {
    html = true
    report()
  })
  win.on('leave-html-full-screen', () => {
    html = false
    report()
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (win.isDestroyed()) return
    if (!shouldLeaveFullScreen(input, win.isFullScreen() || html)) return
    // This Esc is the way out, so the page does not also act on it (close a
    // dialog, minimize the player): one press, one thing, as in a browser.
    event.preventDefault()
    leave()
  })

  return { leave }
}
