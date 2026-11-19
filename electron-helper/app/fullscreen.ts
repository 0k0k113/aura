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
//  * Except in a text field (1.0.14). 1.0.12 took every Esc in full screen,
//    so Esc in the full player's Search box left full screen instead of
//    clearing the box. Now, while a text field has the cursor, Esc is the
//    field's (the Search box clears, then lets go of the cursor), and the
//    next Esc, with no field focused, leaves full screen as before. The
//    preload says when a field has the cursor (TYPING); main forgets it
//    whenever it may be stale (a new page, leaving full screen), because a
//    true left behind would leave Esc dead.
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
/**
 * page → main: a text field has the cursor (true) or nothing that takes typing does (false). Sent by the preload on
 * its own (preload.ts), not by the site, and only from an allowed origin. While true, Esc is the field's. Anything
 * but the boolean true counts as false.
 */
export const TYPING = 'window:typing'

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

/**
 * Esc leaves full screen while the window is in it and no text field has the cursor. Otherwise it is the page's:
 * a field's Esc clears it, then lets go of the cursor, and the next Esc leaves. Only a real `true` holds Esc back.
 */
export function shouldLeaveFullScreen(input: KeyInput, fullScreen: boolean, typing = false): boolean {
  return fullScreen && typing !== true && isPlainEscape(input)
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
    on(event: 'did-navigate' | 'render-process-gone' | 'unresponsive', listener: () => void): unknown
    on(
      event: 'did-fail-load',
      listener: (event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => void,
    ): unknown
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
  /** The page's word (TYPING): a text field has the cursor (true) or not. Anything but the boolean true is false. */
  setTyping(typing: unknown): void
}

/** Esc leaves full screen, unless a text field has the cursor, and the page is told each time the window enters or leaves it. */
export function attachFullScreenExit(win: FullScreenWindow): FullScreenExit {
  // HTML full screen as Electron reports it: the window is full screen too
  // then, unless the page went full screen inside an F11 window.
  let html = false
  // A text field on the page has the cursor (TYPING), so Esc is the field's.
  // True only on the page's word, and false again wherever that word may be
  // stale (below): a true nobody takes back would leave Esc dead.
  let typing = false
  const startOver = (): void => {
    typing = false
  }

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

  // Leaving full screen forgets the typing. The preload says it again at every
  // change it is told about (FULL_SCREEN_CHANGED, sent here right after), so a
  // field that still has the cursor is not lost, and a word that went stale is.
  win.on('enter-full-screen', report)
  win.on('leave-full-screen', () => {
    startOver()
    report()
  })
  win.on('enter-html-full-screen', () => {
    html = true
    report()
  })
  win.on('leave-html-full-screen', () => {
    html = false
    startOver()
    report()
  })

  // Another document taking the page's place forgets it too: a navigation or a
  // reload (did-navigate), an error page instead (did-fail-load in the main
  // frame: a reload while offline, say), or the page's renderer dying. The new
  // page's preload starts at false too. The site's own page changes
  // (history.pushState: did-navigate-in-page) keep the document and its cursor.
  win.webContents.on('did-navigate', startOver)
  win.webContents.on('did-fail-load', (_event, _errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (isMainFrame) startOver()
  })
  win.webContents.on('render-process-gone', startOver)
  // And a page that stopped answering: its field cannot act on an Esc, while
  // this one, decided here before the page, still leaves full screen (the
  // menu's F11 only runs once the page has passed on the key).
  win.webContents.on('unresponsive', startOver)

  win.webContents.on('before-input-event', (event, input) => {
    if (win.isDestroyed()) return
    if (!shouldLeaveFullScreen(input, win.isFullScreen() || html, typing)) return
    // This Esc is the way out, so the page does not also act on it (close a
    // dialog, minimize the player): one press, one thing, as in a browser.
    event.preventDefault()
    leave()
  })

  return {
    leave,
    setTyping: (value: unknown) => {
      typing = value === true
    },
  }
}
