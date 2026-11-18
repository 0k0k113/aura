// app/titleBar.ts
//
// The window's buttons inside the site's own top bar (1.0.13).
//
// Why this file exists
// --------------------
// Aura's window had the system's title bar on top of the site: on Windows a
// separate strip (dark since 1.0.8) above the site's own top bar, with the
// minimize, maximize and close buttons in it, and the full player's capsule
// just under them. A member (2026-11-18): "is there no way of you getting rid
// of that and make the minimize fullscreen or cross can be implimented in the
// bar you have like how spotify has it"; the owner: "might as well do for mac
// & not only windows as well".
//
// So on Windows and on a Mac the site is drawn to the top edge of the window,
// and the system draws only its buttons, over the top corner of the page:
//
//   Windows  Electron's window-controls overlay (titleBarStyle 'hidden' plus
//            titleBarOverlay): minimize, maximize (with Windows 11's snap
//            layouts on hover) and close at the top right, TITLE_BAR_HEIGHT
//            tall, on a see-through background, their symbols in the site's
//            colour (white on the dark theme, ink on the light one; the page
//            says which, setTheme). Dragging the site's top band moves the
//            window, and a double-click on it maximizes, as on a title bar.
//   Mac      the traffic lights at the top left (titleBarStyle 'hidden'),
//            vertically centred on the same band (trafficLightPosition). In
//            full screen macOS hides them, and the site drops their space.
//   Linux    the normal frame, unchanged.
//
// The page learns where the buttons are, how much room they take and when
// that changes from the overlay itself (navigator.windowControlsOverlay,
// which titleBarOverlay switches on), through the preload's window.unrlWindow
// (getTitleBar / onTitleBarChange), and it tells this side its colours
// (setTitleBarTheme). Nothing else about the window is exposed.
//
// Failing safe
// ------------
// Without the site's help a page under the overlay cannot be dragged at all,
// and its own buttons can sit under the window's. So the overlay is used only
// for a site that has said it is ready for it:
//
//  * The site says so by calling setTitleBarTheme with the protocol it speaks
//    (TITLE_BAR_PROTOCOL). Older sites never call it.
//  * The answer is remembered (MEMORY_FILE in userData). A window is made with
//    the overlay only when the last word was "ready"; otherwise, and always on
//    a first start, it gets exactly the frame it has today. A framed window
//    whose site says ready gets the overlay from the next start.
//  * A window with the overlay whose page has not said ready within
//    READY_GRACE_MS of loading (an older site came back, or a page that is
//    not the site at all) gets an opaque, draggable band over the top of the
//    page (EMERGENCY_CSS): it can be moved, and nothing of it sits under the
//    buttons. When the page was the site, the frame is back from the next
//    start. A page that failed to load (offline) gets the band but changes
//    nothing remembered.

/** main → page: the window was maximized, restored, or entered or left full screen. */
export const TITLE_BAR_CHANGED = 'window:title-bar-changed'
/** page → main: the site's colours under the buttons ('dark' | 'light'), with the protocol it speaks. */
export const TITLE_BAR_THEME = 'window:title-bar-theme'
/** How the window's mode reaches the sandboxed preload (it cannot import this file). */
export const TITLE_BAR_ARGV_PREFIX = '--unrl-title-bar='
/** The contract with the site: bump when what the page must do under the overlay changes. */
export const TITLE_BAR_PROTOCOL = 1
/** The file in userData that remembers whether the site said it is ready. */
export const MEMORY_FILE = 'title-bar.json'

/**
 * The buttons' band, in window pixels: the site's own top band, 80px on every
 * page (the row above its menu, and the full player's controls band: 12px of
 * air, a 56px capsule, 12px of air), so the buttons sit on the same row as the
 * capsule and are vertically centred with it.
 */
export const TITLE_BAR_HEIGHT = 80
/** A macOS window button's frame height (the 12px light sits in a 14x16 frame). */
export const TRAFFIC_LIGHT_FRAME_HEIGHT = 16
/** The first light's distance from the window's left edge. */
export const TRAFFIC_LIGHT_X = 24
/** How long a loaded page has to say it is ready before the safe band goes over it. */
export const READY_GRACE_MS = 10_000

export type TitleBarMode = 'overlay' | 'frame'
export type TitleBarTheme = 'dark' | 'light'

/** What MEMORY_FILE holds. */
export interface TitleBarMemory {
  siteReady: boolean
  protocol: number
  /** The colours the site last asked for: the next window starts with them (no white symbols on a light page). */
  theme?: TitleBarTheme
  at?: string
}

/**
 * How far below its frame's centre macOS draws the lights' circles, in points. Measured on the owner's Mac
 * (2026-11-18, 1.0.13 test build): with the frame centred (y 32) the circles' centre sat 3 pt under the full
 * player's capsule, which is centred on the band at 40 ("the new native buttons ... are a bit too low").
 */
export const TRAFFIC_LIGHT_OPTICAL_OFFSET = 3

/** The traffic lights' position: their circles (not just their frames) vertically centred on the band. */
export const TRAFFIC_LIGHT_POSITION = Object.freeze({
  x: TRAFFIC_LIGHT_X,
  y: Math.round((TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_FRAME_HEIGHT) / 2) - TRAFFIC_LIGHT_OPTICAL_OFFSET,
})

/**
 * The buttons' colours, by the site's theme. The background is see-through,
 * so the site's own top band shows behind the buttons; it is the theme's own
 * colour with no alpha, so a Windows that cannot draw it see-through draws the
 * theme's background instead. The symbols are the site's text colours (the
 * light theme's ink is styles/theme-light.css's --ink, rgb(23 20 29)).
 */
const OVERLAY_COLORS: Record<TitleBarTheme, { color: string; symbolColor: string }> = {
  dark: { color: '#00000000', symbolColor: '#ffffff' },
  light: { color: '#ffffff00', symbolColor: '#17141d' },
}

export function isTitleBarTheme(value: unknown): value is TitleBarTheme {
  return value === 'dark' || value === 'light'
}

/** The overlay's colours and height for a theme (setTitleBarOverlay and the constructor take the same). */
export function overlayStyle(theme: TitleBarTheme): { color: string; symbolColor: string; height: number } {
  return { ...OVERLAY_COLORS[theme], height: TITLE_BAR_HEIGHT }
}

/**
 * The window's colour while the page loads: the site's light page (#efeef6,
 * styles/theme-light.css) for a light-theme window with the overlay, whose
 * buttons start in ink and would otherwise sit invisible on black until the
 * page paints; black, as always, for everything else.
 */
export function windowBackground(mode: TitleBarMode, theme: TitleBarTheme | undefined): string {
  return mode === 'overlay' && theme === 'light' ? '#efeef6' : '#000000'
}

/** The platforms that draw only their buttons over the site: Windows and macOS. */
export function overlayPlatform(platform: string): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/** Overlay only on those platforms, and only when the site's last word was "ready" in this protocol. */
export function titleBarModeFor(platform: string, memory: TitleBarMemory | null): TitleBarMode {
  if (!overlayPlatform(platform)) return 'frame'
  if (!memory || memory.siteReady !== true || memory.protocol !== TITLE_BAR_PROTOCOL) return 'frame'
  return 'overlay'
}

/**
 * What the mode adds to the BrowserWindow's options. The frame is nothing:
 * exactly the window as it was before this file existed.
 */
export function titleBarWindowOptions(
  platform: string,
  mode: TitleBarMode,
  theme: TitleBarTheme = 'dark',
): {
  titleBarStyle?: 'hidden'
  titleBarOverlay?: { color?: string; symbolColor?: string; height: number }
  trafficLightPosition?: { x: number; y: number }
} {
  if (mode !== 'overlay' || !overlayPlatform(platform)) return {}
  if (platform === 'darwin') {
    // titleBarOverlay switches on the overlay's geometry for the page (where the
    // lights are, how wide); its colours are Windows' only.
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
      titleBarOverlay: { height: TITLE_BAR_HEIGHT },
    }
  }
  // The first colours are the ones the site last asked for (the dark theme's,
  // the site's default, when it never said), until the page says otherwise.
  return { titleBarStyle: 'hidden', titleBarOverlay: overlayStyle(isTitleBarTheme(theme) ? theme : 'dark') }
}

/** MEMORY_FILE's text, or null for anything else (missing, cut short, another shape). */
export function parseTitleBarMemory(text: string | null | undefined): TitleBarMemory | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<TitleBarMemory> | null
    if (!value || typeof value !== 'object') return null
    if (typeof value.siteReady !== 'boolean' || typeof value.protocol !== 'number') return null
    return {
      siteReady: value.siteReady,
      protocol: value.protocol,
      theme: isTitleBarTheme(value.theme) ? value.theme : undefined,
      at: typeof value.at === 'string' ? value.at : undefined,
    }
  } catch {
    return null
  }
}

/** The parts of `fs` the memory uses (tests pass a fake). */
export interface MemoryFs {
  readFileSync(file: string, encoding: 'utf8'): string
  writeFileSync(file: string, data: string): void
}

/** The remembered answer; null when there is none or it cannot be read (both mean: the frame). */
export function readTitleBarMemory(file: string, fsImpl: MemoryFs): TitleBarMemory | null {
  try {
    return parseTitleBarMemory(fsImpl.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Remembers the answer. A write that fails is only a missed promotion or demotion, never a broken window. */
export function writeTitleBarMemory(
  file: string,
  siteReady: boolean,
  theme: TitleBarTheme,
  fsImpl: MemoryFs,
  now: Date = new Date(),
): boolean {
  try {
    const memory: TitleBarMemory = { siteReady, protocol: TITLE_BAR_PROTOCOL, theme, at: now.toISOString() }
    fsImpl.writeFileSync(file, JSON.stringify(memory))
    return true
  } catch {
    return false
  }
}

/**
 * The safe band for a page under the overlay that never said it is ready: an
 * opaque, draggable bar over the top of the page, as tall as the buttons, and
 * the page's own flow started under it. Last in the page (body::after), so it
 * stays draggable over whatever the page put there. A fixed string: nothing
 * from the page goes into it.
 */
export const EMERGENCY_CSS =
  `body::after{content:"";position:fixed;top:0;left:0;right:0;height:${TITLE_BAR_HEIGHT}px;` +
  'background:#000;-webkit-app-region:drag;app-region:drag;z-index:2147483647;pointer-events:none}' +
  `html{padding-top:${TITLE_BAR_HEIGHT}px!important;box-sizing:border-box}`

/** The parts of a BrowserWindow this uses (tests/titleBar.test.js drives a fake one). */
export interface TitleBarWindow {
  isDestroyed(): boolean
  isMaximized(): boolean
  isFullScreen(): boolean
  setTitleBarOverlay?(options: { color?: string; symbolColor?: string; height?: number }): void
  on(event: 'maximize' | 'unmaximize' | 'restore' | 'enter-full-screen' | 'leave-full-screen', listener: () => void): unknown
  webContents: {
    isDestroyed(): boolean
    getURL(): string
    send(channel: string, ...args: unknown[]): void
    insertCSS(css: string): Promise<string>
    removeInsertedCSS(key: string): Promise<void>
    on(event: 'did-navigate', listener: (...args: unknown[]) => void): unknown
    on(event: 'did-finish-load', listener: () => void): unknown
    on(event: 'did-fail-load', listener: (...args: unknown[]) => void): unknown
  }
}

export interface TitleBarOptions {
  platform: string
  mode: TitleBarMode
  /** Whether a URL is the site's (app/origins.ts). */
  isSiteUrl(url: string): boolean
  /** Remember the site's word (true: ready) and its colours for the next start. Called only when either changes. */
  remember(siteReady: boolean, theme: TitleBarTheme): void
  /** The memory as this start found it (null: nothing). */
  remembered: TitleBarMemory | null
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface TitleBar {
  readonly mode: TitleBarMode
  /** The page's colours, and its word that it is ready. False (and nothing changed) for anything malformed. */
  setTheme(theme: unknown, protocol: unknown): boolean
  /** Whether the page showing now has said it is ready. */
  isReady(): boolean
}

/** Wires one window: the page's readiness, the safe band, the colours and the window's changes to the page. */
export function attachTitleBar(win: TitleBarWindow, options: TitleBarOptions): TitleBar {
  const { platform, mode } = options
  const overlay = mode === 'overlay' && overlayPlatform(platform)
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const known = options.remembered && options.remembered.protocol === TITLE_BAR_PROTOCOL ? options.remembered : null
  let lastWord: boolean | null = known ? known.siteReady : null
  let lastTheme: TitleBarTheme | null = known && known.theme ? known.theme : null
  let ready = false
  // What the window was made with (titleBarWindowOptions): the remembered colours, or the dark theme's.
  let theme: TitleBarTheme = lastTheme ?? 'dark'
  let timer: unknown = null
  let band: Promise<string | null> | null = null

  const alive = () => !win.isDestroyed() && !win.webContents.isDestroyed()

  const remember = (siteReady: boolean) => {
    if (lastWord === siteReady && lastTheme === theme) return
    lastWord = siteReady
    lastTheme = theme
    try {
      options.remember(siteReady, theme)
    } catch {
      // A missed promotion or demotion; the window itself is fine.
    }
  }

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  const removeBand = () => {
    const pending = band
    band = null
    if (!pending) return
    void pending
      .then((key) => (key && alive() ? win.webContents.removeInsertedCSS(key) : undefined))
      .catch(() => {})
  }

  /** The page did not say it is ready: make it movable and keep it from under the buttons. */
  const coverTop = (wasSite: boolean) => {
    if (!alive() || ready) return
    if (!band) {
      band = win.webContents.insertCSS(EMERGENCY_CSS).then(
        (key) => key,
        () => null,
      )
    }
    if (wasSite) remember(false)
  }

  const armTimer = (failed: boolean) => {
    if (!overlay || ready) return
    stopTimer()
    if (failed) {
      // An error page: no site to wait for, and nothing to learn about it.
      coverTop(false)
      return
    }
    const url = alive() ? win.webContents.getURL() : ''
    timer = setTimer(() => {
      timer = null
      coverTop(options.isSiteUrl(url))
    }, READY_GRACE_MS)
  }

  if (overlay) {
    const changed = () => {
      if (!alive()) return
      win.webContents.send(TITLE_BAR_CHANGED, { maximized: win.isMaximized(), fullScreen: win.isFullScreen() })
    }
    for (const event of ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen'] as const) win.on(event, changed)
  }

  // A new document has to say it again; the band (inserted CSS) went with the old one.
  win.webContents.on('did-navigate', () => {
    ready = false
    band = null
    stopTimer()
  })
  win.webContents.on('did-finish-load', () => armTimer(false))
  win.webContents.on('did-fail-load', (...args: unknown[]) => {
    // (event, errorCode, errorDescription, validatedURL, isMainFrame): -3 is a load
    // replaced by another (not a failure), and only the main frame counts.
    const code = args[1]
    const isMainFrame = args[4]
    if (isMainFrame === false || code === -3) return
    armTimer(true)
  })

  const apply = () => {
    if (!overlay || platform !== 'win32' || !alive() || typeof win.setTitleBarOverlay !== 'function') return
    try {
      win.setTitleBarOverlay(overlayStyle(theme))
    } catch {
      // The buttons keep their last colours.
    }
  }

  return {
    mode: overlay ? 'overlay' : 'frame',
    isReady: () => ready,
    setTheme(value: unknown, protocol: unknown): boolean {
      if (!isTitleBarTheme(value) || protocol !== TITLE_BAR_PROTOCOL || !alive()) return false
      const wasReady = ready
      const changed = value !== theme
      ready = true
      theme = value
      stopTimer()
      removeBand()
      remember(true)
      if (!wasReady || changed) apply()
      return true
    },
  }
}
