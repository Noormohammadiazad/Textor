import type { LocaleCode, ThemePreference } from '../core/models/types'
import { LOCALE_DIRECTION } from '../i18n'

/**
 * Language and theme, cached outside the vault.
 *
 * Everything else lives encrypted, but these two are needed *before* unlock —
 * otherwise a Persian user is greeted by an English, dark lock screen every
 * time, which is a poor welcome for this app's primary audience.
 *
 * The privacy cost is deliberately tiny and stated plainly: someone with access
 * to this browser's local storage learns which language and theme the user
 * prefers. They already have the device. No key, message, contact, or identity
 * information is ever written here, and the encrypted settings record remains
 * the authority once the vault is open.
 */
const KEY = 'textor:display'

export interface DisplayPrefs {
  locale: LocaleCode
  theme: ThemePreference
}

const isLocale = (value: unknown): value is LocaleCode => value === 'en' || value === 'fa'
const isTheme = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark'

export function loadDisplayPrefs(): Partial<DisplayPrefs> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const { locale, theme } = parsed as Record<string, unknown>
    return {
      ...(isLocale(locale) ? { locale } : {}),
      ...(isTheme(theme) ? { theme } : {}),
    }
  } catch {
    // Storage can be blocked entirely (private mode, strict settings). The app
    // works fine without this cache; it just falls back to browser defaults.
    return {}
  }
}

export function saveDisplayPrefs(prefs: DisplayPrefs): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* non-fatal */
  }
}

export function clearDisplayPrefs(): void {
  try {
    globalThis.localStorage?.removeItem(KEY)
  } catch {
    /* non-fatal */
  }
}

/**
 * Push language and theme onto the document element.
 *
 * Called once from the entry point before React mounts, and again whenever the
 * preference changes. Doing it before the first paint is what removes the
 * flash of a light theme — and, more jarring for a Persian reader, the moment
 * of left-to-right layout — that a React-effect-only approach leaves behind.
 *
 * Direction and language go on <html> rather than a wrapper so the whole
 * document mirrors, including native scrollbars, select dropdowns, and the
 * text-selection handles on a phone.
 */
export function applyDisplayPrefs(prefs: Partial<DisplayPrefs>): void {
  const root = globalThis.document?.documentElement
  if (!root) return

  if (prefs.locale) {
    root.lang = prefs.locale
    root.dir = LOCALE_DIRECTION[prefs.locale]
  }

  // "system" means no attribute at all, which hands the choice back to the
  // prefers-color-scheme block in theme.css.
  if (!prefs.theme || prefs.theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', prefs.theme)

  syncThemeColor(root)
}

/**
 * Point <meta name="theme-color"> at whatever --bg now resolves to.
 *
 * This is what colours the browser's own chrome on a phone and the title bar of
 * an installed app, so leaving it at a fixed value means a light-theme user gets
 * a dark strip above their light interface. Reading the live token rather than
 * repeating a hex here means the two can never drift apart.
 */
function syncThemeColor(root: HTMLElement): void {
  const meta = globalThis.document?.querySelector('meta[name="theme-color"]')
  if (!meta) return
  const background = getComputedStyle(root).getPropertyValue('--bg').trim()
  // Empty until the stylesheet has been applied, which in dev happens after
  // this module runs. The value already in the document stays put until then.
  if (!/^(#|rgb|hsl|oklch|color\()/.test(background)) return
  meta.setAttribute('content', background)
}
