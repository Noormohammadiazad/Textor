// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { applyDisplayPrefs } from '@/app/displayPrefs'
import { nextSegmentIndex } from '@/ui/components/segmentedNav'

describe('applying display preferences to the document', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('dir')
    document.documentElement.removeAttribute('lang')
  })

  it('mirrors the document for a right-to-left locale', () => {
    applyDisplayPrefs({ locale: 'fa', theme: 'dark' })
    expect(document.documentElement.lang).toBe('fa')
    expect(document.documentElement.dir).toBe('rtl')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('restores left-to-right when switching back', () => {
    applyDisplayPrefs({ locale: 'fa', theme: 'dark' })
    applyDisplayPrefs({ locale: 'en', theme: 'light' })
    expect(document.documentElement.dir).toBe('ltr')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('removes the attribute for "system" so the media query decides', () => {
    applyDisplayPrefs({ locale: 'en', theme: 'dark' })
    applyDisplayPrefs({ locale: 'en', theme: 'system' })
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('treats a missing theme the same as "system"', () => {
    applyDisplayPrefs({ locale: 'en', theme: 'dark' })
    applyDisplayPrefs({ locale: 'en' })
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('leaves language alone when only the theme is given', () => {
    applyDisplayPrefs({ locale: 'fa', theme: 'system' })
    applyDisplayPrefs({ theme: 'dark' })
    expect(document.documentElement.lang).toBe('fa')
    expect(document.documentElement.dir).toBe('rtl')
  })
})

describe('segmented control keyboard navigation', () => {
  const COUNT = 3

  it('moves forward with the arrow that points forward in each direction', () => {
    expect(nextSegmentIndex('ArrowRight', 0, COUNT, 'ltr')).toBe(1)
    // The left arrow points at the *next* segment when the row is mirrored.
    expect(nextSegmentIndex('ArrowLeft', 0, COUNT, 'rtl')).toBe(1)
  })

  it('moves backward with the opposite arrow in each direction', () => {
    expect(nextSegmentIndex('ArrowLeft', 2, COUNT, 'ltr')).toBe(1)
    expect(nextSegmentIndex('ArrowRight', 2, COUNT, 'rtl')).toBe(1)
  })

  it('does not mirror the vertical arrows', () => {
    for (const dir of ['ltr', 'rtl'] as const) {
      expect(nextSegmentIndex('ArrowDown', 0, COUNT, dir)).toBe(1)
      expect(nextSegmentIndex('ArrowUp', 1, COUNT, dir)).toBe(0)
    }
  })

  it('wraps at both ends', () => {
    expect(nextSegmentIndex('ArrowRight', COUNT - 1, COUNT, 'ltr')).toBe(0)
    expect(nextSegmentIndex('ArrowLeft', 0, COUNT, 'ltr')).toBe(COUNT - 1)
    expect(nextSegmentIndex('ArrowLeft', COUNT - 1, COUNT, 'rtl')).toBe(0)
    expect(nextSegmentIndex('ArrowRight', 0, COUNT, 'rtl')).toBe(COUNT - 1)
  })

  it('jumps to the ends with Home and End, in both directions', () => {
    for (const dir of ['ltr', 'rtl'] as const) {
      expect(nextSegmentIndex('Home', 2, COUNT, dir)).toBe(0)
      expect(nextSegmentIndex('End', 0, COUNT, dir)).toBe(COUNT - 1)
    }
  })

  it('ignores keys it does not own, so typing still reaches the page', () => {
    for (const key of ['Tab', 'Enter', ' ', 'a', 'Escape', 'PageDown']) {
      expect(nextSegmentIndex(key, 0, COUNT, 'ltr')).toBeNull()
    }
  })

  it('handles an empty group without dividing by zero', () => {
    expect(nextSegmentIndex('ArrowRight', 0, 0, 'ltr')).toBeNull()
    expect(nextSegmentIndex('Home', 0, 0, 'ltr')).toBeNull()
  })
})

/*
 * The point of these: the entry screens change language and theme while there
 * is no vault to write to. That path must persist the choice on its own, or the
 * switch silently reverts on the next reload — the exact failure the display
 * cache exists to prevent.
 */
describe('changing display preferences before the vault is open', () => {
  it('persists without a vault, and survives a reload', async () => {
    const { useApp } = await import('@/app/store')
    const { loadDisplayPrefs } = await import('@/app/displayPrefs')

    expect(useApp.getState().phase).not.toBe('ready')

    await useApp.getState().setDisplayPreference({ locale: 'fa' })
    expect(useApp.getState().settings.locale).toBe('fa')

    await useApp.getState().setDisplayPreference({ theme: 'light' })
    expect(useApp.getState().settings.theme).toBe('light')

    // Both halves are in the cache, not just the one written last.
    expect(loadDisplayPrefs()).toEqual({ locale: 'fa', theme: 'light' })
  })

  it('leaves the rest of the settings untouched', async () => {
    const { useApp } = await import('@/app/store')
    const before = useApp.getState().settings

    await useApp.getState().setDisplayPreference({ theme: 'dark' })

    const after = useApp.getState().settings
    expect(after.theme).toBe('dark')
    expect(after.autoLockMinutes).toBe(before.autoLockMinutes)
    expect(after.lockOnHide).toBe(before.lockOnHide)
    expect(after.sendReadReceipts).toBe(before.sendReadReceipts)
    expect(after.retention).toEqual(before.retention)
    expect(after.iceServers).toEqual(before.iceServers)
  })
})

describe('carrying an entry-screen choice into the vault', () => {
  it('remembers the change as pending until a session starts', async () => {
    const { useApp } = await import('@/app/store')

    // Whatever earlier tests left behind, a fresh explicit change is pending.
    await useApp.getState().setDisplayPreference({ locale: 'fa', theme: 'dark' })
    expect(useApp.getState().pendingDisplayPrefs).toEqual({ locale: 'fa', theme: 'dark' })
  })

  it('accumulates changes instead of replacing them', async () => {
    const { useApp } = await import('@/app/store')

    await useApp.getState().setDisplayPreference({ locale: 'en' })
    await useApp.getState().setDisplayPreference({ theme: 'light' })

    // Both halves survive; the second change must not drop the first, or
    // picking a language and then a theme would silently discard the language.
    expect(useApp.getState().pendingDisplayPrefs).toEqual({ locale: 'en', theme: 'light' })
  })
})

describe('browser chrome colour', () => {
  it('follows the resolved theme rather than a fixed value', () => {
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('content', '#ffffff')
    document.head.append(meta)

    // happy-dom resolves custom properties from real declarations, so give it
    // the two the app actually switches between.
    const style = document.createElement('style')
    style.textContent = ':root{--bg:#f4f6f8}:root[data-theme="dark"]{--bg:#0e1116}'
    document.head.append(style)

    applyDisplayPrefs({ locale: 'en', theme: 'dark' })
    expect(meta.getAttribute('content')).toBe('#0e1116')

    applyDisplayPrefs({ locale: 'en', theme: 'light' })
    expect(meta.getAttribute('content')).toBe('#f4f6f8')

    meta.remove()
    style.remove()
  })

  it('leaves the markup value alone when no stylesheet has applied yet', () => {
    // The entry point runs before the dev server injects CSS; a garbage value
    // here would paint the browser chrome black on first load.
    const meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('content', '#f4f6f8')
    document.head.append(meta)

    applyDisplayPrefs({ locale: 'en', theme: 'dark' })
    expect(meta.getAttribute('content')).toBe('#f4f6f8')

    meta.remove()
  })
})
